// Wire protocol + domain types shared by client and server.
// JSON control messages are a discriminated union on the `t` field.
// Binary frames carry 16-bit little-endian mono PCM @ AUDIO_SAMPLE_RATE.

export type Role = "lobby" | "host" | "character";

export type Phase = "idle" | "listening" | "thinking" | "speaking";

/**
 * H4 floor mode — who the human is addressing right now (driven by the H4
 * gesture remote, or the web fallback). Gates whether the AI characters respond:
 *  - "direct": normal — the human is talking to the characters.
 *  - "device_directed": the human is talking TO their device (Ask / Vision /
 *    dictation). Characters stay silent; the human's words are logged as a
 *    private aside the characters never perceive.
 *  - "device_mediated": the human is communicating with the scene THROUGH the
 *    device (e.g. translation). The human's words are a private query to the
 *    device ("Query for H4"); the device then speaks its reply aloud, which is
 *    relayed into the conversation on the person's behalf ("H4 response").
 *    Characters stay silent while held and respond to the device's reply when
 *    the gesture is released.
 */
export type HumanFloorMode = "direct" | "device_directed" | "device_mediated";

/**
 * Which H4 floor channel a transcript line arrived on (undefined = normal):
 *  - "to_device": ASK mode — the human spoke privately to their device.
 *  - "query_for_device": via-device mode — the human's query to the device.
 * Both of the above are kept out of what the characters perceive.
 *  - "via_device": via-device mode — the device's spoken reply, relayed into the
 *    conversation on the person's behalf (the characters respond to this).
 */
export type TurnChannel = "to_device" | "via_device" | "query_for_device";

/** Built-in OpenAI TTS voices offered in the host UI dropdown. */
export const VOICES = [
  "alloy",
  "ash",
  "ballad",
  "coral",
  "echo",
  "fable",
  "nova",
  "onyx",
  "sage",
  "shimmer",
  "verse",
] as const;

export type Voice = (typeof VOICES)[number] | string;

export interface AudioConfig {
  sampleRate: number;
  micFrameMs: number;
  micFrameMsFallback: number;
  playbackPrefillMs: number;
  playbackMaxBufferMs: number;
}

export interface CharacterInit {
  name: string;
  persona: string;
  voice: Voice;
  aliases: string[];
  secret?: string;
}

export interface CharacterState {
  id: string;
  name: string;
  persona: string;
  voice: Voice;
  aliases: string[];
  secret?: string;
  /** clientId of the laptop currently playing this character, or null. */
  claimedBy: string | null;
  claimedByLabel: string | null;
  /** Whether the claiming laptop is currently connected. */
  connected: boolean;
}

export interface ClientInfo {
  id: string;
  role: Role;
  label: string;
  characterId: string | null;
}

export interface TranscriptEntry {
  id: string;
  /** A character id, or "human" for human-spoken lines. */
  speaker: string;
  name: string;
  text: string;
  ts: number;
  final: boolean;
  /** H4 floor channel (see TurnChannel); undefined for normal scene lines. */
  channel?: TurnChannel;
}

export interface SceneState {
  id: string;
  setting: string;
  running: boolean;
  phase: Phase;
  characters: CharacterState[];
  activeMicClientId: string | null;
  /** Character id currently speaking/most recently spoke, or null. */
  currentSpeaker: string | null;
  npcChainCount: number;
  /** Current H4 floor mode (who the human is addressing). */
  floorMode: HumanFloorMode;
  /** Optional H4 gesture/action that set the current floor mode (e.g. "ASK"). */
  floorAction?: string;
  /** What set the current floor mode: the H4 device or the web fallback. */
  floorSource?: "h4" | "web";
  /** Whether an H4 device is currently connected (heartbeat within timeout). */
  h4Connected: boolean;
  transcript: TranscriptEntry[];
  connectedClients: ClientInfo[];
}

// ---------------------------------------------------------------------------
// Client -> Server
// ---------------------------------------------------------------------------

export type ClientToServer =
  | { t: "createScene"; setting: string; characters: CharacterInit[] }
  | { t: "claimCharacter"; characterId: string; label?: string }
  | { t: "releaseCharacter" }
  | { t: "becomeHost"; label?: string }
  | { t: "enterLobby" }
  | { t: "startScene" }
  | { t: "stopScene" }
  | { t: "resetScene" }
  | { t: "humanText"; text: string }
  | { t: "injectLine"; characterId: string; text: string }
  /** Set the H4 floor mode (web fallback for the H4 gesture remote). */
  | { t: "setFloor"; mode: HumanFloorMode; action?: string }
  /** A/B switch for the echo strategy: "legacy" half-duplex (gate STT during
   *  playback) vs "aec" full-duplex (rely on client AEC, keep the mic open). */
  | { t: "setAudioMode"; mode: "aec" | "legacy" }
  /** Sent by a client when its TTS playback actually starts; the server makes
   *  that machine the active mic (the mic follows whoever is outputting audio). */
  | { t: "audioStarted" }
  /** Sent by the playing client once its TTS playback buffer has actually
   *  drained, so the server knows audio truly stopped (not just finished sending). */
  | { t: "audioStopped" }
  | { t: "ping" };

// ---------------------------------------------------------------------------
// Server -> Client
// ---------------------------------------------------------------------------

export type ServerToClient =
  | { t: "welcome"; clientId: string; audio: AudioConfig; voices: string[] }
  | { t: "role"; role: Role; characterId: string | null }
  | { t: "scene"; scene: SceneState }
  | { t: "listen"; on: boolean; frameMs: number }
  | { t: "speakBegin"; characterId: string; turnId: string }
  | { t: "speakEnd"; characterId: string; turnId: string }
  | { t: "stopAudio" }
  | {
      t: "transcript";
      speaker: string;
      name: string;
      text: string;
      final: boolean;
      channel?: TurnChannel;
    }
  | { t: "error"; message: string; scope?: string }
  | { t: "pong" };
