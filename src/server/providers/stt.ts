import { WebSocket } from "ws";
import { loadConfig } from "../config.ts";
import { openaiKey } from "./clients.ts";
import { log, errMsg } from "../log.ts";

const REALTIME_URL = "wss://api.openai.com/v1/realtime?intent=transcription";
const READY_FALLBACK_MS = 1500;
const RECONNECT_MS = 600;
const MAX_PREBUFFER_BYTES = 24000 * 2 * 2; // ~2s of 24kHz PCM16

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

  constructor(private handlers: SttHandlers) {}

  start(): void {
    this.closed = false;
    this.connect();
  }

  private connect(): void {
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
    const msg = {
      type: "session.update",
      session: {
        type: "transcription",
        audio: {
          input: {
            format: { type: "audio/pcm", rate: cfg.audioSampleRate },
            transcription: {
              model: cfg.sttModel.model,
              language: cfg.sttLanguage,
            },
            turn_detection: {
              type: "server_vad",
              threshold: cfg.vadThreshold,
              prefix_padding_ms: cfg.vadPrefixPaddingMs,
              silence_duration_ms: cfg.vadSilenceMs,
            },
          },
        },
      },
    };
    this.sendJson(msg);
  }

  private markReady(): void {
    if (this.ready) return;
    this.ready = true;
    if (this.readyTimer) {
      clearTimeout(this.readyTimer);
      this.readyTimer = null;
    }
    // Flush any audio captured before the session was configured.
    if (this.prebuffer.length && this.ws?.readyState === WebSocket.OPEN) {
      for (const buf of this.prebuffer) this.sendAppend(buf);
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
    this.sendAppend(buf);
  }

  private sendAppend(buf: Buffer): void {
    this.sendJson({ type: "input_audio_buffer.append", audio: buf.toString("base64") });
  }

  /** Drop any pending input audio (used on reset). */
  clearInput(): void {
    this.prebuffer = [];
    this.prebufferBytes = 0;
    this.partial = "";
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
