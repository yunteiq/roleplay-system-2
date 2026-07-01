import { WebSocket } from "ws";
import { loadConfig } from "../config.ts";
import { openaiKey } from "./clients.ts";
import { log, errMsg } from "../log.ts";

const REALTIME_URL = "wss://api.openai.com/v1/realtime?intent=transcription";
const READY_FALLBACK_MS = 1500;
const RECONNECT_MS = 600;
const MAX_PREBUFFER_BYTES = 24000 * 2 * 2; // ~2s of 24kHz PCM16
/** Manual VAD: voiced audio required to declare speech onset. Doubles as the
 *  floor for a committed segment so it clears the API's minimum-commit size. */
const VAD_ONSET_MS = 120;

/** Normalized (0..1) RMS amplitude of a PCM16 little-endian mono frame. */
function frameRms(buf: Buffer): number {
  const n = buf.length >> 1;
  if (n === 0) return 0;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const s = buf.readInt16LE(i << 1);
    sum += s * s;
  }
  return Math.sqrt(sum / n) / 32768;
}

/** Duration in ms of a PCM16 mono buffer at the given sample rate. */
function frameMs(buf: Buffer, sampleRate: number): number {
  return ((buf.length >> 1) / sampleRate) * 1000;
}

export interface SttHandlers {
  onReady?: () => void;
  onSpeechStarted?: () => void;
  onSpeechStopped?: () => void;
  onPartial?: (text: string) => void;
  onFinal?: (text: string) => void;
  onError?: (message: string) => void;
}

/**
 * Streaming STT over the OpenAI Realtime transcription API (GA format).
 *
 * Critical details to avoid silent failures:
 *  - connect to wss://api.openai.com/v1/realtime?intent=transcription
 *  - send ONLY the Authorization header (no OpenAI-Beta header)
 *  - first message is the GA session.update with session.type "transcription"
 *    and audio.input.{format,transcription,turn_detection}
 */
export class SttSession {
  private ws: WebSocket | null = null;
  private ready = false;
  private closed = false;
  private readyTimer: NodeJS.Timeout | null = null;
  private prebuffer: Buffer[] = [];
  private prebufferBytes = 0;
  private partial = "";

  // Manual VAD state (used only when the model lacks server turn detection, e.g.
  // gpt-realtime-whisper): the server detects speech edges by energy and commits
  // the audio buffer to trigger each transcription.
  private readonly serverVad: boolean;
  private readonly sampleRate: number;
  private readonly energyThreshold: number;
  private readonly silenceLimitMs: number;
  private readonly preRollLimitMs: number;
  private speaking = false;
  private silenceMs = 0;
  private voicedRunMs = 0;
  private preRoll: Buffer[] = [];
  private preRollMs = 0;

  constructor(private handlers: SttHandlers) {
    const cfg = loadConfig();
    this.serverVad = cfg.sttServerVad;
    this.sampleRate = cfg.audioSampleRate;
    this.energyThreshold = cfg.vadEnergyThreshold;
    this.silenceLimitMs = cfg.vadSilenceMs;
    this.preRollLimitMs = cfg.vadPrefixPaddingMs;
    log.info(
      `STT: ${cfg.sttModel.raw} — ${
        this.serverVad ? "server VAD" : `manual VAD (energy ≥ ${this.energyThreshold})`
      }`,
    );
  }

  start(): void {
    this.closed = false;
    this.connect();
  }

  private connect(): void {
    this.resetVad();
    let key: string;
    try {
      key = openaiKey();
    } catch (e) {
      this.handlers.onError?.(errMsg(e));
      return;
    }

    const ws = new WebSocket(REALTIME_URL, {
      headers: { Authorization: `Bearer ${key}` },
      perMessageDeflate: false,
    });
    this.ws = ws;
    this.ready = false;

    ws.on("open", () => {
      this.sendSessionUpdate();
      // Fallback in case the readiness event name changes: flush after a delay.
      this.readyTimer = setTimeout(() => {
        if (!this.ready) {
          log.warn("STT: no session.created/updated yet; flushing prebuffer anyway");
          this.markReady();
        }
      }, READY_FALLBACK_MS);
    });

    ws.on("message", (data: Buffer, isBinary: boolean) => {
      if (isBinary) return;
      this.onMessage(data.toString("utf8"));
    });

    ws.on("error", (err) => {
      this.handlers.onError?.(`STT socket error: ${errMsg(err)}`);
    });

    ws.on("close", () => {
      this.ready = false;
      if (this.readyTimer) clearTimeout(this.readyTimer);
      if (!this.closed) {
        log.warn("STT: socket closed, reconnecting…");
        setTimeout(() => {
          if (!this.closed) this.connect();
        }, RECONNECT_MS);
      }
    });
  }

  private sendSessionUpdate(): void {
    const cfg = loadConfig();
    const transcription: Record<string, unknown> = {
      model: cfg.sttModel.model,
      language: cfg.sttLanguage,
    };
    const input: Record<string, unknown> = {
      format: { type: "audio/pcm", rate: cfg.audioSampleRate },
      transcription,
    };
    if (this.serverVad) {
      input.turn_detection = {
        type: "server_vad",
        threshold: cfg.vadThreshold,
        prefix_padding_ms: cfg.vadPrefixPaddingMs,
        silence_duration_ms: cfg.vadSilenceMs,
      };
    } else {
      // Whisper-style streaming model: no server VAD. Disable it explicitly and
      // request low-latency deltas; we segment turns ourselves (see feedVad).
      input.turn_detection = null;
      transcription.delay = "low";
    }
    this.sendJson({ type: "session.update", session: { type: "transcription", audio: { input } } });
  }

  private markReady(): void {
    if (this.ready) return;
    this.ready = true;
    if (this.readyTimer) {
      clearTimeout(this.readyTimer);
      this.readyTimer = null;
    }
    // Flush any audio captured before the session was configured. With server
    // VAD, stream it straight through; otherwise route it through our VAD so the
    // boundaries/commit are handled consistently.
    if (this.prebuffer.length && this.ws?.readyState === WebSocket.OPEN) {
      for (const buf of this.prebuffer) {
        if (this.serverVad) this.sendAppend(buf);
        else this.feedVad(buf);
      }
    }
    this.prebuffer = [];
    this.prebufferBytes = 0;
    this.handlers.onReady?.();
  }

  private onMessage(raw: string): void {
    let evt: { type?: string; [k: string]: unknown };
    try {
      evt = JSON.parse(raw);
    } catch {
      return;
    }
    switch (evt.type) {
      case "session.created":
      case "session.updated":
        this.markReady();
        break;
      case "input_audio_buffer.speech_started":
        this.partial = "";
        this.handlers.onSpeechStarted?.();
        break;
      case "input_audio_buffer.speech_stopped":
        this.handlers.onSpeechStopped?.();
        break;
      case "conversation.item.input_audio_transcription.delta": {
        const delta = typeof evt.delta === "string" ? evt.delta : "";
        if (delta) {
          this.partial += delta;
          this.handlers.onPartial?.(this.partial);
        }
        break;
      }
      case "conversation.item.input_audio_transcription.completed": {
        const transcript =
          typeof evt.transcript === "string" ? evt.transcript : this.partial;
        this.partial = "";
        this.handlers.onFinal?.(transcript.trim());
        break;
      }
      case "conversation.item.input_audio_transcription.failed": {
        const err = (evt.error as { message?: string } | undefined)?.message;
        this.handlers.onError?.(`STT transcription failed: ${err ?? "unknown"}`);
        break;
      }
      case "error": {
        const err = (evt.error as { message?: string } | undefined)?.message;
        this.handlers.onError?.(`STT error: ${err ?? raw.slice(0, 200)}`);
        break;
      }
      default:
        break;
    }
  }

  /** Append a chunk of raw PCM16 mono audio. Buffered until the session is ready. */
  appendPcm(buf: Buffer): void {
    if (this.closed) return;
    if (!this.ready || this.ws?.readyState !== WebSocket.OPEN) {
      this.prebuffer.push(buf);
      this.prebufferBytes += buf.byteLength;
      while (this.prebufferBytes > MAX_PREBUFFER_BYTES && this.prebuffer.length > 1) {
        const dropped = this.prebuffer.shift();
        if (dropped) this.prebufferBytes -= dropped.byteLength;
      }
      return;
    }
    if (this.serverVad) this.sendAppend(buf);
    else this.feedVad(buf);
  }

  /**
   * Energy-gated VAD for models without server turn detection. Detects speech
   * edges, streams only voiced audio (plus a short pre-roll so the onset isn't
   * clipped), and commits the buffer on end-of-speech to transcribe the
   * utterance. Drives the same onSpeechStarted/onSpeechStopped handlers the
   * server-VAD path gets from the API.
   */
  private feedVad(buf: Buffer): void {
    const ms = frameMs(buf, this.sampleRate);
    const rms = frameRms(buf);
    const voiced = rms >= this.energyThreshold;

    if (!this.speaking) {
      // Retain recent audio so a confirmed onset can be sent with its lead-in.
      this.preRoll.push(buf);
      this.preRollMs += ms;
      const cap = this.preRollLimitMs + VAD_ONSET_MS;
      while (this.preRollMs > cap && this.preRoll.length > 1) {
        const dropped = this.preRoll.shift();
        if (dropped) this.preRollMs -= frameMs(dropped, this.sampleRate);
      }
      if (!voiced) {
        this.voicedRunMs = 0;
        return;
      }
      this.voicedRunMs += ms;
      if (this.voicedRunMs < VAD_ONSET_MS) return;
      // Confirmed speech onset: open the turn and flush the buffered lead-in.
      this.speaking = true;
      this.silenceMs = 0;
      this.voicedRunMs = 0;
      this.partial = "";
      log.pipe(`stt: speech start (rms ${rms.toFixed(3)})`);
      this.handlers.onSpeechStarted?.();
      for (const p of this.preRoll) this.sendAppend(p);
      this.preRoll = [];
      this.preRollMs = 0;
      return;
    }

    this.sendAppend(buf);
    if (voiced) {
      this.silenceMs = 0;
      return;
    }
    this.silenceMs += ms;
    if (this.silenceMs >= this.silenceLimitMs) {
      // End of utterance: commit so the API transcribes and emits `completed`.
      this.speaking = false;
      this.silenceMs = 0;
      this.handlers.onSpeechStopped?.();
      log.pipe("stt: commit utterance");
      this.sendJson({ type: "input_audio_buffer.commit" });
    }
  }

  private resetVad(): void {
    this.speaking = false;
    this.silenceMs = 0;
    this.voicedRunMs = 0;
    this.preRoll = [];
    this.preRollMs = 0;
  }

  private sendAppend(buf: Buffer): void {
    this.sendJson({ type: "input_audio_buffer.append", audio: buf.toString("base64") });
  }

  /** Drop any pending input audio (used on reset). */
  clearInput(): void {
    this.prebuffer = [];
    this.prebufferBytes = 0;
    this.partial = "";
    this.resetVad();
    if (this.ready && this.ws?.readyState === WebSocket.OPEN) {
      this.sendJson({ type: "input_audio_buffer.clear" });
    }
  }

  private sendJson(obj: unknown): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(obj));
    }
  }

  stop(): void {
    this.closed = true;
    if (this.readyTimer) clearTimeout(this.readyTimer);
    try {
      this.ws?.close();
    } catch {
      /* ignore */
    }
    this.ws = null;
    this.ready = false;
  }
}
