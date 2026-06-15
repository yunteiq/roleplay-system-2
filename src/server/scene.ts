import { nanoid } from "nanoid";
import type {
  CharacterInit,
  CharacterState,
  ClientInfo,
  Role,
  SceneState,
  ServerToClient,
  Phase,
} from "../shared/types.ts";
import { loadConfig, type Config } from "./config.ts";
import { log, errMsg } from "./log.ts";
import {
  SpeakableChunker,
  countWords,
  matchCharacterByName,
  similarity,
} from "./text.ts";
import { SttSession } from "./providers/stt.ts";
import { runDirector, type DirectorCandidate } from "./providers/director.ts";
import { streamDialogue } from "./providers/dialogue.ts";
import { streamTts } from "./providers/tts.ts";
import { transcriptToLines, type RoledLine } from "./providers/llm.ts";

const MAX_TRANSCRIPT = 100;
const MAX_CONTEXT_LINES = 24;
const MAX_HISTORY_LINES = 12;

/** Minimal view of a connected client that the scene needs. */
export interface ClientRecord {
  id: string;
  role: Role;
  label: string;
  characterId: string | null;
}

/** Outbound interface implemented by the hub. */
export interface SceneClients {
  send(clientId: string, msg: ServerToClient): void;
  sendBinary(clientId: string, data: Buffer): void;
  broadcast(msg: ServerToClient): void;
  clients(): ClientRecord[];
  getClient(clientId: string): ClientRecord | undefined;
  setClientRole(clientId: string, role: Role, characterId: string | null): void;
  setClientLabel(clientId: string, label: string): void;
}

interface ActiveTurn {
  characterId: string;
  clientId: string;
  turnId: string;
  abort: AbortController;
  utteranceId: string | null;
  committed: boolean;
  finished: boolean;
  spoken: string;
  replyRecorded: boolean;
  begun: boolean;
}

interface SpecDialogue {
  uid: string;
  responderId: string;
  transcript: string;
  turn: ActiveTurn;
}

interface SpecDirector {
  uid: string;
  transcript: string;
  abort: AbortController;
  result?: string | null;
}

export class Scene {
  private cfg: Config;
  private scene: SceneState;
  private stt: SttSession | null = null;

  private active: ActiveTurn | null = null;
  private spec: SpecDialogue | null = null;
  private directorSpec: SpecDirector | null = null;

  private utteranceId = "";
  private partialText = "";
  /** Bumped on any control change so async continuations can detect supersession. */
  private gen = 0;

  constructor(private clients: SceneClients) {
    this.cfg = loadConfig();
    this.scene = this.emptyScene();
  }

  private emptyScene(): SceneState {
    return {
      id: nanoid(8),
      setting: "",
      running: false,
      phase: "idle",
      characters: [],
      activeMicClientId: null,
      currentSpeaker: null,
      npcChainCount: 0,
      transcript: [],
      connectedClients: [],
    };
  }

  // -------------------------------------------------------------------------
  // State / broadcast
  // -------------------------------------------------------------------------

  getState(): SceneState {
    const connectedClients: ClientInfo[] = this.clients.clients().map((c) => ({
      id: c.id,
      role: c.role,
      label: c.label,
      characterId: c.characterId,
    }));
    const characters: CharacterState[] = this.scene.characters.map((c) => ({
      ...c,
      connected: !!c.claimedBy && !!this.clients.getClient(c.claimedBy),
    }));
    return { ...this.scene, characters, connectedClients };
  }

  private broadcastScene(): void {
    this.clients.broadcast({ t: "scene", scene: this.getState() });
  }

  private setPhase(p: Phase): void {
    this.scene.phase = p;
  }

  private surfaceError(message: string, scope = "provider"): void {
    log.error(`[${scope}]`, message);
    this.clients.broadcast({ t: "error", message, scope });
  }

  private liveTranscript(speaker: string, name: string, text: string, final: boolean): void {
    this.clients.broadcast({ t: "transcript", speaker, name, text, final });
  }

  private addTranscript(speaker: string, name: string, text: string, final: boolean): void {
    this.scene.transcript.push({ id: nanoid(8), speaker, name, text, ts: Date.now(), final });
    if (this.scene.transcript.length > MAX_TRANSCRIPT) {
      this.scene.transcript.splice(0, this.scene.transcript.length - MAX_TRANSCRIPT);
    }
    this.liveTranscript(speaker, name, text, final);
  }

  // -------------------------------------------------------------------------
  // Characters / roles
  // -------------------------------------------------------------------------

  private getCharacter(id: string | null): CharacterState | undefined {
    if (!id) return undefined;
    return this.scene.characters.find((c) => c.id === id);
  }

  private isConnected(c: CharacterState): boolean {
    return !!c.claimedBy && !!this.clients.getClient(c.claimedBy);
  }

  private connectedCharacters(): CharacterState[] {
    return this.scene.characters.filter((c) => this.isConnected(c));
  }

  private directorCandidates(exclude?: string): DirectorCandidate[] {
    return this.connectedCharacters()
      .filter((c) => c.id !== exclude)
      .map((c) => ({ id: c.id, name: c.name, persona: c.persona }));
  }

  private requireHost(clientId: string): boolean {
    const c = this.clients.getClient(clientId);
    if (!c || c.role !== "host") {
      this.clients.send(clientId, { t: "error", message: "Host role required", scope: "role" });
      return false;
    }
    return true;
  }

  // -------------------------------------------------------------------------
  // Lobby actions
  // -------------------------------------------------------------------------

  handleBecomeHost(clientId: string, label?: string): void {
    if (label) this.clients.setClientLabel(clientId, label);
    // Release any character this client held.
    this.releaseClaimsOf(clientId);
    this.clients.setClientRole(clientId, "host", null);
    this.clients.send(clientId, { t: "role", role: "host", characterId: null });
    this.broadcastScene();
  }

  handleEnterLobby(clientId: string): void {
    this.releaseClaimsOf(clientId);
    this.clients.setClientRole(clientId, "lobby", null);
    this.clients.send(clientId, { t: "role", role: "lobby", characterId: null });
    this.broadcastScene();
  }

  handleCreateScene(clientId: string, setting: string, inits: CharacterInit[]): void {
    const wasHost = this.clients.getClient(clientId)?.role === "host";
    if (!wasHost) {
      // Becoming host implicitly when creating a scene.
      this.clients.setClientRole(clientId, "host", null);
      this.clients.send(clientId, { t: "role", role: "host", characterId: null });
    }
    this.stopInternal();
    const characters: CharacterState[] = inits.map((c) => ({
      id: nanoid(8),
      name: c.name.trim() || "Unnamed",
      persona: c.persona ?? "",
      voice: c.voice || "alloy",
      aliases: (c.aliases ?? []).map((a) => a.trim()).filter(Boolean),
      secret: c.secret?.trim() || undefined,
      claimedBy: null,
      claimedByLabel: null,
      connected: false,
    }));
    this.scene = {
      ...this.emptyScene(),
      id: nanoid(8),
      setting: setting.trim(),
      characters,
    };
    // Any clients that were playing old characters return to the lobby.
    for (const c of this.clients.clients()) {
      if (c.role === "character") {
        this.clients.setClientRole(c.id, "lobby", null);
        this.clients.send(c.id, { t: "role", role: "lobby", characterId: null });
      }
    }
    this.broadcastScene();
  }

  handleClaim(clientId: string, characterId: string, label?: string): void {
    const char = this.getCharacter(characterId);
    if (!char) {
      this.clients.send(clientId, { t: "error", message: "No such character", scope: "claim" });
      return;
    }
    if (char.claimedBy && char.claimedBy !== clientId && this.clients.getClient(char.claimedBy)) {
      this.clients.send(clientId, { t: "error", message: "Character already claimed", scope: "claim" });
      return;
    }
    // Release any other character held by this client.
    this.releaseClaimsOf(clientId, characterId);
    if (label) this.clients.setClientLabel(clientId, label);
    const cl = this.clients.getClient(clientId);
    char.claimedBy = clientId;
    char.claimedByLabel = label ?? cl?.label ?? "Player";
    this.clients.setClientRole(clientId, "character", characterId);
    this.clients.send(clientId, { t: "role", role: "character", characterId });

    // If the scene is running and there is no active mic yet, default it here.
    if (this.scene.running && !this.scene.activeMicClientId) {
      this.setActiveMicInternal(clientId);
    }
    this.broadcastScene();
  }

  handleRelease(clientId: string): void {
    this.releaseClaimsOf(clientId);
    this.clients.setClientRole(clientId, "lobby", null);
    this.clients.send(clientId, { t: "role", role: "lobby", characterId: null });
    this.broadcastScene();
  }

  private releaseClaimsOf(clientId: string, except?: string): void {
    for (const c of this.scene.characters) {
      if (c.claimedBy === clientId && c.id !== except) {
        c.claimedBy = null;
        c.claimedByLabel = null;
      }
    }
  }

  // -------------------------------------------------------------------------
  // Connection lifecycle
  // -------------------------------------------------------------------------

  onClientDisconnected(clientId: string): void {
    // If this client was speaking, abort its turn.
    if (this.active && this.active.clientId === clientId) {
      this.active.abort.abort();
      this.active = null;
    }
    this.releaseClaimsOf(clientId);
    if (this.scene.activeMicClientId === clientId) {
      this.scene.activeMicClientId = null;
      this.assignDefaultMic();
    }
    this.broadcastScene();
  }

  // -------------------------------------------------------------------------
  // Scene control (host)
  // -------------------------------------------------------------------------

  handleStart(clientId: string): void {
    if (!this.requireHost(clientId)) return;
    if (this.scene.characters.length === 0) {
      this.clients.send(clientId, { t: "error", message: "Create a scene first", scope: "scene" });
      return;
    }
    this.scene.running = true;
    this.setPhase("listening");
    this.scene.npcChainCount = 0;
    this.scene.currentSpeaker = null;
    this.gen++;
    this.startStt();
    this.assignDefaultMic();
    this.broadcastScene();
    log.info("scene started");
  }

  handleStop(clientId: string): void {
    if (!this.requireHost(clientId)) return;
    this.stopInternal();
    this.broadcastScene();
    log.info("scene stopped");
  }

  handleReset(clientId: string): void {
    if (!this.requireHost(clientId)) return;
    this.stopInternal();
    this.scene.transcript = [];
    this.scene.currentSpeaker = null;
    this.scene.npcChainCount = 0;
    this.broadcastScene();
    log.info("scene reset");
  }

  private stopInternal(): void {
    this.gen++;
    if (this.active && !this.active.abort.signal.aborted) {
      this.stopTurnAudio(this.active);
      this.active.abort.abort();
    }
    this.active = null;
    this.abortSpeculative();
    if (this.scene.activeMicClientId) {
      this.clients.send(this.scene.activeMicClientId, {
        t: "listen",
        on: false,
        frameMs: this.cfg.micFrameMs,
      });
    }
    this.scene.activeMicClientId = null;
    this.scene.running = false;
    this.setPhase("idle");
    this.stopStt();
  }

  // -------------------------------------------------------------------------
  // Active mic
  // -------------------------------------------------------------------------

  handleSetActiveMic(clientId: string, targetClientId: string): void {
    if (!this.requireHost(clientId)) return;
    if (!this.clients.getClient(targetClientId)) {
      this.clients.send(clientId, { t: "error", message: "Target client not connected", scope: "mic" });
      return;
    }
    this.setActiveMicInternal(targetClientId);
  }

  private setActiveMicInternal(clientId: string | null): void {
    if (this.scene.activeMicClientId === clientId) {
      this.broadcastScene();
      return;
    }
    const prev = this.scene.activeMicClientId;
    this.scene.activeMicClientId = clientId;
    if (prev && this.clients.getClient(prev)) {
      this.clients.send(prev, { t: "listen", on: false, frameMs: this.cfg.micFrameMs });
    }
    if (clientId) {
      this.clients.send(clientId, { t: "listen", on: true, frameMs: this.cfg.micFrameMs });
    }
    this.broadcastScene();
  }

  private assignDefaultMic(): void {
    if (!this.scene.running) return;
    if (this.scene.activeMicClientId && this.clients.getClient(this.scene.activeMicClientId)) return;
    const first = this.connectedCharacters()[0];
    this.setActiveMicInternal(first?.claimedBy ?? null);
  }

  // -------------------------------------------------------------------------
  // STT lifecycle + events
  // -------------------------------------------------------------------------

  private startStt(): void {
    if (this.stt) return;
    this.stt = new SttSession({
      onReady: () => log.info("STT ready"),
      onSpeechStarted: () => this.onSpeechStarted(),
      onSpeechStopped: () => this.onSpeechStopped(),
      onPartial: (text) => this.onSttPartial(text),
      onFinal: (text) => this.onSttFinal(text),
      onError: (msg) => this.surfaceError(msg, "stt"),
    });
    this.stt.start();
  }

  private stopStt(): void {
    this.stt?.stop();
    this.stt = null;
  }

  onMicFrame(clientId: string, buf: Buffer): void {
    if (!this.scene.running) return;
    if (clientId !== this.scene.activeMicClientId) return;
    this.stt?.appendPcm(buf);
  }

  private onSpeechStarted(): void {
    if (!this.scene.running) return;
    if (this.cfg.bargeIn && (this.scene.phase === "speaking" || this.scene.phase === "thinking")) {
      this.bargeIn();
    }
    this.utteranceId = nanoid(8);
    this.partialText = "";
    this.abortSpeculative();
    this.gen++;
    this.setPhase("listening");
    this.broadcastScene();
  }

  private onSpeechStopped(): void {
    // Final transcript follows; nothing required here.
  }

  private onSttPartial(text: string): void {
    if (!this.scene.running) return;
    if (this.scene.phase !== "listening") return;
    this.partialText = text;
    this.liveTranscript("human", "Human", text, false);
    this.speculate(text);
  }

  private onSttFinal(text: string): void {
    if (!this.scene.running) return;
    void this.processHumanUtterance(text.trim(), this.utteranceId);
  }

  // -------------------------------------------------------------------------
  // Speculation
  // -------------------------------------------------------------------------

  private speculate(text: string): void {
    if (!this.cfg.speculativeDirector && !this.cfg.speculativeDialogue) return;
    const words = countWords(text);
    const candidates = this.connectedCharacters();
    if (candidates.length === 0) return;

    const nameId = matchCharacterByName(
      text,
      candidates.map((c) => ({ id: c.id, name: c.name, aliases: c.aliases })),
    );
    if (nameId) {
      this.maybeStartSpecDialogue(nameId, text, words);
      return;
    }

    if (
      this.cfg.speculativeDirector &&
      words >= this.cfg.speculativeMinWordsDirector &&
      !this.directorSpec
    ) {
      const uid = this.utteranceId;
      const abort = new AbortController();
      this.directorSpec = { uid, transcript: text, abort };
      runDirector({
        setting: this.scene.setting,
        history: this.historyText(),
        latest: text,
        speakerName: "Human",
        candidates: this.directorCandidates(),
        mustPick: true,
        signal: abort.signal,
      })
        .then((rid) => {
          if (this.utteranceId !== uid || !this.directorSpec || this.directorSpec.uid !== uid) return;
          this.directorSpec.result = rid;
          if (rid && this.cfg.speculativeDialogue) {
            this.maybeStartSpecDialogue(rid, this.partialText, countWords(this.partialText));
          }
        })
        .catch(() => {});
    }
  }

  private maybeStartSpecDialogue(responderId: string, text: string, words: number): void {
    if (!this.cfg.speculativeDialogue) return;
    if (this.spec) return;
    if (words < this.cfg.speculativeMinWordsDialogue) return;
    if (this.utteranceId === "") return;
    const char = this.getCharacter(responderId);
    if (!char || !char.claimedBy || !this.isConnected(char)) return;
    // Avoid playing speculative audio into the laptop that is still capturing.
    if (char.claimedBy === this.scene.activeMicClientId) return;

    const uid = this.utteranceId;
    const lines = this.buildLines({ speaker: "human", name: "Human", text });
    const turn = this.startTurn({
      characterId: responderId,
      lines,
      utteranceId: uid,
      commit: false,
      chain: true,
    });
    if (turn) {
      this.spec = { uid, responderId, transcript: text, turn };
      log.pipe(`speculative dialogue start -> ${char.name} ("${text.slice(0, 40)}")`);
    }
  }

  private abortSpeculative(): void {
    if (this.directorSpec) {
      this.directorSpec.abort.abort();
      this.directorSpec = null;
    }
    if (this.spec) {
      const t = this.spec.turn;
      this.spec = null;
      if (t && !t.committed && !t.abort.signal.aborted) {
        this.stopTurnAudio(t);
        t.abort.abort();
        if (this.active === t) this.active = null;
      }
    }
  }

  private clearSpecRefs(): void {
    if (this.directorSpec) {
      this.directorSpec.abort.abort();
      this.directorSpec = null;
    }
    this.spec = null;
  }

  // -------------------------------------------------------------------------
  // Human utterance -> route -> respond
  // -------------------------------------------------------------------------

  handleHumanText(clientId: string, text: string): void {
    if (!this.requireHost(clientId)) return;
    if (!this.scene.running) {
      this.clients.send(clientId, { t: "error", message: "Start the scene first", scope: "scene" });
      return;
    }
    if (this.scene.phase === "speaking" || this.scene.phase === "thinking") {
      this.bargeIn();
    }
    this.utteranceId = nanoid(8);
    this.partialText = "";
    this.gen++;
    void this.processHumanUtterance(text.trim(), this.utteranceId);
  }

  private async processHumanUtterance(finalText: string, uid: string): Promise<void> {
    if (!this.scene.running) return;
    if (!finalText) {
      this.clearSpecRefs();
      if (this.active && !this.active.committed) {
        this.active.abort.abort();
        this.active = null;
      }
      this.setPhase("listening");
      this.broadcastScene();
      return;
    }

    this.addTranscript("human", "Human", finalText, true);
    this.scene.npcChainCount = 0;

    const candidates = this.connectedCharacters();
    if (candidates.length === 0) {
      this.surfaceError("No connected characters to respond.", "scene");
      this.setPhase("listening");
      this.broadcastScene();
      return;
    }

    // 1) instant name/alias match
    let responder = matchCharacterByName(
      finalText,
      candidates.map((c) => ({ id: c.id, name: c.name, aliases: c.aliases })),
    );

    // 2) director (reuse speculative result if similar enough)
    if (!responder) {
      if (
        this.directorSpec &&
        this.directorSpec.uid === uid &&
        this.directorSpec.result &&
        similarity(this.directorSpec.transcript, finalText) >= this.cfg.speculativeSimilarityThreshold
      ) {
        responder = this.directorSpec.result;
        log.pipe("director: committed speculative result");
      } else {
        responder = await runDirector({
          setting: this.scene.setting,
          history: this.historyText(),
          latest: finalText,
          speakerName: "Human",
          candidates: candidates.map((c) => ({ id: c.id, name: c.name, persona: c.persona })),
          mustPick: true,
        });
        if (this.utteranceId !== uid) return; // superseded while awaiting
      }
    }

    // 3) fallbacks
    if (!responder || !this.isConnected(this.getCharacter(responder) ?? ({} as CharacterState))) {
      responder =
        (this.scene.currentSpeaker &&
          candidates.find((c) => c.id === this.scene.currentSpeaker)?.id) ||
        candidates[0]!.id;
    }

    // Commit speculative dialogue if it matches; otherwise restart from final.
    const spec = this.spec;
    if (
      spec &&
      spec.uid === uid &&
      spec.responderId === responder &&
      this.active === spec.turn &&
      !spec.turn.abort.signal.aborted &&
      similarity(spec.transcript, finalText) >= this.cfg.speculativeSimilarityThreshold
    ) {
      log.pipe("dialogue: committing speculative turn");
      this.clearSpecRefs();
      this.commitTurn(spec.turn);
    } else {
      this.abortSpeculative();
      this.clearSpecRefs();
      this.scene.npcChainCount = 1;
      const lines = this.buildLines();
      this.startTurn({
        characterId: responder,
        lines,
        utteranceId: uid,
        commit: true,
        chain: true,
      });
    }
  }

  handleInjectLine(clientId: string, characterId: string, text: string): void {
    if (!this.requireHost(clientId)) return;
    const char = this.getCharacter(characterId);
    if (!char || !char.claimedBy || !this.isConnected(char)) {
      this.clients.send(clientId, {
        t: "error",
        message: "Character not connected",
        scope: "inject",
      });
      return;
    }
    if (this.scene.phase === "speaking" || this.scene.phase === "thinking") {
      this.bargeIn();
    }
    this.gen++;
    this.startTurn({
      characterId,
      lines: [],
      utteranceId: null,
      commit: true,
      chain: false,
      scripted: text.trim(),
    });
  }

  // -------------------------------------------------------------------------
  // Turn execution
  // -------------------------------------------------------------------------

  private startTurn(opts: {
    characterId: string;
    lines: RoledLine[];
    utteranceId: string | null;
    commit: boolean;
    chain: boolean;
    scripted?: string;
  }): ActiveTurn | null {
    const char = this.getCharacter(opts.characterId);
    if (!char || !char.claimedBy || !this.isConnected(char)) return null;
    const clientId = char.claimedBy;

    // Supersede any current turn.
    if (this.active && !this.active.abort.signal.aborted) {
      this.stopTurnAudio(this.active);
      this.active.abort.abort();
    }

    const turn: ActiveTurn = {
      characterId: opts.characterId,
      clientId,
      turnId: nanoid(8),
      abort: new AbortController(),
      utteranceId: opts.utteranceId,
      committed: opts.commit,
      finished: false,
      spoken: "",
      replyRecorded: false,
      begun: false,
    };
    this.active = turn;
    this.scene.currentSpeaker = opts.characterId;
    this.setPhase("thinking");
    if (opts.commit) this.setActiveMicInternal(clientId);
    this.broadcastScene();

    void this.runTurnLoop(turn, char, opts.lines, opts.chain, opts.scripted);
    return turn;
  }

  private commitTurn(turn: ActiveTurn): void {
    if (turn.committed) {
      // already committed
    } else {
      turn.committed = true;
    }
    this.scene.npcChainCount = 1;
    this.setActiveMicInternal(turn.clientId);
    if (turn.finished && !turn.abort.signal.aborted) {
      this.recordReply(turn);
      void this.afterTurn(turn.characterId);
    }
  }

  private recordReply(turn: ActiveTurn): void {
    if (turn.replyRecorded) return;
    const spoken = turn.spoken.trim();
    if (!spoken) return;
    const char = this.getCharacter(turn.characterId);
    this.addTranscript(turn.characterId, char?.name ?? "Character", spoken, true);
    turn.replyRecorded = true;
  }

  private async runTurnLoop(
    turn: ActiveTurn,
    char: CharacterState,
    lines: RoledLine[],
    chain: boolean,
    scripted?: string,
  ): Promise<void> {
    const clientId = turn.clientId;
    const chunks: string[] = [];
    let producerDone = false;
    let waiter: (() => void) | null = null;
    const wake = () => {
      if (waiter) {
        const w = waiter;
        waiter = null;
        w();
      }
    };
    const pushChunk = (c: string) => {
      const t = c.trim();
      if (t) {
        chunks.push(t);
        wake();
      }
    };
    const endChunks = () => {
      producerDone = true;
      wake();
    };

    // PCM 2-byte alignment carried across chunks within this turn.
    let leftover: Buffer | null = null;
    const onFirstAudio = () => {
      if (turn.begun) return;
      turn.begun = true;
      this.setPhase("speaking");
      this.clients.send(clientId, {
        t: "speakBegin",
        characterId: turn.characterId,
        turnId: turn.turnId,
      });
      this.broadcastScene();
    };
    const sendPcm = (pcm: Buffer) => {
      let buf = leftover ? Buffer.concat([leftover, pcm]) : pcm;
      leftover = null;
      if (buf.length % 2 === 1) {
        leftover = Buffer.from(buf.subarray(buf.length - 1));
        buf = buf.subarray(0, buf.length - 1);
      }
      if (buf.length) {
        onFirstAudio();
        this.clients.sendBinary(clientId, buf);
      }
    };

    const consumer = (async () => {
      while (true) {
        if (chunks.length === 0) {
          if (producerDone) break;
          await new Promise<void>((r) => (waiter = r));
          continue;
        }
        const text = chunks.shift()!;
        turn.spoken = turn.spoken ? `${turn.spoken} ${text}` : text;
        this.liveTranscript(turn.characterId, char.name, turn.spoken, false);
        try {
          await streamTts({
            text,
            voice: char.voice,
            instructions: this.voiceInstructions(char),
            signal: turn.abort.signal,
            onChunk: (pcm) => sendPcm(pcm),
          });
        } catch (e) {
          if (turn.abort.signal.aborted) break;
          this.surfaceError(`TTS (${char.name}): ${errMsg(e)}`, "tts");
        }
      }
    })();

    // Producer
    const chunker = new SpeakableChunker({
      firstMinWords: this.cfg.ttsFirstChunkMinWords,
      firstMaxWords: this.cfg.ttsFirstChunkMaxWords,
      laterMaxWords: this.cfg.ttsLaterChunkMaxWords,
      allowComma: this.cfg.ttsAllowCommaBoundary,
      allowDash: this.cfg.ttsAllowDashBoundary,
    });
    let firstTimer: NodeJS.Timeout | null = null;

    try {
      if (scripted != null) {
        chunker.push(scripted);
        for (const c of chunker.drain()) pushChunk(c);
      } else {
        let started = false;
        for await (const delta of streamDialogue({
          setting: this.scene.setting,
          character: { id: char.id, name: char.name, persona: char.persona, secret: char.secret },
          lines,
          signal: turn.abort.signal,
        })) {
          chunker.push(delta);
          if (!started) {
            started = true;
            firstTimer = setTimeout(() => {
              for (const c of chunker.forceFirst()) pushChunk(c);
            }, this.cfg.ttsMaxWaitForFirstChunkMs);
          }
          for (const c of chunker.drain()) pushChunk(c);
        }
      }
    } catch (e) {
      if (!turn.abort.signal.aborted) {
        this.surfaceError(`Dialogue (${char.name}): ${errMsg(e)}`, "dialogue");
      }
    } finally {
      if (firstTimer) clearTimeout(firstTimer);
      for (const c of chunker.flush()) pushChunk(c);
      endChunks();
    }

    await consumer;

    turn.finished = true;
    const aborted = turn.abort.signal.aborted;

    if (aborted) {
      if (this.active === turn) this.active = null;
      return;
    }

    // Audio (if any) has fully streamed; let the speaking laptop end its playback
    // state. Sent for speculative turns too, so a later commit needs no extra signal.
    if (turn.begun) {
      this.clients.send(clientId, {
        t: "speakEnd",
        characterId: turn.characterId,
        turnId: turn.turnId,
      });
    }

    if (turn.committed) {
      this.recordReply(turn);
      if (this.active === turn) this.active = null;
      if (chain) {
        void this.afterTurn(turn.characterId);
      } else {
        if (this.scene.running) this.setPhase("listening");
        this.broadcastScene();
      }
    }
    // If speculative and not yet committed, keep `this.active = turn` so it can
    // be committed (or aborted) when the final transcript arrives.
  }

  private async afterTurn(lastCharacterId: string): Promise<void> {
    if (!this.scene.running) return;
    const g = this.gen;

    if (this.scene.npcChainCount >= this.cfg.maxNpcChain) {
      this.setPhase("listening");
      this.broadcastScene();
      return;
    }

    const candidates = this.directorCandidates(lastCharacterId);
    if (candidates.length === 0) {
      this.setPhase("listening");
      this.broadcastScene();
      return;
    }

    this.setPhase("thinking");
    this.broadcastScene();

    const last = this.getCharacter(lastCharacterId);
    const nextId = await runDirector({
      setting: this.scene.setting,
      history: this.historyText(),
      latest: last ? last.name : "",
      speakerName: last?.name ?? "",
      candidates,
      mustPick: false,
    });

    if (g !== this.gen || !this.scene.running) return; // superseded (e.g. barge-in)

    if (!nextId) {
      this.setPhase("listening");
      this.broadcastScene();
      return;
    }

    this.scene.npcChainCount++;
    this.startTurn({
      characterId: nextId,
      lines: this.buildLines(),
      utteranceId: null,
      commit: true,
      chain: true,
    });
  }

  private bargeIn(): void {
    log.pipe("barge-in");
    this.gen++;
    if (this.active && !this.active.abort.signal.aborted) {
      this.stopTurnAudio(this.active);
      this.active.abort.abort();
    }
    this.active = null;
    this.abortSpeculative();
  }

  private stopTurnAudio(turn: ActiveTurn): void {
    if (this.clients.getClient(turn.clientId)) {
      this.clients.send(turn.clientId, { t: "stopAudio" });
    }
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  private buildLines(extra?: RoledLine): RoledLine[] {
    const base = transcriptToLines(this.scene.transcript.filter((e) => e.final));
    const trimmed = base.slice(-MAX_CONTEXT_LINES);
    return extra ? [...trimmed, extra] : trimmed;
  }

  private historyText(): string {
    return this.scene.transcript
      .filter((e) => e.final)
      .slice(-MAX_HISTORY_LINES)
      .map((e) => `${e.name}: ${e.text}`)
      .join("\n");
  }

  private voiceInstructions(char: CharacterState): string {
    const persona = char.persona ? ` Personality: ${char.persona.slice(0, 240)}.` : "";
    return `Speak as ${char.name}, in character, natural and conversational for a live scene.${persona}`;
  }
}
