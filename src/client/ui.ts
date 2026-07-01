import type {
  AudioConfig,
  CharacterInit,
  HumanFloorMode,
  Role,
  SceneState,
  TurnChannel,
} from "../shared/types.ts";

// ---------------------------------------------------------------------------
// Minimal hyperscript helper
// ---------------------------------------------------------------------------

type Child = Node | string | number | null | undefined | false | Child[];
type Attrs = Record<string, unknown>;

export function h(tag: string, attrs?: Attrs | null, ...children: Child[]): HTMLElement {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === "class" || k === "className") {
        el.className = String(v);
      } else if (k === "style" && typeof v === "object") {
        Object.assign(el.style, v as Record<string, string>);
      } else if (k === "dataset" && typeof v === "object") {
        Object.assign(el.dataset, v as Record<string, string>);
      } else if (k.startsWith("on") && typeof v === "function") {
        el.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
      } else if (k === "value") {
        (el as HTMLInputElement).value = String(v);
      } else if (k === "disabled" || k === "checked" || k === "selected") {
        (el as unknown as Record<string, unknown>)[k] = Boolean(v);
      } else {
        el.setAttribute(k, String(v));
      }
    }
  }
  appendChildren(el, children);
  return el;
}

function appendChildren(el: HTMLElement, children: Child[]): void {
  for (const c of children) {
    if (c == null || c === false) continue;
    if (Array.isArray(c)) appendChildren(el, c);
    else if (c instanceof Node) el.appendChild(c);
    else el.appendChild(document.createTextNode(String(c)));
  }
}

export function clear(el: HTMLElement): void {
  while (el.firstChild) el.removeChild(el.firstChild);
}

// ---------------------------------------------------------------------------
// Icons + avatars (ported from roleplay-director)
// ---------------------------------------------------------------------------

/**
 * Renders an SVG asset from /assets as a square, monochrome icon that inherits
 * the current text color. The SVG is used as a CSS mask over a `currentColor`
 * block, so the icon always matches the color of the text it sits next to.
 */
export function icon(name: string, size = 20): HTMLElement {
  const mask = `url(/assets/${name}.svg) center / contain no-repeat`;
  return h("span", {
    class: "icon",
    "aria-hidden": "true",
    style: { width: `${size}px`, height: `${size}px`, webkitMask: mask, mask },
  });
}

/** Up-to-two-letter initials for an avatar (first + last word). */
export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const first = parts[0];
  if (!first) return "?";
  if (parts.length === 1) return first.slice(0, 2).toUpperCase();
  const last = parts[parts.length - 1] ?? first;
  return ((first[0] ?? "") + (last[0] ?? "")).toUpperCase();
}

// ---------------------------------------------------------------------------
// Shared app state + action callbacks
// ---------------------------------------------------------------------------

export interface TranscriptLine {
  speaker: string;
  name: string;
  text: string;
  channel?: TurnChannel;
}

export interface AppState {
  clientId: string;
  role: Role;
  characterId: string | null;
  scene: SceneState | null;
  audio: AudioConfig;
  voices: string[];
  label: string;
  audioJoined: boolean;
  isActiveMic: boolean;
  micLevel: number;
  receivingAudio: boolean;
  transcript: TranscriptLine[];
  livePartials: Map<string, TranscriptLine>;
  errors: string[];
}

export interface Actions {
  becomeHost(): void;
  enterLobby(): void;
  setLabel(label: string): void;
  createScene(setting: string, characters: CharacterInit[]): void;
  claim(characterId: string): void;
  release(): void;
  start(): void;
  stop(): void;
  reset(): void;
  humanText(text: string): void;
  injectLine(characterId: string, text: string): void;
  joinAudio(): void;
  setFloor(mode: HumanFloorMode, action?: string): void;
}

export interface View {
  el: HTMLElement;
  update(state: AppState): void;
  updateMeter?(level: number): void;
}

export function labeled(label: string, control: HTMLElement): HTMLElement {
  return h("label", { class: "field" }, h("span", { class: "field-label" }, label), control);
}

export function renderTranscript(container: HTMLElement, state: AppState): void {
  const atBottom =
    container.scrollTop + container.clientHeight >= container.scrollHeight - 40;
  clear(container);
  for (const line of state.transcript) {
    if (line.channel === "to_device" || line.channel === "query_for_device") {
      // Private aside the human spoke TO their device — italic, dimmed, labeled.
      // Either the ASK aside or the via-device query; never seen by characters.
      const label = line.channel === "query_for_device" ? "[Query for H4] " : "[to device] ";
      container.appendChild(
        h(
          "div",
          { class: "line aside" },
          h("span", { class: "who" }, label),
          h("span", { class: "what" }, `${line.name}: “${line.text}”`),
        ),
      );
      continue;
    }
    const base = line.speaker === "human" ? "line human" : "line npc";
    // "via_device" is the device's spoken reply relayed on the person's behalf.
    container.appendChild(
      h(
        "div",
        { class: line.channel === "via_device" ? `${base} via-device` : base },
        h("span", { class: "who" }, `${line.name}: `),
        h("span", { class: "what" }, line.text),
        line.channel === "via_device" ? h("span", { class: "chan-tag" }, " H4 response") : null,
      ),
    );
  }
  for (const line of state.livePartials.values()) {
    container.appendChild(
      h(
        "div",
        { class: "line partial" },
        h("span", { class: "who" }, `${line.name}: `),
        h("span", { class: "what" }, line.text),
      ),
    );
  }
  if (atBottom) container.scrollTop = container.scrollHeight;
}

export function renderErrors(container: HTMLElement, state: AppState): void {
  clear(container);
  if (state.errors.length === 0) {
    container.appendChild(h("p", { class: "muted" }, "No errors."));
    return;
  }
  for (const e of state.errors.slice(-8).reverse()) {
    container.appendChild(h("div", { class: "error-line" }, e));
  }
}

/**
 * Web fallback for the H4 gesture remote: a banner + two press-and-hold buttons
 * that flip the session floor mode (the real H4 drives the same thing over the
 * LAN). Press-and-hold mirrors H4 hold semantics — the mode is active only while
 * held. Keyboard A / T are wired once in main.ts.
 */
export function createFloorWidget(actions: Actions): { el: HTMLElement; update(state: AppState): void } {
  const status = h("span", { class: "badge" }, "direct");
  const banner = h("div", { class: "floor-banner", style: { display: "none" } });

  function hold(label: string, title: string, mode: HumanFloorMode, action: string): HTMLButtonElement {
    let held = false;
    const btn = h("button", { class: "btn small", title }, label) as HTMLButtonElement;
    const start = (e: Event) => {
      e.preventDefault();
      if (held) return;
      held = true;
      actions.setFloor(mode, action);
    };
    const end = () => {
      if (!held) return;
      held = false;
      actions.setFloor("direct");
    };
    btn.addEventListener("pointerdown", start);
    btn.addEventListener("pointerup", end);
    btn.addEventListener("pointerleave", end);
    btn.addEventListener("pointercancel", end);
    return btn;
  }

  const askBtn = hold(
    "Hold · Talk to device",
    "Ask / Vision — characters pause; your words are logged as a private aside (key: A)",
    "device_directed",
    "ASK",
  );
  const transBtn = hold(
    "Hold · Speak via device",
    "Via device — speak your query (private), then the device replies aloud; characters respond to the device's reply when you release (key: T)",
    "device_mediated",
    "TRANSLATION",
  );

  const el = h(
    "div",
    { class: "card floor-widget" },
    banner,
    h(
      "div",
      { class: "row space" },
      h("span", { class: "field-label" }, "H4 floor (test remote)"),
      status,
    ),
    h("div", { class: "row" }, askBtn, transBtn),
  );

  function update(state: AppState): void {
    const mode = state.scene?.floorMode ?? "direct";
    const action = state.scene?.floorAction;
    const source = state.scene?.floorSource;
    status.textContent = mode;
    status.className = "badge " + (mode === "direct" ? "" : "listening");
    askBtn.classList.toggle("active", mode === "device_directed");
    transBtn.classList.toggle("active", mode === "device_mediated");
    if (mode === "direct") {
      banner.style.display = "none";
      banner.textContent = "";
    } else {
      const by = source === "h4" ? " · via H4" : source === "web" ? " · web remote" : "";
      banner.style.display = "";
      banner.className = "floor-banner " + mode;
      banner.textContent =
        (mode === "device_directed"
          ? "Human is talking to the device — characters paused."
          : "Speaking via the device — the query stays private; the device's reply goes to the characters when you release.") +
        (action ? ` (${action})` : "") +
        by;
    }
  }

  return { el, update };
}
