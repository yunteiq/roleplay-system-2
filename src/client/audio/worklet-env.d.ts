// Ambient declarations for the AudioWorkletGlobalScope, which is not covered by
// lib.dom. These globals only exist inside the worklet bundle at runtime.

declare class AudioWorkletProcessor {
  readonly port: MessagePort;
  constructor(options?: unknown);
}

declare function registerProcessor(
  name: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ctor: new (...args: any[]) => AudioWorkletProcessor,
): void;

declare const sampleRate: number;
declare const currentTime: number;
