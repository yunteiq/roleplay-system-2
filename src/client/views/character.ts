import { createFloorWidget, h, renderTranscript, type Actions, type AppState, type View } from "../ui.ts";

export function createCharacterView(actions: Actions): View {
  const floor = createFloorWidget(actions);
  const titleEl = h("h1", null, "Character");
  const joinBtn = h("button", { class: "btn primary big", onClick: () => actions.joinAudio() }, "Join audio");
  const statusEl = h("div", { class: "status-big waiting" }, "WAITING");
  const micBadge = h("span", { class: "badge" }, "mic off");
  const meterFill = h("div", { class: "meter-fill" });
  const meter = h("div", { class: "meter" }, meterFill);
  const transcriptEl = h("div", { class: "transcript" });
  const leaveBtn = h("button", { class: "btn", onClick: () => actions.release() }, "Leave");

  const el = h(
    "div",
    { class: "view character-view" },
    h(
      "div",
      { class: "card" },
      h("div", { class: "row space" }, titleEl, micBadge),
      joinBtn,
      statusEl,
      h("div", { class: "meter-row" }, h("span", { class: "muted" }, "Mic level"), meter),
      h("div", { class: "row" }, leaveBtn),
    ),
    floor.el,
    h("div", { class: "card" }, h("h3", null, "Live transcript"), transcriptEl),
  );

  function update(state: AppState): void {
    const ch = state.scene?.characters.find((c) => c.id === state.characterId);
    titleEl.textContent = ch ? ch.name : "Character";
    joinBtn.style.display = state.audioJoined ? "none" : "";

    let status = "WAITING";
    let cls = "waiting";
    if (!state.audioJoined) {
      status = "TAP JOIN AUDIO";
      cls = "waiting";
    } else if (state.receivingAudio) {
      status = "SPEAKING";
      cls = "speaking";
    } else if (state.isActiveMic) {
      status = "LISTENING";
      cls = "listening";
    }
    statusEl.textContent = status;
    statusEl.className = "status-big " + cls;

    micBadge.textContent = state.audioJoined
      ? state.isActiveMic
        ? "mic LIVE"
        : "mic hot"
      : "mic off";
    micBadge.className = "badge " + (state.isActiveMic ? "listening" : "");

    floor.update(state);
    renderTranscript(transcriptEl, state);
  }

  function updateMeter(level: number): void {
    meterFill.style.width = Math.min(100, Math.round(level * 240)) + "%";
  }

  return { el, update, updateMeter };
}
