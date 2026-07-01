import type { WebSocket, RawData } from "ws";
import type { IncomingMessage } from "node:http";
import { z } from "zod";
import { nanoid } from "nanoid";
import { loadConfig, audioConfig } from "./config.ts";
import { log, errMsg } from "./log.ts";
import { VOICES, type HumanFloorMode, type Role, type ServerToClient } from "../shared/types.ts";
import { Scene, type ClientRecord, type SceneClients } from "./scene.ts";

interface Conn extends ClientRecord {
  ws: WebSocket;
}

const zCharacterInit = z.object({
  name: z.string(),
  persona: z.string().default(""),
  voice: z.string().default("alloy"),
  aliases: z.array(z.string()).default([]),
  secret: z.string().optional(),
});

const zClientToServer = z.discriminatedUnion("t", [
  z.object({
    t: z.literal("createScene"),
    setting: z.string().default(""),
    characters: z.array(zCharacterInit).default([]),
  }),
  z.object({ t: z.literal("claimCharacter"), characterId: z.string(), label: z.string().optional() }),
  z.object({ t: z.literal("releaseCharacter") }),
  z.object({ t: z.literal("becomeHost"), label: z.string().optional() }),
  z.object({ t: z.literal("enterLobby") }),
  z.object({ t: z.literal("startScene") }),
  z.object({ t: z.literal("stopScene") }),
  z.object({ t: z.literal("resetScene") }),
  z.object({ t: z.literal("humanText"), text: z.string() }),
  z.object({ t: z.literal("injectLine"), characterId: z.string(), text: z.string() }),
  z.object({
    t: z.literal("setFloor"),
    mode: z.enum(["direct", "device_directed", "device_mediated"]),
    action: z.string().optional(),
  }),
  z.object({ t: z.literal("setAudioMode"), mode: z.enum(["aec", "legacy"]) }),
  z.object({ t: z.literal("audioStarted") }),
  z.object({ t: z.literal("audioStopped") }),
  z.object({ t: z.literal("ping") }),
]);

function toBuffer(data: RawData, isBinary: boolean): Buffer | null {
  if (!isBinary) return null;
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  return null;
}

export class Hub implements SceneClients {
  private conns = new Map<string, Conn>();
  private scene: Scene;

  constructor() {
    this.scene = new Scene(this);
  }

  /** Set the H4 floor mode from an external source (default: the H4 REST bridge). */
  setFloor(mode: HumanFloorMode, action?: string, source: "h4" | "web" = "h4"): void {
    this.scene.setFloorMode(mode, action, source);
  }

  /** Record an H4 heartbeat (the device's periodic /api/h4/ping). */
  noteH4Ping(): void {
    this.scene.noteH4Seen();
  }

  // ---- SceneClients implementation ----------------------------------------

  send(clientId: string, msg: ServerToClient): void {
    const c = this.conns.get(clientId);
    if (c && c.ws.readyState === c.ws.OPEN) {
      c.ws.send(JSON.stringify(msg));
    }
  }

  sendBinary(clientId: string, data: Buffer): void {
    const c = this.conns.get(clientId);
    if (c && c.ws.readyState === c.ws.OPEN) {
      c.ws.send(data, { binary: true });
    }
  }

  broadcast(msg: ServerToClient): void {
    const payload = JSON.stringify(msg);
    for (const c of this.conns.values()) {
      if (c.ws.readyState === c.ws.OPEN) c.ws.send(payload);
    }
  }

  clients(): ClientRecord[] {
    return [...this.conns.values()].map((c) => ({
      id: c.id,
      role: c.role,
      label: c.label,
      characterId: c.characterId,
    }));
  }

  getClient(clientId: string): ClientRecord | undefined {
    const c = this.conns.get(clientId);
    if (!c) return undefined;
    return { id: c.id, role: c.role, label: c.label, characterId: c.characterId };
  }

  setClientRole(clientId: string, role: Role, characterId: string | null): void {
    const c = this.conns.get(clientId);
    if (c) {
      c.role = role;
      c.characterId = characterId;
    }
  }

  setClientLabel(clientId: string, label: string): void {
    const c = this.conns.get(clientId);
    if (c) c.label = label;
  }

  // ---- Connection lifecycle -----------------------------------------------

  handleConnection(ws: WebSocket, req: IncomingMessage): void {
    try {
      req.socket.setNoDelay(true);
    } catch {
      /* ignore */
    }

    const id = nanoid(10);
    const label = `Guest-${id.slice(0, 4)}`;
    const conn: Conn = { id, ws, role: "lobby", label, characterId: null };
    this.conns.set(id, conn);
    log.info(`client connected ${id} (${this.conns.size} total)`);

    const cfg = loadConfig();
    this.send(id, {
      t: "welcome",
      clientId: id,
      audio: audioConfig(cfg),
      voices: [...VOICES],
    });
    this.send(id, { t: "role", role: "lobby", characterId: null });
    this.send(id, { t: "scene", scene: this.scene.getState() });

    ws.on("message", (data: RawData, isBinary: boolean) => {
      if (isBinary) {
        const buf = toBuffer(data, true);
        if (buf) this.scene.onMicFrame(id, buf);
        return;
      }
      this.onTextMessage(id, data.toString());
    });

    ws.on("close", () => {
      this.conns.delete(id);
      this.scene.onClientDisconnected(id);
      log.info(`client disconnected ${id} (${this.conns.size} total)`);
    });

    ws.on("error", (err) => {
      log.warn(`ws error ${id}: ${errMsg(err)}`);
    });
  }

  private onTextMessage(id: string, raw: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }
    const result = zClientToServer.safeParse(parsed);
    if (!result.success) {
      this.send(id, { t: "error", message: "Invalid message", scope: "protocol" });
      return;
    }
    const msg = result.data;
    try {
      switch (msg.t) {
        case "ping":
          this.send(id, { t: "pong" });
          break;
        case "becomeHost":
          this.scene.handleBecomeHost(id, msg.label);
          break;
        case "enterLobby":
          this.scene.handleEnterLobby(id);
          break;
        case "createScene":
          this.scene.handleCreateScene(id, msg.setting, msg.characters);
          break;
        case "claimCharacter":
          this.scene.handleClaim(id, msg.characterId, msg.label);
          break;
        case "releaseCharacter":
          this.scene.handleRelease(id);
          break;
        case "startScene":
          this.scene.handleStart(id);
          break;
        case "stopScene":
          this.scene.handleStop(id);
          break;
        case "resetScene":
          this.scene.handleReset(id);
          break;
        case "humanText":
          this.scene.handleHumanText(id, msg.text);
          break;
        case "injectLine":
          this.scene.handleInjectLine(id, msg.characterId, msg.text);
          break;
        case "setFloor":
          // Web fallback remote (not the physical H4).
          this.scene.setFloorMode(msg.mode, msg.action, "web");
          break;
        case "setAudioMode":
          this.scene.setAudioMode(msg.mode);
          break;
        case "audioStarted":
          this.scene.onAudioStarted(id);
          break;
        case "audioStopped":
          this.scene.onAudioStopped(id);
          break;
        default:
          break;
      }
    } catch (e) {
      // Provider/runtime errors must never crash the server.
      log.error("dispatch error:", errMsg(e));
      this.send(id, { t: "error", message: errMsg(e), scope: "server" });
    }
  }
}
