// Main-thread controller for the playback-processor worklet node.
// Streams TTS PCM into a gapless ring buffer; supports immediate stop+clear.
//
// Two echo strategies, switchable for A/B testing:
//   legacy — connect straight to ctx.destination. The browser's mic AEC cannot
//            "see" this Web Audio output, so the server runs half-duplex (it
//            gates STT while audio plays).
//   aec    — route playback into a MediaStream and pump it through a local
//            RTCPeerConnection loopback, then play the received stream from an
//            <audio> element. Audio rendered from a WebRTC stream IS part of the
//            browser's AEC render reference, so getUserMedia({echoCancellation})
//            subtracts the TTS from the mic — enabling full-duplex barge-in.
//            (Reliable on Chromium; falls back to direct output if unavailable.)

export interface PlaybackOptions {
  aec?: boolean;
  onStarted?: () => void;
  onDrained?: () => void;
}

export class Playback {
  private node: AudioWorkletNode | null = null;
  private msDest: MediaStreamAudioDestinationNode | null = null;
  private audioEl: HTMLAudioElement | null = null;
  private pcSend: RTCPeerConnection | null = null;
  private pcRecv: RTCPeerConnection | null = null;

  async init(ctx: AudioContext, prefillMs: number, opts?: PlaybackOptions): Promise<void> {
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
    this.node.port.onmessage = (e: MessageEvent) => {
      const d = e.data as { type?: string };
      if (d?.type === "started") opts?.onStarted?.();
      else if (d?.type === "drained") opts?.onDrained?.();
    };

    if (opts?.aec) {
      try {
        await this.routeThroughLoopback(ctx);
        return;
      } catch (e) {
        console.warn("[playback] AEC loopback unavailable; using direct output", e);
        this.teardownLoopback();
      }
    }
    this.node.connect(ctx.destination);
  }

  /** Route playback through a same-machine WebRTC loopback so the rendered audio
   *  becomes part of the browser's echo-cancellation reference signal. */
  private async routeThroughLoopback(ctx: AudioContext): Promise<void> {
    if (typeof RTCPeerConnection === "undefined") {
      throw new Error("RTCPeerConnection unavailable");
    }
    const node = this.node;
    if (!node) throw new Error("playback node not initialized");

    const msDest = ctx.createMediaStreamDestination();
    node.connect(msDest);
    this.msDest = msDest;

    const send = new RTCPeerConnection();
    const recv = new RTCPeerConnection();
    this.pcSend = send;
    this.pcRecv = recv;

    send.onicecandidate = (e) => {
      if (e.candidate) void recv.addIceCandidate(e.candidate);
    };
    recv.onicecandidate = (e) => {
      if (e.candidate) void send.addIceCandidate(e.candidate);
    };

    const outStream = new MediaStream();
    recv.ontrack = (e) => outStream.addTrack(e.track);

    for (const track of msDest.stream.getAudioTracks()) {
      send.addTrack(track, msDest.stream);
    }

    const offer = await send.createOffer();
    await send.setLocalDescription(offer);
    await recv.setRemoteDescription(offer);
    const answer = await recv.createAnswer();
    await recv.setLocalDescription(answer);
    await send.setRemoteDescription(answer);

    const el = new Audio();
    el.autoplay = true;
    el.srcObject = outStream;
    this.audioEl = el;
    // Triggered from the same user gesture that started the AudioContext, so
    // autoplay is permitted; ignore a rejection rather than failing the route.
    await el.play().catch(() => {});
  }

  private teardownLoopback(): void {
    if (this.audioEl) {
      this.audioEl.srcObject = null;
      this.audioEl = null;
    }
    this.pcSend?.close();
    this.pcRecv?.close();
    this.pcSend = null;
    this.pcRecv = null;
    this.msDest = null;
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
