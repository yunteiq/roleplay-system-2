import { loadConfig } from "../config.ts";
import { gemini, openaiKey } from "./clients.ts";

export interface TtsRequest {
  text: string;
  voice: string;
  instructions?: string;
  signal: AbortSignal;
  /** Called with raw PCM16 bytes as they stream in. */
  onChunk: (pcm: Buffer) => void;
}

async function safeText(resp: Response): Promise<string> {
  try {
    return (await resp.text()).slice(0, 300);
  } catch {
    return "";
  }
}

/**
 * Stream TTS as raw 24kHz 16-bit mono PCM. Chunks are forwarded as soon as they
 * arrive (no waiting for the full response). Aborting the signal cancels the
 * stream for barge-in. The provider is chosen from TTS_MODEL ("openai:…" or
 * "gemini:…"); both emit PCM16 @ the configured sample rate.
 */
export async function streamTts(req: TtsRequest): Promise<void> {
  const cfg = loadConfig();
  return cfg.ttsModel.provider === "gemini" ? geminiTts(req) : openaiTts(req);
}

// ---------------------------------------------------------------------------
// OpenAI (/v1/audio/speech, response_format=pcm)
// ---------------------------------------------------------------------------

async function openaiTts(req: TtsRequest): Promise<void> {
  const cfg = loadConfig();
  // WORKAROUND: append a trailing space so the current OpenAI model snapshot
  // does not truncate the final word.
  const input = cfg.ttsAppendTrailingSpace ? `${req.text} ` : req.text;

  const body: Record<string, unknown> = {
    model: cfg.ttsModel.model,
    voice: req.voice,
    input,
    response_format: "pcm",
  };
  if (req.instructions) body.instructions = req.instructions;

  const resp = await fetch("https://api.openai.com/v1/audio/speech", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${openaiKey()}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    signal: req.signal,
  });

  if (!resp.ok || !resp.body) {
    throw new Error(`TTS HTTP ${resp.status}: ${await safeText(resp)}`);
  }

  const reader = resp.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value && value.byteLength) req.onChunk(Buffer.from(value));
  }
}

// ---------------------------------------------------------------------------
// Gemini (generateContentStream with AUDIO modality → inline PCM16 @ 24kHz)
// ---------------------------------------------------------------------------

/** Gemini prebuilt voice names (a representative subset). */
const GEMINI_VOICES = new Set([
  "Zephyr", "Puck", "Charon", "Kore", "Fenrir", "Leda", "Orus", "Aoede",
  "Callirrhoe", "Autonoe", "Enceladus", "Iapetus", "Umbriel", "Algieba",
  "Despina", "Erinome", "Algenib", "Rasalgethi", "Laomedeia", "Achernar",
  "Alnilam", "Schedar", "Gacrux", "Pulcherrima", "Achird", "Zubenelgenubi",
  "Vindemiatrix", "Sadachbia", "Sadaltager", "Sulafat",
]);

/** Map the OpenAI voice names used across the app onto Gemini prebuilt voices. */
const OPENAI_TO_GEMINI_VOICE: Record<string, string> = {
  alloy: "Zephyr",
  ash: "Charon",
  ballad: "Enceladus",
  coral: "Aoede",
  echo: "Puck",
  fable: "Fenrir",
  nova: "Leda",
  onyx: "Orus",
  sage: "Kore",
  shimmer: "Autonoe",
  verse: "Algieba",
};

/** Resolve a requested voice to a valid Gemini prebuilt voice. */
function geminiVoice(voice: string): string {
  if (GEMINI_VOICES.has(voice)) return voice;
  return OPENAI_TO_GEMINI_VOICE[voice.trim().toLowerCase()] ?? "Kore";
}

async function geminiTts(req: TtsRequest): Promise<void> {
  const cfg = loadConfig();
  const ai = gemini();
  // Note: the OpenAI-style `instructions` string is intentionally dropped here —
  // Gemini would speak it aloud. Voice/character is conveyed via the voice name.
  const stream = await ai.models.generateContentStream({
    model: cfg.ttsModel.model,
    contents: req.text,
    config: {
      responseModalities: ["AUDIO"],
      speechConfig: {
        voiceConfig: { prebuiltVoiceConfig: { voiceName: geminiVoice(req.voice) } },
      },
      abortSignal: req.signal,
    },
  });

  for await (const chunk of stream) {
    const parts = chunk.candidates?.[0]?.content?.parts ?? [];
    for (const part of parts) {
      const data = part.inlineData?.data;
      if (data) req.onChunk(Buffer.from(data, "base64"));
    }
  }
}
