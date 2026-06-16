import type { CharacterInit, ServerToClient } from "../shared/types.ts";
import { WS } from "./ws.ts";
import { Capture } from "./audio/capture.ts";
import { Playback } from "./audio/playback.ts";
import { h, type Actions, type AppState, type View } from "./ui.ts";
import { createLobbyView } from "./views/lobby.ts";
import { createHostView } from "./views/host.ts";
import { createCharacterView } from "./views/character.ts";

const LABEL_KEY = "npc.label";

const wsProto = location.protocol === "https:" ? "wss:" : "ws:";
const ws = new WS(`${wsProto}//${location.host}/ws`);

const capture = new Capture();
const playback = new Playback();
let audioCtx: AudioContext | null = null;

const state: AppState = {
  clientId: "",
  role: "lobby",
  characterId: null,
  scene: null,
  audio: {
    sampleRate: 24000,
    micFrameMs: 20,
    micFrameMsFallback: 40,
    playbackPrefillMs: 40,
    playbackMaxBufferMs: 120,
  },
  voices: [],
  label: localStorage.getItem(LABEL_KEY) ?? "",
  audioJoined: false,
  isActiveMic: false,
  micLevel: 0,
  receivingAudio: false,
  transcript: [],
  livePartials: new Map(),
  errors: [],
};

const appRoot = document.getElementById("app")!;

// Persistent app shell: branded topbar over a swappable view mount. Ported
// from roleplay-director (brand wordmark + "Internal tool for" HP IQ logo).
const brand = h("div", { class: "brand-link" }, h("div", { class: "brand" }, "DEMO 4.0"));
brand.addEventListener("click", () => actions.enterLobby());
const topbar = h(
  "div",
  { class: "topbar" },
  brand,
  h(
    "div",
    { class: "byline" },
    h("span", null, "Internal tool for"),
    h("img", { class: "hp-logo", src: "/assets/hp-iq.svg", alt: "hp IQ" }),
  ),
);
const viewMount = h("div", { class: "view-mount" });
appRoot.replaceChildren(topbar, viewMount);

let currentView: View | null = null;

let rafPending = false;
function render(): void {
  if (rafPending) return;
  rafPending = true;
  requestAnimationFrame(() => {
    rafPending = false;
    currentView?.update(state);
  });
}

function pushError(msg: string): void {
  state.errors.push(msg);
  if (state.errors.length > 50) state.errors.splice(0, state.errors.length - 50);
  render();
}

function rebuildView(): void {
  let view: View;
  if (state.role === "host") view = createHostView(actions);
  else if (state.role === "character") view = createCharacterView(actions);
  else view = createLobbyView(actions);
  currentView = view;
  viewMount.replaceChildren(view.el);
  view.update(state);
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

const actions: Actions = {
  becomeHost: () => ws.sendJson({ t: "becomeHost", label: state.label || undefined }),
  enterLobby: () => ws.sendJson({ t: "enterLobby" }),
  setLabel: (label) => {
    state.label = label;
    localStorage.setItem(LABEL_KEY, label);
  },
  createScene: (setting, characters: CharacterInit[]) =>
    ws.sendJson({ t: "createScene", setting, characters }),
  claim: (characterId) =>
    ws.sendJson({ t: "claimCharacter", characterId, label: state.label || undefined }),
  release: () => ws.sendJson({ t: "releaseCharacter" }),
  start: () => ws.sendJson({ t: "startScene" }),
  stop: () => ws.sendJson({ t: "stopScene" }),
  reset: () => ws.sendJson({ t: "resetScene" }),
  setActiveMic: (clientId) => ws.sendJson({ t: "setActiveMic", clientId }),
  humanText: (text) => ws.sendJson({ t: "humanText", text }),
  injectLine: (characterId, text) => ws.sendJson({ t: "injectLine", characterId, text }),
  joinAudio: () => void joinAudio(),
};

async function joinAudio(): Promise<void> {
  if (state.audioJoined) return;
  try {
    audioCtx = new AudioContext({ sampleRate: state.audio.sampleRate });
    await audioCtx.resume();
    await audioCtx.audioWorklet.addModule("/worklet.js");
    playback.init(audioCtx, state.audio.playbackPrefillMs);
    const frameSamples = Math.round((state.audio.sampleRate * state.audio.micFrameMs) / 1000);
    await capture.start(audioCtx, frameSamples, {
      onLevel: (rms) => {
        state.micLevel = rms;
        currentView?.updateMeter?.(rms);
      },
      onFrame: (pcm) => {
        if (state.isActiveMic) ws.sendBinary(pcm);
      },
    });
    if (audioCtx.sampleRate !== state.audio.sampleRate) {
      pushError(
        `AudioContext sample rate is ${audioCtx.sampleRate}, expected ${state.audio.sampleRate}. Audio may sound pitched.`,
      );
    }
    state.audioJoined = true;
    render();
  } catch (e) {
    pushError("Join audio failed: " + (e instanceof Error ? e.message : String(e)));
    render();
  }
}

// ---------------------------------------------------------------------------
// Server messages
// ---------------------------------------------------------------------------

function onMessage(msg: ServerToClient): void {
  switch (msg.t) {
    case "welcome":
      state.clientId = msg.clientId;
      state.audio = msg.audio;
      state.voices = msg.voices;
      render();
      break;
    case "role": {
      const changed = state.role !== msg.role;
      state.role = msg.role;
      state.characterId = msg.characterId;
      if (changed) rebuildView();
      else render();
      break;
    }
    case "scene":
      handleScene(msg.scene);
      break;
    case "listen":
      state.isActiveMic = msg.on;
      render();
      break;
    case "speakBegin":
      state.receivingAudio = true;
      render();
      break;
    case "speakEnd":
      state.receivingAudio = false;
      render();
      break;
    case "stopAudio":
      playback.stop();
      state.receivingAudio = false;
      render();
      break;
    case "transcript":
      handleTranscript(msg);
      break;
    case "error":
      pushError((msg.scope ? `[${msg.scope}] ` : "") + msg.message);
      break;
    case "pong":
      break;
    default:
      break;
  }
}

function handleScene(scene: AppState["scene"]): void {
  state.scene = scene;
  if (scene) {
    if (scene.transcript.length === 0) {
      state.transcript = [];
      state.livePartials.clear();
    } else if (state.transcript.length === 0) {
      state.transcript = scene.transcript
        .filter((e) => e.final)
        .map((e) => ({ speaker: e.speaker, name: e.name, text: e.text }));
    }
  }
  render();
}

function handleTranscript(msg: Extract<ServerToClient, { t: "transcript" }>): void {
  const line = { speaker: msg.speaker, name: msg.name, text: msg.text };
  if (msg.final) {
    state.transcript.push(line);
    if (state.transcript.length > 200) state.transcript.splice(0, state.transcript.length - 200);
    state.livePartials.delete(msg.speaker);
  } else {
    state.livePartials.set(msg.speaker, line);
  }
  render();
}

ws.onJson(onMessage);
ws.onBinary((buf) => {
  if (state.receivingAudio) playback.push(buf);
});
ws.onClose(() => {
  state.isActiveMic = false;
  render();
});

rebuildView();
ws.connect();
