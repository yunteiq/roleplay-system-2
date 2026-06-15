// Main-thread controller for the capture-processor worklet node.
// Captures the mic continuously (full-duplex; never gated by playback) and emits
// Int16 frames + RMS levels. The app decides when to forward frames upstream.

export interface CaptureCallbacks {
  onFrame: (pcm: ArrayBuffer) => void;
  onLevel: (rms: number) => void;
}

export class Capture {
  private node: AudioWorkletNode | null = null;
  private stream: MediaStream | null = null;
  private source: MediaStreamAudioSourceNode | null = null;

  async start(ctx: AudioContext, frameSamples: number, cb: CaptureCallbacks): Promise<void> {
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        channelCount: 1,
      },
    });
    this.source = ctx.createMediaStreamSource(this.stream);
    this.node = new AudioWorkletNode(ctx, "capture-processor", {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
      processorOptions: { frameSamples },
    });
    this.node.port.onmessage = (e: MessageEvent) => {
      const d = e.data as { pcm: ArrayBuffer; rms: number };
      cb.onLevel(d.rms);
      cb.onFrame(d.pcm);
    };
    this.source.connect(this.node);
    // Connect to destination so the node is pulled; it outputs silence.
    this.node.connect(ctx.destination);
  }

  stop(): void {
    this.stream?.getTracks().forEach((t) => t.stop());
    this.source?.disconnect();
    this.node?.disconnect();
    this.stream = null;
    this.source = null;
    this.node = null;
  }
}
