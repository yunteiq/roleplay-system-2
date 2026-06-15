import type { ClientToServer, ServerToClient } from "../shared/types.ts";

type JsonHandler = (msg: ServerToClient) => void;
type BinaryHandler = (buf: ArrayBuffer) => void;
type VoidHandler = () => void;

export class WS {
  private ws: WebSocket | null = null;
  private jsonH: JsonHandler = () => {};
  private binH: BinaryHandler = () => {};
  private openH: VoidHandler = () => {};
  private closeH: VoidHandler = () => {};
  private outQueue: string[] = [];
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(private url: string) {}

  onJson(h: JsonHandler): void {
    this.jsonH = h;
  }
  onBinary(h: BinaryHandler): void {
    this.binH = h;
  }
  onOpen(h: VoidHandler): void {
    this.openH = h;
  }
  onClose(h: VoidHandler): void {
    this.closeH = h;
  }

  connect(): void {
    const ws = new WebSocket(this.url);
    ws.binaryType = "arraybuffer";
    this.ws = ws;

    ws.onopen = () => {
      for (const m of this.outQueue) ws.send(m);
      this.outQueue = [];
      this.openH();
    };
    ws.onmessage = (e: MessageEvent) => {
      if (typeof e.data === "string") {
        try {
          this.jsonH(JSON.parse(e.data) as ServerToClient);
        } catch {
          /* ignore malformed */
        }
      } else if (e.data instanceof ArrayBuffer) {
        this.binH(e.data);
      }
    };
    ws.onclose = () => {
      this.closeH();
      this.scheduleReconnect();
    };
    ws.onerror = () => {
      try {
        ws.close();
      } catch {
        /* ignore */
      }
    };
  }

  private scheduleReconnect(): void {
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => this.connect(), 1000);
  }

  sendJson(msg: ClientToServer): void {
    const s = JSON.stringify(msg);
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(s);
    else this.outQueue.push(s);
  }

  sendBinary(buf: ArrayBuffer): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(buf);
  }
}
