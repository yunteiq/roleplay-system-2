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

// Detect when TTS audio has ACTUALLY stopped (the playback ring buffer drained
// after speakEnd, plus a short tail for speaker/DAC settle) and report it to the
// server. The server holds STT for everyone until then, so the speaker's own
// output — including its buffered tail — is never transcribed back as input.
let ttsEnded = false;
let playbackEmpty = true;
let audioStopTimer: ReturnType<typeof setTimeout> | undefined;
const PLAYBACK_TAIL_MS = 500;

function reportAudioStoppedWhenIdle(): void {
  if (!ttsEnded || !playbackEmpty) return;
  clearTimeout(audioStopTimer);
  audioStopTimer = setTimeout(() => {
    ttsEnded = false;
    ws.sendJson({ t: "audioStopped" });
  }, PLAYBACK_TAIL_MS);
}

function onPlaybackDrained(): void {
  playbackEmpty = true;
  reportAudioStoppedWhenIdle();
}

function onPlaybackStarted(): void {
  // This machine is now outputting audio — tell the server so it makes us the
  // active mic (the mic follows whoever is currently speaking).
  ws.sendJson({ t: "audioStarted" });
}

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

// ---- Audio mode A/B switch (Legacy half-duplex vs AEC full-duplex) ----------
const AUDIO_MODE_KEY = "npc.audioMode";
type AudioMode = "aec" | "legacy";
// Default to Legacy (half-duplex, echo-safe): the server gates the mic while an
// NPC is talking, so a mic without echo cancellation (e.g. the H4) can't feed the
// character's own TTS back into STT. Only an explicit AEC choice opts in.
let audioMode: AudioMode = localStorage.getItem(AUDIO_MODE_KEY) === "aec" ? "aec" : "legacy";

const audioModeBtn = h("button", {
  class: "btn small mode-toggle",
  title:
    "Echo strategy. Legacy: half-duplex (mic muted while an NPC talks). " +
    "AEC: full-duplex echo cancellation (talk over NPCs). Changing re-joins audio.",
  onClick: () => setAudioMode(audioMode === "aec" ? "legacy" : "aec"),
}) as HTMLButtonElement;

function renderAudioMode(): void {
  audioModeBtn.textContent = audioMode === "aec" ? "Audio: AEC" : "Audio: Legacy";
  audioModeBtn.dataset.mode = audioMode;
}

function setAudioMode(mode: AudioMode): void {
  audioMode = mode;
  localStorage.setItem(AUDIO_MODE_KEY, mode);
  ws.sendJson({ t: "setAudioMode", mode });
  renderAudioMode();
  // Rebuild the audio pipeline cleanly under the new mode for a clean A/B test.
  if (state.audioJoined) location.reload();
}
renderAudioMode();

// Persistent app shell: branded topbar over a swappable view mount. Ported
// from roleplay-director (brand wordmark + "Internal tool for" HP IQ logo).
const brand = h("div", { class: "brand-link" }, h("div", { class: "brand" }, "DEMO 4.0"));
brand.addEventListener("click", () => actions.enterLobby());
// Live H4 presence indicator (driven by the device's heartbeat).
const h4Pill = h("span", { class: "badge h4-pill off" }, "H4 not connected");
const topbar = h(
  "div",
  { class: "topbar" },
  brand,
  h(
    "div",
    { class: "byline" },
    h4Pill,
    audioModeBtn,
    h("span", null, "Internal tool for"),
    h("img", { class: "hp-logo", src: "/assets/hp-iq.svg", alt: "hp IQ" }),
  ),
);

function updateH4Indicator(): void {
  const connected = !!state.scene?.h4Connected;
  h4Pill.textContent = connected ? "H4 connected" : "H4 not connected";
  h4Pill.className = "badge h4-pill " + (connected ? "ok" : "off");
}
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
  humanText: (text) => ws.sendJson({ t: "humanText", text }),
  injectLine: (characterId, text) => ws.sendJson({ t: "injectLine", characterId, text }),
  joinAudio: () => void joinAudio(),
  setFloor: (mode, action) => ws.sendJson({ t: "setFloor", mode, action }),
};

// H4 floor remote keyboard shortcuts (hold A = talk to device, hold T = via
// device). Wired once globally; the on-screen buttons do the same over pointer.
const floorKeys = new Set<string>();
const isTypingTarget = (t: EventTarget | null): boolean => {
  const tag = (t as HTMLElement | null)?.tagName;
  return tag === "INPUT" || tag === "TEXTAREA";
};
window.addEventListener("keydown", (e) => {
  if (e.repeat || isTypingTarget(e.target)) return;
  const k = e.key.toLowerCase();
  if (k === "a" && !floorKeys.has("a")) {
    floorKeys.add("a");
    actions.setFloor("device_directed", "ASK");
  } else if (k === "t" && !floorKeys.has("t")) {
    floorKeys.add("t");
    actions.setFloor("device_mediated", "TRANSLATION");
  }
});
window.addEventListener("keyup", (e) => {
  const k = e.key.toLowerCase();
  if ((k === "a" && floorKeys.delete("a")) || (k === "t" && floorKeys.delete("t"))) {
    if (floorKeys.size === 0) actions.setFloor("direct");
  }
});

async function joinAudio(): Promise<void> {
  if (state.audioJoined) return;
  try {
    audioCtx = new AudioContext({ sampleRate: state.audio.sampleRate });
    await audioCtx.resume();
    await audioCtx.audioWorklet.addModule("/worklet.js");
    await playback.init(audioCtx, state.audio.playbackPrefillMs, {
      aec: audioMode === "aec",
      onStarted: onPlaybackStarted,
      onDrained: onPlaybackDrained,
    });
    const frameSamples = Math.round((state.audio.sampleRate * state.audio.micFrameMs) / 1000);
    await capture.start(audioCtx, frameSamples, {
      onLevel: (rms) => {
        state.micLevel = rms;
        currentView?.updateMeter?.(rms);
      },
      onFrame: (pcm) => {
        // The server gates STT while audio is playing (until we report
        // audioStopped), so we can stream the mic whenever we're the active mic.
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
      // Sync our chosen echo strategy to the server (drives its STT gating).
      ws.sendJson({ t: "setAudioMode", mode: audioMode });
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
      clearTimeout(audioStopTimer);
      ttsEnded = false;
      playbackEmpty = false;
      state.receivingAudio = true;
      render();
      break;
    case "speakEnd":
      // Server finished sending; the buffer is usually still draining. We report
      // audioStopped to the server once it actually drains (onPlaybackDrained).
      ttsEnded = true;
      state.receivingAudio = false;
      reportAudioStoppedWhenIdle();
      render();
      break;
    case "stopAudio":
      // Barge-in / hard stop: the server already dropped audio and reopened input.
      clearTimeout(audioStopTimer);
      playback.stop();
      ttsEnded = false;
      playbackEmpty = true;
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
  updateH4Indicator();
  if (scene) {
    if (scene.transcript.length === 0) {
      state.transcript = [];
      state.livePartials.clear();
    } else if (state.transcript.length === 0) {
      state.transcript = scene.transcript
        .filter((e) => e.final)
        .map((e) => ({ speaker: e.speaker, name: e.name, text: e.text, channel: e.channel }));
    }
  }
  render();
}

function handleTranscript(msg: Extract<ServerToClient, { t: "transcript" }>): void {
  const line = { speaker: msg.speaker, name: msg.name, text: msg.text, channel: msg.channel };
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
  if (state.receivingAudio) {
    playbackEmpty = false;
    playback.push(buf);
  }
});
ws.onClose(() => {
  state.isActiveMic = false;
  render();
});

rebuildView();
ws.connect();
