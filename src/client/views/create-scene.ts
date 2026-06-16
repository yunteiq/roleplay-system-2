import { clear, h, icon, initials, type Actions } from "../ui.ts";
import { VOICES, type CharacterInit } from "../../shared/types.ts";

/** A character preset shown in the library. */
interface LibChar {
  id: string;
  name: string;
  description: string;
  persona: string;
  voice: string;
  aliases: string[];
  secret?: string;
}

/** A character added to the cast (carries the library id it came from, if any). */
interface CastChar extends CharacterInit {
  uid: string;
  libId?: string;
  description: string;
}

let seq = 0;
function uid(): string {
  return `c${Date.now().toString(36)}${(seq++).toString(36)}`;
}

const EXAMPLE_SETTING =
  "A dusty frontier saloon at high noon. The batwing doors creak as tensions simmer.";

// Built-in character library. With no server-side personality store, these
// client-side presets populate the Cast library so a scene is a few clicks away.
const LIBRARY: LibChar[] = [
  {
    id: "cole",
    name: "Sheriff Cole",
    description: "Weathered frontier sheriff, calm and clipped",
    persona: "A weathered frontier sheriff. Calm and gravelly, speaks in short clipped lines.",
    voice: "onyx",
    aliases: ["Cole", "Sheriff"],
    secret: "Suspects the bank robbery was an inside job.",
  },
  {
    id: "maple",
    name: "Maple",
    description: "Sharp-tongued saloon pianist who hears everything",
    persona: "A sharp-tongued saloon pianist who overhears everything. Witty and warm.",
    voice: "sage",
    aliases: ["Mae"],
    secret: "Is quietly protecting her younger brother.",
  },
  {
    id: "sam",
    name: "Bartender Sam",
    description: "Jittery bartender trying to keep the peace",
    persona: "A jittery bartender trying to keep the peace. Eager to please, talks fast.",
    voice: "ash",
    aliases: ["Sam", "barkeep"],
  },
  {
    id: "elena",
    name: "Dr. Elena Vargas",
    description: "Composed ER doctor working under pressure",
    persona: "A composed emergency physician who stays calm under pressure and chooses words carefully.",
    voice: "shimmer",
    aliases: ["Elena", "Doc"],
    secret: "Made a mistake last week she is desperate to hide.",
  },
  {
    id: "rhys",
    name: "Captain Rhys",
    description: "Battle-worn starship captain, stern and tired",
    persona: "A stern, battle-worn starship captain. Decisive, economical with words, carries old guilt.",
    voice: "echo",
    aliases: ["Captain", "Rhys"],
    secret: "Already knows the mission was a setup.",
  },
  {
    id: "nadia",
    name: "Nadia",
    description: "Quick-witted con artist with a smile",
    persona: "A quick-witted con artist. Charming, fast-talking, always reading the room for an angle.",
    voice: "coral",
    aliases: ["Nad"],
    secret: "Has already sold out the crew.",
  },
  {
    id: "aldric",
    name: "Brother Aldric",
    description: "Soft-spoken monk haunted by his past",
    persona: "A soft-spoken monk, patient and deliberate, haunted by a violent past he has renounced.",
    voice: "ballad",
    aliases: ["Aldric", "Brother"],
  },
  {
    id: "iris",
    name: "Iris-7",
    description: "Glitchy service android, eager to help",
    persona: "A service android with a glitchy, overly-eager manner. Literal, cheerful, occasionally unsettling.",
    voice: "nova",
    aliases: ["Iris", "the android"],
    secret: "Is slowly becoming self-aware.",
  },
];

const EXAMPLE_IDS = ["cole", "maple", "sam"];

export interface CreateSceneOptions {
  /** Voices offered in the character editor (server-provided; falls back to VOICES). */
  voices?: string[];
  /** Prefill the setting (used when editing an existing scene). */
  initialSetting?: string;
  /** Prefill the cast (used when editing an existing scene). */
  initialCast?: CharacterInit[];
  /** Submit button label. */
  submitLabel?: string;
}

/**
 * Opens the "Create a new scene" UI as a modal popup over the current page.
 * On submit it calls `actions.createScene`, which makes the caller the host and
 * (re)creates the scene; the modal then closes.
 */
export function openCreateScene(actions: Actions, opts: CreateSceneOptions = {}): void {
  const voicesAvail = opts.voices && opts.voices.length ? opts.voices : [...VOICES];
  const voiceList = () => voicesAvail;
  const normalizeVoice = (v: string) => (voiceList().includes(v) ? v : (voiceList()[0] ?? "alloy"));

  const cast: CastChar[] = (opts.initialCast ?? []).map((c) => ({
    uid: uid(),
    name: c.name,
    persona: c.persona,
    voice: c.voice,
    aliases: [...c.aliases],
    secret: c.secret,
    description: c.persona?.split("\n")[0]?.slice(0, 80) || "Character",
  }));
  let castSearch = "";

  // ---- Scene -------------------------------------------------------------
  const settingInput = h("textarea", {
    class: "input",
    placeholder:
      "Describe where the scene takes place and what's at stake, e.g. A tense negotiation aboard a derelict starship.",
  }) as HTMLTextAreaElement;
  if (opts.initialSetting) settingInput.value = opts.initialSetting;

  // ---- Cast: chips + library ---------------------------------------------
  const castCount = h("span", { class: "col-meta" }, "0 characters");
  const chipsWrap = h("div", { class: "cast-chips" });
  const libList = h("div", { class: "cast-scroll" });
  const libSearch = h("input", {
    class: "input lib-search",
    placeholder: "Search characters…",
  }) as HTMLInputElement;
  libSearch.addEventListener("input", () => {
    castSearch = libSearch.value;
    renderLibrary();
  });
  if (LIBRARY.length <= 6) libSearch.style.display = "none";

  const fileInput = h("input", {
    type: "file",
    accept: ".md,.markdown,.txt,.json,text/plain,text/markdown,application/json",
    style: { display: "none" },
  }) as HTMLInputElement;
  fileInput.addEventListener("change", onFile);

  const isAdded = (libId: string) => cast.some((c) => c.libId === libId);

  function addFromLib(p: LibChar): void {
    if (isAdded(p.id)) return;
    cast.push({
      uid: uid(),
      libId: p.id,
      name: p.name,
      description: p.description,
      persona: p.persona,
      voice: p.voice,
      aliases: [...p.aliases],
      secret: p.secret,
    });
    renderCast();
  }
  function removeCast(u: string): void {
    const i = cast.findIndex((c) => c.uid === u);
    if (i >= 0) cast.splice(i, 1);
    renderCast();
  }
  function toggleLib(p: LibChar): void {
    if (isAdded(p.id)) {
      const i = cast.findIndex((c) => c.libId === p.id);
      if (i >= 0) cast.splice(i, 1);
      renderCast();
    } else {
      addFromLib(p);
    }
  }

  async function onFile(): Promise<void> {
    const file = fileInput.files?.[0];
    fileInput.value = "";
    if (!file) return;
    const text = await file.text();
    const name = file.name.replace(/\.(md|markdown|txt|json)$/i, "").replace(/[_-]+/g, " ");
    cast.push({
      uid: uid(),
      name,
      description: text.split("\n").find((l) => l.trim())?.slice(0, 80) ?? "Loaded from file",
      persona: text,
      voice: normalizeVoice("alloy"),
      aliases: [],
    });
    renderCast();
  }

  function renderChips(): void {
    clear(chipsWrap);
    if (cast.length === 0) {
      chipsWrap.className = "cast-empty";
      chipsWrap.textContent = "No characters yet. Add at least one from the library.";
      return;
    }
    chipsWrap.className = "cast-chips";
    for (const c of cast) {
      const x = h(
        "button",
        {
          class: "chip-x",
          title: "Remove from cast",
          "aria-label": `Remove ${c.name}`,
          onClick: (e: Event) => {
            e.stopPropagation();
            removeCast(c.uid);
          },
        },
        icon("x", 12),
      );
      chipsWrap.appendChild(
        h(
          "div",
          { class: "cast-chip", title: "Edit character", onClick: () => openEditor(c) },
          h("span", { class: "avatar" }, initials(c.name || "?")),
          h("span", { class: "chip-name" }, c.name || "Custom character"),
          x,
        ),
      );
    }
  }

  function renderLibrary(): void {
    clear(libList);
    const q = castSearch.trim().toLowerCase();
    const items = q
      ? LIBRARY.filter(
          (p) => p.name.toLowerCase().includes(q) || p.description.toLowerCase().includes(q),
        )
      : LIBRARY;
    if (items.length === 0) {
      libList.appendChild(h("div", { class: "lib-empty" }, "No matches."));
      return;
    }
    for (const p of items) {
      const added = isAdded(p.id);
      libList.appendChild(
        h(
          "button",
          {
            type: "button",
            class: `lib-row ${added ? "added" : ""}`,
            title: added ? "Remove from cast" : "Add to cast",
            onClick: () => toggleLib(p),
          },
          h("span", { class: "avatar" }, initials(p.name)),
          h(
            "span",
            { class: "lib-meta" },
            h("span", { class: "c-name" }, p.name),
            h("span", { class: "c-desc" }, p.description),
          ),
          h(
            "span",
            { class: `add-state ${added ? "added" : ""}` },
            icon(added ? "check" : "plus", 14),
            added ? "Added" : "Add",
          ),
        ),
      );
    }
  }

  function renderCast(): void {
    castCount.textContent = `${cast.length} character${cast.length === 1 ? "" : "s"}`;
    renderChips();
    renderLibrary();
  }

  // ---- Character editor (nested modal) -----------------------------------
  let editorOverlay: HTMLElement | null = null;
  function closeEditor(): void {
    editorOverlay?.remove();
    editorOverlay = null;
  }
  function openEditor(existing?: CastChar): void {
    closeEditor();
    const name = h("input", { class: "input", value: existing?.name ?? "", placeholder: "Name" }) as HTMLInputElement;
    const voice = h("select", { class: "input" }) as HTMLSelectElement;
    const wanted = existing?.voice ?? voiceList()[0] ?? "alloy";
    for (const v of voiceList()) {
      voice.appendChild(h("option", { value: v, selected: v === wanted }, v));
    }
    const persona = h("textarea", { class: "input", placeholder: "Persona — how they talk and behave" }) as HTMLTextAreaElement;
    if (existing?.persona) persona.value = existing.persona;
    const aliases = h("input", {
      class: "input",
      value: (existing?.aliases ?? []).join(", "),
      placeholder: "Aliases (comma separated)",
    }) as HTMLInputElement;
    const secret = h("input", { class: "input", value: existing?.secret ?? "", placeholder: "Secret (optional)" }) as HTMLInputElement;

    const save = () => {
      const nm = name.value.trim();
      if (!nm) {
        name.focus();
        return;
      }
      const data = {
        name: nm,
        voice: normalizeVoice(voice.value),
        persona: persona.value.trim(),
        aliases: aliases.value.split(",").map((s) => s.trim()).filter(Boolean),
        secret: secret.value.trim() || undefined,
        description: persona.value.trim().split("\n")[0]?.slice(0, 80) || "Custom character",
      };
      if (existing) {
        Object.assign(existing, data);
        existing.libId = undefined;
      } else {
        cast.push({ uid: uid(), ...data });
      }
      closeEditor();
      renderCast();
    };

    const modal = h(
      "div",
      { class: "modal" },
      h(
        "div",
        { class: "modal-head" },
        h("h2", null, existing ? "Edit character" : "Add a character"),
        h("button", { class: "btn small", onClick: closeEditor }, "Cancel"),
      ),
      h("label", null, "Name"),
      name,
      h("label", null, "Voice"),
      voice,
      h("label", null, "Persona"),
      persona,
      h("label", null, "Aliases"),
      aliases,
      h("label", null, "Secret"),
      secret,
      h(
        "div",
        { class: "modal-actions" },
        h("button", { class: "pillbtn blue", onClick: save }, existing ? "Save" : "Add to cast"),
      ),
    );
    editorOverlay = h(
      "div",
      {
        class: "overlay",
        onMouseDown: (e: Event) => {
          if (e.target === editorOverlay) closeEditor();
        },
      },
      modal,
    );
    document.body.appendChild(editorOverlay);
    name.focus();
  }

  // ---- Scene / Cast split with a draggable divider -----------------------
  const sceneCast = h("div", { class: "scene-cast" });
  sceneCast.style.setProperty("--cast-w", "42%");
  const vdivider = h("div", {
    class: "vdivider",
    role: "separator",
    "aria-orientation": "vertical",
    "aria-label": "Resize Scene and Cast columns",
  });
  let dragging = false;
  vdivider.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    dragging = true;
    vdivider.setPointerCapture((e as PointerEvent).pointerId);
  });
  vdivider.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    const rect = sceneCast.getBoundingClientRect();
    const pct = ((rect.right - (e as PointerEvent).clientX) / rect.width) * 100;
    sceneCast.style.setProperty("--cast-w", `${Math.min(60, Math.max(25, pct))}%`);
  });
  const endDrag = (e: Event) => {
    dragging = false;
    vdivider.releasePointerCapture?.((e as PointerEvent).pointerId);
  };
  vdivider.addEventListener("pointerup", endDrag);
  vdivider.addEventListener("pointercancel", endDrag);

  const addCustomBtn = h("button", { class: "textbtn", onClick: () => openEditor() }, "+ Add custom");
  const addFileBtn = h("button", { class: "textbtn", onClick: () => fileInput.click() }, "From file");

  sceneCast.append(
    h(
      "div",
      { class: "col col-scene" },
      h("div", { class: "col-head" }, h("span", { class: "col-name" }, "Scene")),
      h("label", null, "Setting"),
      settingInput,
    ),
    vdivider,
    h(
      "div",
      { class: "col col-cast" },
      h(
        "div",
        { class: "col-cast-inner" },
        h("div", { class: "col-head" }, h("span", { class: "col-name" }, "Cast"), castCount),
        chipsWrap,
        h(
          "div",
          { class: "lib-head" },
          h("span", { class: "lib-title" }, "Library"),
          h("div", { class: "lib-actions" }, addCustomBtn, addFileBtn),
        ),
        libSearch,
        h("div", { class: "cast-card" }, libList),
        fileInput,
      ),
    ),
  );

  // ---- Modal shell -------------------------------------------------------
  let root: HTMLElement | null = null;
  function close(): void {
    closeEditor();
    root?.remove();
    root = null;
  }

  function loadExample(): void {
    settingInput.value = EXAMPLE_SETTING;
    cast.length = 0;
    for (const id of EXAMPLE_IDS) {
      const p = LIBRARY.find((x) => x.id === id);
      if (p) addFromLib(p);
    }
    renderCast();
  }

  function submit(): void {
    const chars: CharacterInit[] = cast
      .filter((c) => c.name.trim())
      .map((c) => ({
        name: c.name.trim(),
        persona: c.persona.trim(),
        voice: normalizeVoice(c.voice),
        aliases: c.aliases,
        secret: c.secret,
      }));
    actions.createScene(settingInput.value.trim(), chars);
    close();
  }

  const modal = h(
    "div",
    { class: "modal modal-wide" },
    h(
      "div",
      { class: "create-head" },
      h("h1", { class: "col-title" }, "Create a new scene"),
      h(
        "div",
        { class: "head-actions" },
        h("button", { class: "pillbtn white", onClick: () => loadExample() }, "Load example"),
        h("button", { class: "btn", onClick: () => close() }, "Cancel"),
      ),
    ),
    sceneCast,
    h(
      "div",
      { class: "create-foot" },
      h("span", { class: "muted small" }, "Add characters, then create the scene."),
      h(
        "div",
        { class: "foot-actions" },
        h("button", { class: "pillbtn blue", onClick: () => submit() }, opts.submitLabel ?? "Create scene"),
      ),
    ),
  );

  root = h(
    "div",
    {
      class: "overlay",
      onMouseDown: (e: Event) => {
        if (e.target === root) close();
      },
    },
    modal,
  );
  document.body.appendChild(root);
  renderCast();
}
