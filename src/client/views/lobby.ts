import { clear, h, type Actions, type AppState, type View } from "../ui.ts";

export function createLobbyView(actions: Actions): View {
  const nameInput = h("input", {
    class: "input",
    placeholder: "Your name / laptop label",
  }) as HTMLInputElement;
  nameInput.addEventListener("input", () => actions.setLabel(nameInput.value));

  const hostBtn = h("button", { class: "btn", onClick: () => actions.becomeHost() }, "Become Host");
  const settingEl = h("p", { class: "muted" });
  const charList = h("div", { class: "char-grid" });

  const el = h(
    "div",
    { class: "view lobby-view" },
    h(
      "div",
      { class: "card" },
      h("h1", null, "Live NPC Roleplay"),
      h("p", { class: "muted" }, "Claim a character to voice it on this laptop, or become the host."),
      h("div", { class: "row" }, nameInput, hostBtn),
    ),
    h("div", { class: "card" }, h("h2", null, "Characters"), settingEl, charList),
  );

  let lastLabel = "";
  function update(state: AppState): void {
    if (state.label !== lastLabel && document.activeElement !== nameInput) {
      nameInput.value = state.label;
      lastLabel = state.label;
    }

    const scene = state.scene;
    clear(charList);
    if (!scene || scene.characters.length === 0) {
      settingEl.textContent = "";
      charList.appendChild(
        h("p", { class: "muted" }, "No scene yet. Become the host to create one."),
      );
      return;
    }
    settingEl.textContent = scene.setting ? "Setting: " + scene.setting : "";

    for (const c of scene.characters) {
      const mine = c.claimedBy === state.clientId;
      const taken = c.connected && !mine;
      const btn = h(
        "button",
        {
          class: "btn small" + (mine ? " primary" : ""),
          disabled: taken,
          onClick: () => actions.claim(c.id),
        },
        mine ? "Claimed by you" : taken ? "Taken" : "Claim",
      );
      charList.appendChild(
        h(
          "div",
          { class: "char-card" + (mine ? " mine" : "") },
          h("div", { class: "char-name" }, c.name),
          h("div", { class: "char-persona muted" }, c.persona.slice(0, 140)),
          h(
            "div",
            { class: "char-status" },
            taken ? "Played by " + (c.claimedByLabel || "someone") : mine ? "You" : "Available",
          ),
          btn,
        ),
      );
    }
  }

  return { el, update };
}
