import { loadConfig } from "../config.ts";
import { openaiKey } from "./clients.ts";

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
 * HTTP stream for barge-in.
 *
 * WORKAROUND: append a trailing space to the input so the current model snapshot
 * does not truncate the final word.
 */
export async function streamTts(req: TtsRequest): Promise<void> {
  const cfg = loadConfig();
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
