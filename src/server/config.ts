import "dotenv/config";

export type Provider = "openai" | "gemini";

export interface ModelRef {
  provider: Provider;
  model: string;
  /** Original "provider:model" string. */
  raw: string;
}

function str(name: string, fallback: string): string {
  const v = process.env[name];
  return v === undefined || v === "" ? fallback : v;
}

function num(name: string, fallback: number): number {
  const v = process.env[name];
  if (v === undefined || v === "") return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function bool(name: string, fallback: boolean): boolean {
  const v = process.env[name];
  if (v === undefined || v === "") return fallback;
  return /^(1|true|yes|on)$/i.test(v.trim());
}

/** Parse a "provider:model" string. Defaults provider to openai. */
export function parseModel(raw: string, fallbackProvider: Provider = "openai"): ModelRef {
  const trimmed = raw.trim();
  const idx = trimmed.indexOf(":");
  if (idx === -1) {
    return { provider: fallbackProvider, model: trimmed, raw: trimmed };
  }
  const provider = trimmed.slice(0, idx).toLowerCase();
  const model = trimmed.slice(idx + 1);
  const p: Provider = provider === "gemini" ? "gemini" : "openai";
  return { provider: p, model, raw: trimmed };
}

export interface Config {
  port: number;
  host: string;
  tlsCert: string;
  tlsKey: string;
  insecureHttp: boolean;

  openaiApiKey: string;
  geminiApiKey: string;

  sttModel: ModelRef;
  sttLanguage: string;
  directorModel: ModelRef;
  dialogueModel: ModelRef;
  ttsModel: ModelRef;

  geminiDirectorModel: ModelRef;
  geminiDialogueModel: ModelRef;
  geminiThinkingLevel: string;

  maxNpcChain: number;
  bargeIn: boolean;

  vadThreshold: number;
  vadPrefixPaddingMs: number;
  vadSilenceMs: number;

  audioSampleRate: number;
  micFrameMs: number;
  micFrameMsFallback: number;
  playbackPrefillMs: number;
  playbackMaxBufferMs: number;

  ttsSegmentMode: string;
  ttsFirstChunkMinWords: number;
  ttsFirstChunkMaxWords: number;
  ttsLaterChunkMaxWords: number;
  ttsMaxWaitForFirstChunkMs: number;
  ttsAllowCommaBoundary: boolean;
  ttsAllowDashBoundary: boolean;
  ttsAppendTrailingSpace: boolean;

  speculativeDirector: boolean;
  speculativeDialogue: boolean;
  speculativeMinWordsDirector: number;
  speculativeMinWordsDialogue: number;
  speculativeSimilarityThreshold: number;
}

let cached: Config | null = null;

export function loadConfig(): Config {
  if (cached) return cached;
  cached = {
    port: num("PORT", 8787),
    host: str("HOST", "0.0.0.0"),
    tlsCert: str("TLS_CERT", ""),
    tlsKey: str("TLS_KEY", ""),
    insecureHttp: bool("INSECURE_HTTP", false),

    openaiApiKey: str("OPENAI_API_KEY", ""),
    geminiApiKey: str("GEMINI_API_KEY", ""),

    sttModel: parseModel(str("STT_MODEL", "openai:gpt-4o-mini-transcribe")),
    sttLanguage: str("STT_LANGUAGE", "en"),
    directorModel: parseModel(str("DIRECTOR_MODEL", "openai:gpt-4.1-nano")),
    dialogueModel: parseModel(str("DIALOGUE_MODEL", "openai:gpt-4.1-mini")),
    ttsModel: parseModel(str("TTS_MODEL", "openai:gpt-4o-mini-tts")),

    geminiDirectorModel: parseModel(
      str("GEMINI_DIRECTOR_MODEL", "gemini:gemini-3.1-flash-lite"),
      "gemini",
    ),
    geminiDialogueModel: parseModel(
      str("GEMINI_DIALOGUE_MODEL", "gemini:gemini-3.5-flash"),
      "gemini",
    ),
    geminiThinkingLevel: str("GEMINI_THINKING_LEVEL", "MINIMAL"),

    maxNpcChain: num("MAX_NPC_CHAIN", 3),
    bargeIn: bool("BARGE_IN", true),

    vadThreshold: num("VAD_THRESHOLD", 0.5),
    vadPrefixPaddingMs: num("VAD_PREFIX_PADDING_MS", 120),
    vadSilenceMs: num("VAD_SILENCE_MS", 250),

    audioSampleRate: num("AUDIO_SAMPLE_RATE", 24000),
    micFrameMs: num("MIC_FRAME_MS", 20),
    micFrameMsFallback: num("MIC_FRAME_MS_FALLBACK", 40),
    playbackPrefillMs: num("PLAYBACK_PREFILL_MS", 40),
    playbackMaxBufferMs: num("PLAYBACK_MAX_BUFFER_MS", 120),

    ttsSegmentMode: str("TTS_SEGMENT_MODE", "stable_phrase"),
    ttsFirstChunkMinWords: num("TTS_FIRST_CHUNK_MIN_WORDS", 1),
    ttsFirstChunkMaxWords: num("TTS_FIRST_CHUNK_MAX_WORDS", 8),
    ttsLaterChunkMaxWords: num("TTS_LATER_CHUNK_MAX_WORDS", 16),
    ttsMaxWaitForFirstChunkMs: num("TTS_MAX_WAIT_FOR_FIRST_CHUNK_MS", 250),
    ttsAllowCommaBoundary: bool("TTS_ALLOW_COMMA_BOUNDARY", true),
    ttsAllowDashBoundary: bool("TTS_ALLOW_DASH_BOUNDARY", true),
    ttsAppendTrailingSpace: bool("TTS_APPEND_TRAILING_SPACE", true),

    speculativeDirector: bool("SPECULATIVE_DIRECTOR", true),
    speculativeDialogue: bool("SPECULATIVE_DIALOGUE", true),
    speculativeMinWordsDirector: num("SPECULATIVE_MIN_WORDS_DIRECTOR", 3),
    speculativeMinWordsDialogue: num("SPECULATIVE_MIN_WORDS_DIALOGUE", 6),
    speculativeSimilarityThreshold: num("SPECULATIVE_SIMILARITY_THRESHOLD", 0.82),
  };
  return cached;
}

export function audioConfig(cfg: Config) {
  return {
    sampleRate: cfg.audioSampleRate,
    micFrameMs: cfg.micFrameMs,
    micFrameMsFallback: cfg.micFrameMsFallback,
    playbackPrefillMs: cfg.playbackPrefillMs,
    playbackMaxBufferMs: cfg.playbackMaxBufferMs,
  };
}
