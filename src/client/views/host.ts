import {
  h,
  labeled,
  renderErrors,
  renderTranscript,
  type Actions,
  type AppState,
  type View,
} from "../ui.ts";
import type { CharacterInit } from "../../shared/types.ts";

type CharacterInitLike = CharacterInit;

const EXAMPLE_SETTING =
  "A dusty frontier saloon at high noon. The batwing doors creak as tensions simmer.";

const EXAMPLE_CHARACTERS: CharacterInit[] = [
  {
    name: "Sheriff Cole",
    persona: "A weathered frontier sheriff. Calm and gravelly, speaks in short clipped lines.",
    voice: "onyx",
    aliases: ["Cole", "Sheriff"],
    secret: "Suspects the bank robbery was an inside job.",
  },
  {
    name: "Maple",
    persona: "A sharp-tongued saloon pianist who overhears everything. Witty and warm.",
    voice: "sage",
    aliases: ["Mae"],
    secret: "Is quietly protecting her younger brother.",
  },
  {
    name: "Bartender Sam",
    persona: "A jittery bartender trying to keep the peace. Eager to please, talks fast.",
    voice: "ash",
    aliases: ["Sam", "barkeep"],
  },
];

interface RowRefs {
  name: HTMLInputElement;
  persona: HTMLTextAreaElement;
  voice: HTMLSelectElement;
  aliases: HTMLInputElement;
  secret: HTMLInputElement;
}

interface CharCtrl {
  row: HTMLElement;
  dot: HTMLElement;
  status: HTMLElement;
  micBtn: HTMLButtonElement;
  sayInput: HTMLInputElement;
}

export function createHostView(actions: Actions): View {
  let currentVoices: string[] = [];
  const rowRefs = new WeakMap<HTMLElement, RowRefs>();

  // ---- Setup form (persistent DOM; drafts survive re-renders) -------------
  const settingInput = h("textarea", {
    class: "input",
    rows: "2",
    placeholder: "Scene setting, e.g. A tense negotiation aboard a derelict starship",
  }) as HTMLTextAreaElement;
  const rowsContainer = h("div", { class: "char-rows" });

  function makeRow(init?: Partial<CharacterInitLike>): HTMLElement {
    const name = h("input", { class: "input", placeholder: "Name", value: init?.name ?? "" }) as HTMLInputElement;
    const persona = h("textarea", { class: "input", rows: "2", placeholder: "Persona" }) as HTMLTextAreaElement;
    if (init?.persona) persona.value = init.persona;
    const voice = h("select", { class: "input" }) as HTMLSelectElement;
    for (const v of currentVoices) {
      voice.appendChild(h("option", { value: v, selected: (init?.voice ?? "alloy") === v }, v));
    }
    const aliases = h("input", {
      class: "input",
      placeholder: "Aliases (comma separated)",
      value: (init?.aliases ?? []).join(", "),
    }) as HTMLInputElement;
    const secret = h("input", { class: "input", placeholder: "Secret (optional)", value: init?.secret ?? "" }) as HTMLInputElement;
    const remove = h("button", { class: "btn small danger", onClick: () => row.remove() }, "Remove");

    const row = h(
      "div",
      { class: "char-row" },
      h("div", { class: "grid2" }, labeled("Name", name), labeled("Voice", voice)),
      labeled("Persona", persona),
      h("div", { class: "grid2" }, labeled("Aliases", aliases), labeled("Secret", secret)),
      h("div", { class: "row end" }, remove),
    );
    rowRefs.set(row, { name, persona, voice, aliases, secret });
    return row;
  }

  function addRow(init?: Partial<CharacterInitLike>): void {
    rowsContainer.appendChild(makeRow(init));
  }

  function submitScene(): void {
    const chars: CharacterInit[] = [];
    for (const row of Array.from(rowsContainer.children)) {
      const r = rowRefs.get(row as HTMLElement);
      if (!r) continue;
      const name = r.name.value.trim();
      if (!name) continue;
      chars.push({
        name,
        persona: r.persona.value.trim(),
        voice: r.voice.value,
        aliases: r.aliases.value.split(",").map((s) => s.trim()).filter(Boolean),
        secret: r.secret.value.trim() || undefined,
      });
    }
    actions.createScene(settingInput.value.trim(), chars);
  }

  function loadExample(submit: boolean): void {
    settingInput.value = EXAMPLE_SETTING;
    while (rowsContainer.firstChild) rowsContainer.removeChild(rowsContainer.firstChild);
    for (const c of EXAMPLE_CHARACTERS) addRow(c);
    if (submit) submitScene();
  }

  const exampleBtn = h(
    "button",
    { class: "btn small", onClick: () => loadExample(true) },
    "Load example",
  );
  const addRowBtn = h("button", { class: "btn small", onClick: () => addRow() }, "+ Add character");
  const createBtn = h("button", { class: "btn primary", onClick: () => submitScene() }, "Create / Update scene");

  // ---- Dashboard (persistent DOM) ----------------------------------------
  const phaseBadge = h("span", { class: "badge" }, "idle");
  const startBtn = h("button", { class: "btn primary", onClick: () => actions.start() }, "Start") as HTMLButtonElement;
  const stopBtn = h("button", { class: "btn", onClick: () => actions.stop() }, "Stop") as HTMLButtonElement;
  const resetBtn = h("button", { class: "btn", onClick: () => actions.reset() }, "Reset");
  const chainBadge = h("span", { class: "badge muted" }, "");

  const humanInput = h("input", { class: "input", placeholder: "Speak as the human…" }) as HTMLInputElement;
  const sendHuman = () => {
    const t = humanInput.value.trim();
    if (t) {
      actions.humanText(t);
      humanInput.value = "";
    }
  };
  humanInput.addEventListener("keydown", (e) => {
    if ((e as KeyboardEvent).key === "Enter") sendHuman();
  });
  const humanBtn = h("button", { class: "btn", onClick: sendHuman }, "Send");

  const charControls = h("div", { class: "char-controls" });
  const transcriptEl = h("div", { class: "transcript" });
  const errorsEl = h("div", { class: "errors" });

  const el = h(
    "div",
    { class: "view host-view" },
    h(
      "div",
      { class: "card" },
      h("h2", null, "Scene setup"),
      labeled("Setting", settingInput),
      rowsContainer,
      h("div", { class: "row" }, exampleBtn, addRowBtn, createBtn),
    ),
    h(
      "div",
      { class: "card" },
      h("div", { class: "row space" }, h("h2", null, "Dashboard"), h("div", { class: "row" }, chainBadge, phaseBadge)),
      h("div", { class: "row" }, startBtn, stopBtn, resetBtn),
      h("div", { class: "row" }, humanInput, humanBtn),
      h("h3", null, "Characters"),
      charControls,
    ),
    h("div", { class: "card" }, h("h3", null, "Transcript"), transcriptEl),
    h("div", { class: "card" }, h("h3", null, "Provider errors"), errorsEl),
  );

  // ---- Per-character control cache ---------------------------------------
  const ctrlCache = new Map<string, CharCtrl>();

  function makeCtrl(charId: string): CharCtrl {
    const dot = h("span", { class: "dot" });
    const name = h("span", { class: "cc-name" });
    const status = h("span", { class: "cc-status muted" });
    const micBtn = h(
      "button",
      { class: "btn small", onClick: () => onSetMic(charId) },
      "Set mic here",
    ) as HTMLButtonElement;
    const sayInput = h("input", { class: "input", placeholder: "Make them say…" }) as HTMLInputElement;
    const say = () => {
      const t = sayInput.value.trim();
      if (t) {
        actions.injectLine(charId, t);
        sayInput.value = "";
      }
    };
    sayInput.addEventListener("keydown", (e) => {
      if ((e as KeyboardEvent).key === "Enter") say();
    });
    const sayBtn = h("button", { class: "btn small", onClick: say }, "Say");

    const row = h(
      "div",
      { class: "cc-row" },
      h("div", { class: "cc-head" }, dot, name, status),
      h("div", { class: "row" }, micBtn, sayInput, sayBtn),
    );
    (name as HTMLElement).dataset.for = charId;
    return { row, dot, status, micBtn, sayInput };
  }

  function onSetMic(charId: string): void {
    const ch = currentScene?.characters.find((c) => c.id === charId);
    if (ch?.claimedBy) actions.setActiveMic(ch.claimedBy);
  }

  let currentScene: AppState["scene"] = null;
  let seeded = false;

  function renderCharControls(state: AppState): void {
    const scene = state.scene;
    const ids = new Set(scene?.characters.map((c) => c.id) ?? []);
    for (const [id, ctrl] of ctrlCache) {
      if (!ids.has(id)) {
        ctrl.row.remove();
        ctrlCache.delete(id);
      }
    }
    if (!scene) return;
    for (const c of scene.characters) {
      let ctrl = ctrlCache.get(c.id);
      if (!ctrl) {
        ctrl = makeCtrl(c.id);
        ctrlCache.set(c.id, ctrl);
        charControls.appendChild(ctrl.row);
      }
      const nameEl = ctrl.row.querySelector(".cc-name") as HTMLElement;
      nameEl.textContent = c.name;
      const connected = c.connected;
      const isMic = !!c.claimedBy && scene.activeMicClientId === c.claimedBy;
      const speaking = scene.currentSpeaker === c.id && scene.phase === "speaking";
      ctrl.dot.className =
        "dot " + (speaking ? "speaking" : isMic ? "listening" : connected ? "connected" : "off");
      const bits: string[] = [];
      bits.push(connected ? `played by ${c.claimedByLabel ?? "player"}` : "not connected");
      if (isMic) bits.push("ACTIVE MIC");
      if (speaking) bits.push("speaking");
      ctrl.status.textContent = bits.join(" · ");
      ctrl.micBtn.disabled = !connected || !scene.running;
    }
  }

  function update(state: AppState): void {
    currentVoices = state.voices;
    currentScene = state.scene;
    if (!seeded) {
      seeded = true;
      if (rowsContainer.children.length === 0) {
        addRow();
        addRow();
      }
    }
    const scene = state.scene;
    phaseBadge.textContent = scene ? scene.phase : "idle";
    phaseBadge.className = "badge " + (scene?.phase ?? "idle");
    chainBadge.textContent = scene && scene.running ? `NPC turns: ${scene.npcChainCount}` : "";
    startBtn.disabled = !scene || scene.characters.length === 0 || !!scene.running;
    stopBtn.disabled = !scene?.running;

    renderCharControls(state);
    renderTranscript(transcriptEl, state);
    renderErrors(errorsEl, state);
  }

  return { el, update };
}
