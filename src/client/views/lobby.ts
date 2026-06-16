import { clear, h, icon, initials, type Actions, type AppState, type View } from "../ui.ts";
import { openCreateScene } from "./create-scene.ts";

export function createLobbyView(actions: Actions): View {
  let currentVoices: string[] = [];
  // ---- Connect line (copy the LAN URL other laptops should open) ---------
  const copyIcon = icon("copy", 13);
  const connBtn = h(
    "button",
    {
      class: "conn-copy",
      type: "button",
      title: "Click to copy",
      onClick: () => void copyConn(),
    },
    location.origin,
    copyIcon,
  ) as HTMLButtonElement;
  let copyTimer: ReturnType<typeof setTimeout> | undefined;
  async function copyConn(): Promise<void> {
    try {
      await navigator.clipboard?.writeText(location.origin);
      connBtn.replaceChildren(document.createTextNode(location.origin), icon("check", 13));
      connBtn.title = "Copied!";
      clearTimeout(copyTimer);
      copyTimer = setTimeout(() => {
        connBtn.replaceChildren(document.createTextNode(location.origin), icon("copy", 13));
        connBtn.title = "Click to copy";
      }, 4000);
    } catch {
      /* clipboard unavailable — ignore */
    }
  }

  // ---- Primary action: create a new scene (opens a popup) ----------------
  const createBtn = h(
    "button",
    { class: "btn-create", onClick: () => openCreateScene(actions, { voices: currentVoices }) },
    icon("plus", 20),
    "Create a new scene",
  );
  const settingLine = h("div", { class: "conn-line" });
  const sessionList = h("div", { class: "session-list" });

  const el = h(
    "div",
    { class: "view lobby-view" },
    h(
      "div",
      { class: "landing" },
      h(
        "div",
        { class: "conn-line" },
        "Connect on this network at ",
        connBtn,
      ),
      createBtn,
      settingLine,
      sessionList,
    ),
    h(
      "div",
      { class: "tagline" },
      "I like sunshine and rainbows. You better like them too.",
    ),
  );

  function update(state: AppState): void {
    currentVoices = state.voices;
    const scene = state.scene;
    settingLine.textContent = scene?.setting ? `Setting · ${scene.setting}` : "";
    settingLine.style.display = scene?.setting ? "" : "none";

    clear(sessionList);
    if (!scene || scene.characters.length === 0) {
      sessionList.appendChild(
        h(
          "div",
          { class: "session-empty" },
          "No active scene yet. Create one to begin.",
        ),
      );
      return;
    }

    for (const c of scene.characters) {
      const mine = c.claimedBy === state.clientId;
      const taken = c.connected && !mine;
      const btn = h(
        "button",
        {
          class: mine ? "pillbtn blue" : "pillbtn white",
          disabled: taken,
          onClick: () => actions.claim(c.id),
        },
        mine ? "Joined" : taken ? "Taken" : "Join",
      );
      sessionList.appendChild(
        h(
          "div",
          { class: "session-row" },
          h(
            "div",
            { class: "session-main" },
            h("span", { class: "avatar" }, initials(c.name)),
            h(
              "div",
              null,
              h("div", { class: "s-title" }, c.name),
              h(
                "div",
                { class: "s-meta" },
                h(
                  "span",
                  null,
                  taken
                    ? `Played by ${c.claimedByLabel || "someone"}`
                    : mine
                      ? "You"
                      : "Available",
                ),
              ),
            ),
          ),
          btn,
        ),
      );
    }

    // Director controls offered as the last row in the players list. Reclaims
    // the director seat for the existing scene; shown as "Taken" while someone
    // else already holds the host role.
    const directorTaken = scene.connectedClients.some((c) => c.role === "host");
    sessionList.appendChild(
      h(
        "div",
        { class: "session-row" },
        h(
          "div",
          { class: "session-main" },
          h("span", { class: "avatar" }, icon("setting", 16)),
          h(
            "div",
            null,
            h("div", { class: "s-title" }, "Director"),
            h(
              "div",
              { class: "s-meta" },
              h("span", null, directorTaken ? "Taken" : "Available"),
            ),
          ),
        ),
        h(
          "button",
          {
            class: "pillbtn white",
            disabled: directorTaken,
            onClick: () => actions.becomeHost(),
          },
          directorTaken ? "Taken" : "Join",
        ),
      ),
    );
  }

  return { el, update };
}
