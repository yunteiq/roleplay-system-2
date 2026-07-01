// AudioWorklet bundle (separate from the app bundle). Runs in the audio render
// thread. Contains two processors:
//   capture-processor  — emits Int16 frames + RMS from the mic
//   playback-processor — gapless ring-buffer playback of streamed TTS PCM

interface CaptureOptions {
  processorOptions?: { frameSamples?: number };
}

interface PlaybackOptions {
  processorOptions?: { prefillSamples?: number; hardCapSamples?: number };
}

class CaptureProcessor extends AudioWorkletProcessor {
  private frameSamples: number;
  private buf: Float32Array;
  private idx = 0;

  constructor(options?: CaptureOptions) {
    super();
    this.frameSamples = Math.max(64, options?.processorOptions?.frameSamples ?? 480);
    this.buf = new Float32Array(this.frameSamples);
  }

  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    // Output silence so the node stays in the render graph without feedback.
    const out = outputs[0]?.[0];
    if (out) out.fill(0);

    const input = inputs[0];
    const ch = input ? input[0] : undefined;
    if (ch) {
      for (const sample of ch) {
        this.buf[this.idx++] = sample;
        if (this.idx >= this.frameSamples) {
          this.flush();
          this.idx = 0;
        }
      }
    }
    return true;
  }

  private flush(): void {
    const n = this.frameSamples;
    const pcm = new Int16Array(n);
    let sumSq = 0;
    let i = 0;
    for (const raw of this.buf) {
      let s = raw;
      if (s > 1) s = 1;
      else if (s < -1) s = -1;
      pcm[i++] = s < 0 ? s * 0x8000 : s * 0x7fff;
      sumSq += s * s;
    }
    const rms = Math.sqrt(sumSq / n);
    this.port.postMessage({ pcm: pcm.buffer, rms }, [pcm.buffer]);
  }
}

class PlaybackProcessor extends AudioWorkletProcessor {
  private queue: Float32Array[] = [];
  private readOffset = 0;
  private queued = 0;
  private playing = false;
  private prefill: number;
  private hardCap: number;
  // Tracks whether the buffer is idle (empty + already reported). Drives the
  // "started"/"drained" edges: a push out of idle = a new playback session
  // begins; the buffer running dry = the session ends.
  private idle = true;

  constructor(options?: PlaybackOptions) {
    super();
    this.prefill = Math.max(0, options?.processorOptions?.prefillSamples ?? 960);
    this.hardCap = options?.processorOptions?.hardCapSamples ?? 24000 * 30;
    this.port.onmessage = (e: MessageEvent) => {
      const d = e.data as { type: string; pcm?: ArrayBuffer };
      if (d.type === "push" && d.pcm) {
        if (this.idle) {
          // First audio of a new playback session — report that output is starting.
          this.idle = false;
          this.port.postMessage({ type: "started" });
        }
        const count = Math.floor(d.pcm.byteLength / 2);
        const i16 = new Int16Array(d.pcm, 0, count);
        const f = new Float32Array(i16.length);
        for (let i = 0; i < i16.length; i++) f[i] = (i16[i] ?? 0) / 0x8000;
        this.queue.push(f);
        this.queued += f.length;
        while (this.queued > this.hardCap && this.queue.length > 1) {
          const head = this.queue.shift()!;
          this.queued -= head.length - this.readOffset;
          this.readOffset = 0;
        }
      } else if (d.type === "clear") {
        this.queue = [];
        this.readOffset = 0;
        this.queued = 0;
        this.playing = false;
        this.idle = true;
      }
    };
  }

  process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const out = outputs[0]?.[0];
    if (!out) return true;
    const n = out.length;

    if (!this.playing) {
      if (this.queued >= this.prefill && this.queued > 0) {
        this.playing = true;
      } else {
        out.fill(0);
        return true;
      }
    }

    let written = 0;
    while (written < n && this.queue.length) {
      const head = this.queue[0]!;
      const avail = head.length - this.readOffset;
      const need = n - written;
      const take = avail < need ? avail : need;
      for (let i = 0; i < take; i++) out[written + i] = head[this.readOffset + i] ?? 0;
      written += take;
      this.readOffset += take;
      this.queued -= take;
      if (this.readOffset >= head.length) {
        this.queue.shift();
        this.readOffset = 0;
      }
    }
    for (let i = written; i < n; i++) out[i] = 0;

    // Report the moment the ring buffer runs dry (real end of audio output), so
    // the main thread can tell when playback has actually stopped — distinct from
    // when the server merely finished sending. Fires once per drain. `playing`
    // stays true so the next session resumes gaplessly.
    if (this.playing && this.queue.length === 0 && !this.idle) {
      this.idle = true;
      this.port.postMessage({ type: "drained" });
    }
    return true;
  }
}

registerProcessor("capture-processor", CaptureProcessor);
registerProcessor("playback-processor", PlaybackProcessor);
