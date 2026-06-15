// Main-thread controller for the playback-processor worklet node.
// Streams TTS PCM into a gapless ring buffer; supports immediate stop+clear.

export class Playback {
  private node: AudioWorkletNode | null = null;

  init(ctx: AudioContext, prefillMs: number): void {
    if (this.node) return;
    const prefillSamples = Math.round((ctx.sampleRate * prefillMs) / 1000);
    this.node = new AudioWorkletNode(ctx, "playback-processor", {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [1],
      processorOptions: {
        prefillSamples,
        hardCapSamples: Math.round(ctx.sampleRate * 30),
      },
    });
    this.node.connect(ctx.destination);
  }

  /** Enqueue a chunk of raw PCM16 bytes for immediate playback. */
  push(pcm: ArrayBuffer): void {
    if (!this.node) return;
    this.node.port.postMessage({ type: "push", pcm }, [pcm]);
  }

  /** Stop playback and drop all queued-but-unplayed PCM (barge-in). */
  stop(): void {
    this.node?.port.postMessage({ type: "clear" });
  }
}
