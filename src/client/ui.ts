import type {
  AudioConfig,
  CharacterInit,
  Role,
  SceneState,
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
  setActiveMic(clientId: string): void;
  humanText(text: string): void;
  injectLine(characterId: string, text: string): void;
  joinAudio(): void;
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
    container.appendChild(
      h(
        "div",
        { class: line.speaker === "human" ? "line human" : "line npc" },
        h("span", { class: "who" }, `${line.name}: `),
        h("span", { class: "what" }, line.text),
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
