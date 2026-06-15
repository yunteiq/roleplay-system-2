// Wire protocol + domain types shared by client and server.
// JSON control messages are a discriminated union on the `t` field.
// Binary frames carry 16-bit little-endian mono PCM @ AUDIO_SAMPLE_RATE.

export type Role = "lobby" | "host" | "character";

export type Phase = "idle" | "listening" | "thinking" | "speaking";

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
  | { t: "setActiveMic"; clientId: string }
  | { t: "humanText"; text: string }
  | { t: "injectLine"; characterId: string; text: string }
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
    }
  | { t: "error"; message: string; scope?: string }
  | { t: "pong" };
