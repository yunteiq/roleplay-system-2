import {
  h,
  initials,
  renderErrors,
  renderTranscript,
  type Actions,
  type AppState,
  type View,
} from "../ui.ts";
import type { CharacterInit } from "../../shared/types.ts";
import { openCreateScene } from "./create-scene.ts";

interface CharCtrl {
  card: HTMLElement;
  avatar: HTMLElement;
  name: HTMLElement;
  dot: HTMLElement;
  status: HTMLElement;
  micBtn: HTMLButtonElement;
  sayInput: HTMLInputElement;
}

export function createHostView(actions: Actions): View {
  let currentVoices: string[] = [];
  let currentScene: AppState["scene"] = null;

  function editScene(): void {
    const scene = currentScene;
    const initialCast: CharacterInit[] = (scene?.characters ?? []).map((c) => ({
      name: c.name,
      persona: c.persona,
      voice: c.voice,
      aliases: c.aliases,
      secret: c.secret,
    }));
    openCreateScene(actions, {
      voices: currentVoices,
      initialSetting: scene?.setting,
      initialCast,
      submitLabel: "Update scene",
    });
  }

  // ---- Header ------------------------------------------------------------
  const settingLine = h("div", { class: "muted small dir-setting" });
  const editBtn = h("button", { class: "pillbtn white", onClick: () => editScene() }, "Edit scene");
  const leaveBtn = h("button", { class: "btn", onClick: () => actions.enterLobby() }, "Leave");

  // ---- Status + transport bar -------------------------------------------
  const phaseDot = h("span", { class: "pdot" });
  const phaseLabel = h("span", { class: "phase-label" }, "idle");
  const phaseChip = h("span", { class: "phase-chip" }, phaseDot, phaseLabel);
  const speakerEl = h("span", { class: "dir-speaker" });
  const chainEl = h("span", { class: "badge muted dir-chain" }, "");

  const startBtn = h("button", { class: "pillbtn blue", onClick: () => actions.start() }, "Start") as HTMLButtonElement;
  const stopBtn = h("button", { class: "btn", onClick: () => actions.stop() }, "Stop") as HTMLButtonElement;
  const resetBtn = h("button", { class: "btn", onClick: () => actions.reset() }, "Reset");

  // ---- Cast --------------------------------------------------------------
  const castCount = h("span", { class: "panel-count" }, "0 characters");
  const castGrid = h("div", { class: "cast-grid" });
  const castEmpty = h(
    "div",
    { class: "cast-empty-state muted" },
    "No characters yet — use Edit scene to set up the cast.",
  );
  castGrid.appendChild(castEmpty);

  // ---- Stage (transcript + narrator composer) ---------------------------
  const transcriptEl = h("div", { class: "transcript dir-transcript" });
  const humanInput = h("input", {
    class: "input",
    placeholder: "Speak as the human…",
  }) as HTMLInputElement;
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
  const humanBtn = h("button", { class: "btn blue", onClick: sendHuman }, "Send");

  // ---- Provider errors (collapsible) ------------------------------------
  const errorsEl = h("div", { class: "errors" });
  const errorsSummary = h("summary", { class: "dir-errors-summary" }, "Provider errors");
  const errorsPanel = h("details", { class: "dir-errors" }, errorsSummary, errorsEl);

  const el = h(
    "div",
    { class: "view director-view" },
    h(
      "div",
      { class: "create-head" },
      h("h1", { class: "col-title" }, "Director controls"),
      h("div", { class: "head-actions" }, editBtn, leaveBtn),
    ),
    settingLine,
    h(
      "div",
      { class: "dir-bar" },
      h("div", { class: "dir-status" }, phaseChip, speakerEl, chainEl),
      h("div", { class: "dir-transport" }, startBtn, stopBtn, resetBtn),
    ),
    h(
      "div",
      { class: "dir-stage" },
      h(
        "div",
        { class: "panel cast-panel" },
        h("div", { class: "panel-head" }, h("h2", null, "Cast"), castCount),
        castGrid,
      ),
      h(
        "div",
        { class: "panel stage-panel" },
        h("div", { class: "panel-head" }, h("h2", null, "Transcript")),
        transcriptEl,
        h("div", { class: "composer" }, humanInput, humanBtn),
      ),
    ),
    errorsPanel,
  );

  // ---- Per-character control cache ---------------------------------------
  const ctrlCache = new Map<string, CharCtrl>();

  function makeCtrl(charId: string): CharCtrl {
    const avatar = h("span", { class: "avatar" });
    const name = h("span", { class: "cc-name" });
    const dot = h("span", { class: "dot" });
    const status = h("span", { class: "cc-status" });
    const micBtn = h(
      "button",
      { class: "btn small", onClick: () => onSetMic(charId) },
      "Set mic",
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

    const card = h(
      "div",
      { class: "char-card" },
      h(
        "div",
        { class: "cc-top" },
        avatar,
        h("div", { class: "cc-id" }, name, status),
        dot,
      ),
      h(
        "div",
        { class: "cc-actions" },
        micBtn,
        h("div", { class: "cc-say" }, sayInput, sayBtn),
      ),
    );
    card.dataset.for = charId;
    return { card, avatar, name, dot, status, micBtn, sayInput };
  }

  function onSetMic(charId: string): void {
    const ch = currentScene?.characters.find((c) => c.id === charId);
    if (ch?.claimedBy) actions.setActiveMic(ch.claimedBy);
  }

  function renderCharControls(state: AppState): void {
    const scene = state.scene;
    const ids = new Set(scene?.characters.map((c) => c.id) ?? []);
    for (const [id, ctrl] of ctrlCache) {
      if (!ids.has(id)) {
        ctrl.card.remove();
        ctrlCache.delete(id);
      }
    }

    const count = scene?.characters.length ?? 0;
    castCount.textContent = `${count} character${count === 1 ? "" : "s"}`;
    castEmpty.style.display = count === 0 ? "" : "none";
    if (!scene) return;

    for (const c of scene.characters) {
      let ctrl = ctrlCache.get(c.id);
      if (!ctrl) {
        ctrl = makeCtrl(c.id);
        ctrlCache.set(c.id, ctrl);
        castGrid.appendChild(ctrl.card);
      }
      const connected = c.connected;
      const isMic = !!c.claimedBy && scene.activeMicClientId === c.claimedBy;
      const speaking = scene.currentSpeaker === c.id && scene.phase === "speaking";

      ctrl.avatar.textContent = initials(c.name);
      ctrl.name.textContent = c.name;
      ctrl.card.className =
        "char-card" + (speaking ? " speaking" : isMic ? " mic" : connected ? " connected" : "");
      ctrl.dot.className =
        "dot " + (speaking ? "speaking" : isMic ? "listening" : connected ? "connected" : "off");

      const bits: string[] = [
        connected ? `Played by ${c.claimedByLabel ?? "player"}` : "Not connected",
      ];
      if (isMic) bits.push("active mic");
      if (speaking) bits.push("speaking");
      ctrl.status.textContent = bits.join(" · ");

      ctrl.micBtn.textContent = isMic ? "On mic" : "Set mic";
      ctrl.micBtn.disabled = !connected || !scene.running || isMic;
    }
  }

  function update(state: AppState): void {
    currentVoices = state.voices;
    currentScene = state.scene;
    const scene = state.scene;

    if (scene?.setting) {
      settingLine.textContent = `Setting · ${scene.setting}`;
    } else if (scene && scene.characters.length > 0) {
      settingLine.textContent = `${scene.characters.length} character${scene.characters.length === 1 ? "" : "s"} · no setting yet`;
    } else {
      settingLine.textContent = "No scene yet — use Edit scene to set one up.";
    }

    const phase = scene?.phase ?? "idle";
    phaseChip.className = "phase-chip " + phase;
    phaseLabel.textContent = phase;

    let speakerText = "";
    if (scene) {
      if (scene.phase === "speaking" && scene.currentSpeaker) {
        const sp = scene.characters.find((c) => c.id === scene.currentSpeaker);
        if (sp) speakerText = `Speaking · ${sp.name}`;
      } else if (scene.running && scene.activeMicClientId) {
        const mic = scene.characters.find((c) => c.claimedBy === scene.activeMicClientId);
        if (mic) speakerText = `Mic · ${mic.name}`;
      }
    }
    speakerEl.textContent = speakerText;
    speakerEl.style.display = speakerText ? "" : "none";

    chainEl.textContent = scene && scene.running ? `NPC turns: ${scene.npcChainCount}` : "";
    chainEl.style.display = chainEl.textContent ? "" : "none";

    startBtn.disabled = !scene || scene.characters.length === 0 || !!scene.running;
    stopBtn.disabled = !scene?.running;

    const errCount = state.errors.length;
    errorsSummary.textContent = errCount ? `Provider errors (${errCount})` : "Provider errors";

    renderCharControls(state);
    renderTranscript(transcriptEl, state);
    renderErrors(errorsEl, state);
  }

  return { el, update };
}
