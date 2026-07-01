import { nanoid } from "nanoid";
import type {
  CharacterInit,
  CharacterState,
  ClientInfo,
  HumanFloorMode,
  Role,
  SceneState,
  ServerToClient,
  Phase,
  TurnChannel,
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
/** Mark the H4 disconnected if no ping/event arrives within this window. */
const H4_PRESENCE_TIMEOUT_MS = 12_000;

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

  /** clientId whose TTS is still audibly playing. While set, ALL mic input is
   *  held back from STT so no one transcribes the speaker's output (including
   *  its buffered tail). Cleared when that client reports `audioStopped`. */
  private playbackActiveClient: string | null = null;
  private playbackSafety: NodeJS.Timeout | null = null;
  /** A queued NPC chain step waiting for the current speaker's audio to actually
   *  finish playing before it starts, so characters never talk over each other. */
  private pendingChain: { lastCharacterId: string; gen: number } | null = null;
  /** Timer for the human-intervention listening window between NPC turns. */
  private chainTimer: NodeJS.Timeout | null = null;
  /** Echo strategy. "legacy" (default): gate STT during playback (half-duplex) —
   *  required for mics without echo cancellation (e.g. the H4), so a character's
   *  own TTS never leaks back into STT. "aec": trust the client's echo
   *  cancellation and keep the mic open. Set by the client via setAudioMode. */
  private audioMode: "aec" | "legacy" = "legacy";

  private utteranceId = "";
  private partialText = "";
  /** Floor mode latched while the current utterance is being spoken. Used to
   *  classify it when the STT final lands, which can be after an H4 hold has
   *  already been released (the final lags the release) — so the device
   *  interaction is still routed correctly instead of leaking into the scene. */
  private utteranceFloor: HumanFloorMode = "direct";
  /** Bumped on any control change so async continuations can detect supersession. */
  private gen = 0;

  /** The device's relayed reply captured during a device_mediated hold, answered
   *  on release. (The floor mode itself lives on the scene state: floorMode.) */
  private pendingMediated: { text: string; uid: string } | null = null;
  /** Count of final utterances seen since entering the current device_mediated
   *  hold. The 1st is the human's private query to the device ("Query for H4");
   *  the device's spoken reply ("H4 response") follows and is what's relayed. */
  private mediatedFinals = 0;

  /** Whether an H4 device is currently connected (heartbeat-based). Kept off the
   *  scene object so it survives scene re-creation; merged into getState(). */
  private h4Connected = false;
  private h4DisconnectTimer: NodeJS.Timeout | null = null;

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
      floorMode: "direct",
      h4Connected: false,
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
    return { ...this.scene, h4Connected: this.h4Connected, characters, connectedClients };
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

  private liveTranscript(
    speaker: string,
    name: string,
    text: string,
    final: boolean,
    channel?: TurnChannel,
  ): void {
    this.clients.broadcast({ t: "transcript", speaker, name, text, final, channel });
  }

  private addTranscript(
    speaker: string,
    name: string,
    text: string,
    final: boolean,
    channel?: TurnChannel,
  ): void {
    this.scene.transcript.push({ id: nanoid(8), speaker, name, text, ts: Date.now(), final, channel });
    if (this.scene.transcript.length > MAX_TRANSCRIPT) {
      this.scene.transcript.splice(0, this.scene.transcript.length - MAX_TRANSCRIPT);
    }
    this.liveTranscript(speaker, name, text, final, channel);
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
    // Carry claims across the swap so players keep their role when the host
    // switches scenarios mid-session. A claimed character in the previous cast
    // is matched to a same-named character in the new cast (case-insensitive),
    // preserving its id so the claiming client's characterId stays valid.
    const prev = this.scene.characters.filter((c) => c.claimedBy);
    const carried = new Set<string>();
    const characters: CharacterState[] = inits.map((c) => {
      const name = c.name.trim() || "Unnamed";
      const match = prev.find(
        (p) => !carried.has(p.id) && p.name.toLowerCase() === name.toLowerCase(),
      );
      if (match) carried.add(match.id);
      return {
        id: match?.id ?? nanoid(8),
        name,
        persona: c.persona ?? "",
        voice: c.voice || "alloy",
        aliases: (c.aliases ?? []).map((a) => a.trim()).filter(Boolean),
        secret: c.secret?.trim() || undefined,
        claimedBy: match?.claimedBy ?? null,
        claimedByLabel: match?.claimedByLabel ?? null,
        connected: false,
      };
    });
    this.scene = {
      ...this.emptyScene(),
      id: nanoid(8),
      setting: setting.trim(),
      characters,
    };
    // Reconcile character-role clients: keep anyone whose claim carried over
    // (their characterId is unchanged); send everyone else back to the lobby.
    for (const c of this.clients.clients()) {
      if (c.role !== "character") continue;
      const kept = characters.some((ch) => ch.id === c.characterId && ch.claimedBy === c.id);
      if (!kept) {
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
    if (this.playbackActiveClient === clientId) this.clearPlayback();
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
    this.pendingChain = null;
    this.clearChainTimer();
    this.clearPlayback();
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

  /** A client reports it actually started playing audio (it's outputting now).
   *  The active mic follows audio output: make this machine the mic, and keep it
   *  there until a different machine starts outputting audio. */
  onAudioStarted(clientId: string): void {
    if (!this.scene.running) return;
    if (!this.clients.getClient(clientId)) return;
    this.setActiveMicInternal(clientId);
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

  setAudioMode(mode: "aec" | "legacy"): void {
    this.audioMode = mode;
    log.info(`audio mode: ${mode}`);
  }

  onMicFrame(clientId: string, buf: Buffer): void {
    if (!this.scene.running) return;
    if (clientId !== this.scene.activeMicClientId) return;
    // Legacy (half-duplex): hold all input while a character's TTS is playing so
    // the speaker's own output (and its tail) is never transcribed back. In AEC
    // mode the client cancels its own echo, so we keep the mic open for
    // full-duplex voice barge-in.
    if (this.audioMode === "legacy" && this.playbackActiveClient) return;
    this.stt?.appendPcm(buf);
  }

  /** A client reports its TTS playback buffer has fully drained (audio truly
   *  stopped). Re-open STT and drop any boundary audio captured meanwhile. */
  onAudioStopped(clientId: string): void {
    this.releasePlayback(clientId);
  }

  /** Called when the playing client's audio truly stops (report or safety
   *  timeout): reopen STT and start the deferred next NPC, if any. */
  private releasePlayback(clientId: string): void {
    if (this.playbackActiveClient !== clientId) return;
    this.clearPlayback();
    this.stt?.clearInput();
    const pending = this.pendingChain;
    if (pending && pending.gen === this.gen && this.scene.running) {
      this.pendingChain = null;
      // Open a listening window so a human can intervene before the next NPC
      // speaks. No audio plays during this gap, so it's echo-safe. If the human
      // stays silent, the chain continues; if they speak, scheduleChain is
      // cancelled and their utterance is routed instead.
      this.setPhase("listening");
      this.broadcastScene();
      this.scheduleChain(pending.lastCharacterId, this.gen);
    }
  }

  private scheduleChain(lastCharacterId: string, gen: number): void {
    this.clearChainTimer();
    this.chainTimer = setTimeout(() => {
      this.chainTimer = null;
      // Skip if a human spoke (gen bumped), the scene changed, or we're no
      // longer simply listening (someone already started speaking/thinking).
      if (gen !== this.gen || !this.scene.running || this.scene.phase !== "listening") return;
      void this.afterTurn(lastCharacterId);
    }, this.cfg.npcChainGapMs);
  }

  private clearChainTimer(): void {
    if (this.chainTimer) {
      clearTimeout(this.chainTimer);
      this.chainTimer = null;
    }
  }

  private clearPlayback(): void {
    this.playbackActiveClient = null;
    if (this.playbackSafety) {
      clearTimeout(this.playbackSafety);
      this.playbackSafety = null;
    }
  }

  private onSpeechStarted(): void {
    if (!this.scene.running) return;
    // Never interrupt a character that is audibly mid-line. Detected speech here
    // is either a human in the room or the character's own TTS leaking back
    // through a mic without echo cancellation (e.g. the H4); in both cases the
    // committed line must finish. (Mic input is also gated during playback — see
    // onMicFrame — so this guard is rarely reached, but it also fences the tail.)
    if (this.playbackActiveClient) return;
    // A human is speaking — cancel any queued NPC chain so they can intervene.
    this.clearChainTimer();
    if (this.cfg.bargeIn && this.scene.phase === "thinking") {
      this.bargeIn();
    }
    this.utteranceId = nanoid(8);
    this.partialText = "";
    // Latch the floor mode for this utterance now, while it is being spoken.
    this.utteranceFloor = this.scene.floorMode;
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
    // Drop a transcript that completed while a character was still audibly
    // speaking: it's the character's own TTS echoing back (no AEC on the H4), or
    // a human talking over a committed line — never input we act on. Letting it
    // through here would supersede and cut off the speaking turn.
    if (this.playbackActiveClient) return;
    void this.processHumanUtterance(text.trim(), this.utteranceId);
  }

  // -------------------------------------------------------------------------
  // Speculation
  // -------------------------------------------------------------------------

  private speculate(text: string): void {
    // While the human is addressing the device (any non-direct floor), never
    // pre-start character work — they're either silent or waiting.
    if (this.scene.floorMode !== "direct") return;
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
    this.clearChainTimer();
    if (this.scene.phase === "speaking" || this.scene.phase === "thinking") {
      this.bargeIn();
    }
    this.utteranceId = nanoid(8);
    this.partialText = "";
    this.utteranceFloor = this.scene.floorMode;
    this.gen++;
    void this.processHumanUtterance(text.trim(), this.utteranceId);
  }

  private async processHumanUtterance(finalText: string, uid: string): Promise<void> {
    if (!this.scene.running) return;
    // Classify by the floor mode latched when the utterance was spoken, not the
    // live one — the H4 hold is often released before this (latency-delayed)
    // final arrives. Reset the latch for the next utterance.
    const floor = this.utteranceFloor;
    this.utteranceFloor = this.scene.floorMode;

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

    // H4 floor: the human was talking TO their device (Ask / Vision / dictation).
    // Log it as a private aside the characters never perceive, and don't respond.
    if (floor === "device_directed") {
      this.addTranscript("human", "Human", finalText, true, "to_device");
      this.setPhase("listening");
      this.broadcastScene();
      return;
    }

    // H4 "via device" floor: the human first speaks a query TO the device, then
    // the device speaks its reply aloud (captured as the next utterance). The
    // query is a private aside ("Query for H4"); the device's reply ("H4
    // response") is what gets relayed into the conversation on the person's
    // behalf and responded to. Characters stay silent until the hold is released.
    if (floor === "device_mediated") {
      this.mediatedFinals++;
      if (this.mediatedFinals === 1) {
        // First utterance of the hold: the human's query to the device. Private —
        // never perceived by the characters, never answered.
        this.addTranscript("human", "Human", finalText, true, "query_for_device");
        this.setPhase("listening");
        this.broadcastScene();
        return;
      }
      // Subsequent utterance(s): the device speaking its reply. Relay it into the
      // conversation as the person's contribution. Respond on release; if the
      // hold was already let go before this (latency-delayed) final landed,
      // respond now.
      this.addTranscript("human", "Human", finalText, true, "via_device");
      this.scene.npcChainCount = 0;
      const text = this.pendingMediated
        ? `${this.pendingMediated.text} ${finalText}`.trim()
        : finalText;
      this.pendingMediated = { text, uid };
      if (this.scene.floorMode === "direct") {
        const pending = this.pendingMediated;
        this.pendingMediated = null;
        await this.respondToHuman(pending.text, pending.uid);
      } else {
        this.setPhase("listening");
        this.broadcastScene();
      }
      return;
    }

    this.addTranscript("human", "Human", finalText, true);
    this.scene.npcChainCount = 0;
    await this.respondToHuman(finalText, uid);
  }

  /**
   * Route an already-recorded human line to a responder and start its turn.
   * Used for normal input and on release of a device_mediated hold.
   */
  private async respondToHuman(finalText: string, uid: string): Promise<void> {
    if (!this.scene.running) return;
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
  // H4 floor mode (gesture remote + web fallback)
  // -------------------------------------------------------------------------

  /**
   * Record an H4 heartbeat or event: (re)mark it connected and arm the
   * disconnect timeout. Called by the REST ping and any H4-sourced floor event.
   */
  noteH4Seen(): void {
    if (!this.h4Connected) {
      this.h4Connected = true;
      this.broadcastScene();
      log.info("H4 connected");
    }
    if (this.h4DisconnectTimer) clearTimeout(this.h4DisconnectTimer);
    this.h4DisconnectTimer = setTimeout(() => this.markH4Disconnected(), H4_PRESENCE_TIMEOUT_MS);
  }

  private markH4Disconnected(): void {
    if (this.h4DisconnectTimer) {
      clearTimeout(this.h4DisconnectTimer);
      this.h4DisconnectTimer = null;
    }
    if (!this.h4Connected) return;
    this.h4Connected = false;
    this.broadcastScene();
    log.info("H4 disconnected (no heartbeat)");
  }

  /**
   * Set who the human is addressing. Entering a hold (device_directed /
   * device_mediated) cuts any in-flight character work so they fall silent;
   * returning to "direct" responds to the device's relayed reply captured during
   * a device_mediated hold, if any.
   */
  setFloorMode(mode: HumanFloorMode, action?: string, source: "h4" | "web" = "web"): void {
    // Any H4-sourced floor change is also a heartbeat (proves the device is live).
    if (source === "h4") this.noteH4Seen();
    const nextAction = mode === "direct" ? undefined : action;
    if (mode === this.scene.floorMode && nextAction === this.scene.floorAction) {
      if (mode !== "direct" && this.scene.floorSource !== source) {
        this.scene.floorSource = source;
        this.broadcastScene();
      }
      return;
    }
    const prev = this.scene.floorMode;
    this.scene.floorMode = mode;
    this.scene.floorAction = nextAction;
    this.scene.floorSource = mode === "direct" ? undefined : source;

    if (mode !== "direct") {
      // Entering a hold: silence the characters immediately.
      this.pendingMediated = null;
      // Restart the via-device sequence so the first utterance of this hold is
      // treated as the human's query and the device's reply follows.
      this.mediatedFinals = 0;
      // Latch the hold onto the in-flight (or imminent) utterance so a final that
      // lands after the hold is released is still routed as a device interaction.
      this.utteranceFloor = mode;
      this.bargeIn();
      if (this.scene.running) this.setPhase("listening");
      this.broadcastScene();
      log.info(`floor mode: ${mode}${action ? ` (${action})` : ""}`);
      return;
    }

    // Returning the floor to the characters.
    const pending = this.pendingMediated;
    this.pendingMediated = null;
    this.broadcastScene();
    log.info("floor mode: direct");
    if (prev === "device_mediated" && pending && this.scene.running) {
      this.gen++;
      void this.respondToHuman(pending.text, pending.uid);
    }
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
    // A turn is starting — cancel any pending inter-turn intervention window.
    this.clearChainTimer();
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
    // The active mic is NOT switched here — it follows actual audio output and
    // moves only when a client reports audioStarted (see onAudioStarted).
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
      // Committed audio is now playing on this client: hold STT until it reports
      // the audio actually stopped (see onAudioStopped / onMicFrame gate). We do
      // NOT gate for speculative turns, which play while the human is still
      // talking and must not cut off the human's own input.
      if (turn.committed) {
        this.playbackActiveClient = clientId;
        if (this.playbackSafety) {
          clearTimeout(this.playbackSafety);
          this.playbackSafety = null;
        }
      }
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
      // Safety net: if the client's audioStopped report is lost, release the STT
      // hold (and resume any deferred chain) after a generous window so things
      // can never get stuck closed.
      if (this.playbackActiveClient === clientId) {
        if (this.playbackSafety) clearTimeout(this.playbackSafety);
        this.playbackSafety = setTimeout(() => {
          this.releasePlayback(clientId);
        }, 8000);
      }
    }

    if (turn.committed) {
      this.recordReply(turn);
      if (this.active === turn) this.active = null;
      if (chain) {
        if (turn.begun && this.playbackActiveClient === turn.clientId) {
          // Audio is still playing out on the client (TTS streams faster than
          // realtime, so a whole line is buffered). Defer the next character
          // until it actually finishes — resumed in releasePlayback — so NPCs
          // don't talk over each other.
          this.pendingChain = { lastCharacterId: turn.characterId, gen: this.gen };
        } else {
          void this.afterTurn(turn.characterId);
        }
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
    // Audio is being dropped — release the STT hold and cancel any deferred chain.
    this.pendingChain = null;
    this.clearChainTimer();
    this.clearPlayback();
  }

  private stopTurnAudio(turn: ActiveTurn): void {
    if (this.clients.getClient(turn.clientId)) {
      this.clients.send(turn.clientId, { t: "stopAudio" });
    }
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  /** Private device asides the characters never perceive: the operator's words
   *  spoken TO the device (ASK) and the via-device query. They only ever hear the
   *  device's relayed reply ("via_device"). */
  private isPrivateAside(channel?: TurnChannel): boolean {
    return channel === "to_device" || channel === "query_for_device";
  }

  private buildLines(extra?: RoledLine): RoledLine[] {
    const base = transcriptToLines(
      this.scene.transcript.filter((e) => e.final && !this.isPrivateAside(e.channel)),
    );
    const trimmed = base.slice(-MAX_CONTEXT_LINES);
    return extra ? [...trimmed, extra] : trimmed;
  }

  private historyText(): string {
    return this.scene.transcript
      .filter((e) => e.final && !this.isPrivateAside(e.channel))
      .slice(-MAX_HISTORY_LINES)
      .map((e) => `${e.name}: ${e.text}`)
      .join("\n");
  }

  private voiceInstructions(char: CharacterState): string {
    const persona = char.persona ? ` Personality: ${char.persona.slice(0, 240)}.` : "";
    return `Speak as ${char.name}, in character, natural and conversational for a live scene.${persona}`;
  }
}
