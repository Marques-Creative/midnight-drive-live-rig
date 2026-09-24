import { Server as HttpServer } from "http";
import { Server as SocketIOServer } from "socket.io";
import type { PlaybackState } from "../shared/socketTypes";

export type { PlaybackState };

// ── Transport commands sent from companion → host ─────────────────────────
export type TransportCommand =
  | { type: "play" }
  | { type: "pause" }
  | { type: "stop" }
  | { type: "next" }
  | { type: "prev" }
  | { type: "seek"; time: number };

let io: SocketIOServer | null = null;

// ── Waveform cache: replayed to every new client ────────────────────────────
const deckWaveformCache: ({ deck: number; peaks: number[]; duration: number; bpm: number } | null)[] = [null, null];
export function setDeckWaveformCache(deck: number, data: { peaks: number[]; duration: number; bpm: number }) {
  deckWaveformCache[deck] = { deck, ...data };
}

// ── Native audio engine status (relayed from the JUCE engine) ─────────────
// The renderer subscribes to `engineStatus` to show whether the native audio
// engine is connected and ready (e.g. "Scarlett 2i4 — 4 outs, routing ready").
export interface EngineStatusWire {
  connected: boolean;
  device: string;
  outputs: number;
  sampleRate: number;
  playing: boolean;
  readyForRouting: boolean;
}
let engineStatus: EngineStatusWire = {
  connected: false,
  device: "none",
  outputs: 0,
  sampleRate: 0,
  playing: false,
  readyForRouting: false,
};
export function setEngineStatus(status: EngineStatusWire) {
  engineStatus = status;
  io?.emit("engineStatus", engineStatus);
}
export function getEngineStatus() { return engineStatus; }

// Engine playhead (authoritative clock) relayed to UI + companions.
export interface EnginePlayheadWire {
  seconds: number;
  samples: number;
  duration: number;
  playing: boolean;
  // Clock authority + musical position (DJ integration).
  authority?: "dj" | "rockdj" | "handoff";
  handoffTarget?: "dj" | "rockdj" | "handoff";
  bpm?: number;
  bar?: number;
  beat?: number;
  phase?: number;
  djRunning?: boolean;
  beatsUntilHandoff?: number;
  beatsUntilLaunch?: number;
  // DJ decks
  deckAPlaying?: boolean;
  deckALoaded?: boolean;
  deckASeconds?: number;
  deckADuration?: number;
  deckABpm?: number;
  deckACue?: number;
  deckACuePreview?: boolean;
  deckADownbeat?: number;
  deckARate?: number;
  deckATempoRange?: number;
  deckAEqLow?: number;
  deckAEqMid?: number;
  deckAEqHigh?: number;
  deckAFilter?: number;
  deckACueEnabled?: boolean;
  deckAGain?: number;
  deckATrim?: number;
  deckAMasterTempo?: boolean;
  deckAFxOn?: boolean;
  deckAFxDepth?: number;
  deckAFxMode?: number;
  deckAPeak?: number;
  deckAXfAssign?: number;
  deckAAudible?: number;
  deckAHotCues?: number[];
  deckALooping?: boolean;
  deckALoopStart?: number;
  deckALoopEnd?: number;
  deckALoopBeats?: number;
  deckBPlaying?: boolean;
  deckBLoaded?: boolean;
  deckBSeconds?: number;
  deckBDuration?: number;
  deckBBpm?: number;
  deckBCue?: number;
  deckBCuePreview?: boolean;
  deckBDownbeat?: number;
  deckBRate?: number;
  deckBTempoRange?: number;
  deckBEqLow?: number;
  deckBEqMid?: number;
  deckBEqHigh?: number;
  deckBFilter?: number;
  deckBCueEnabled?: boolean;
  deckBGain?: number;
  deckBTrim?: number;
  deckBMasterTempo?: boolean;
  deckBFxOn?: boolean;
  deckBFxDepth?: number;
  deckBFxMode?: number;
  deckBPeak?: number;
  deckBXfAssign?: number;
  deckBAudible?: number;
  deckBHotCues?: number[];
  deckBLooping?: boolean;
  deckBLoopStart?: number;
  deckBLoopEnd?: number;
  deckBLoopBeats?: number;
  autoMaster?: boolean;
  masterDeck?: number;
  masterGain?: number;
  masterPeak?: number;
  masterCue?: boolean;
  timerRunning?: boolean;
  timerStartTime?: number;
  linkEnabled?: boolean;
  linkPeers?: number;
  linkTempo?: number;
  linkBeat?: number;
  linkPhase?: number;
  linkQuantum?: number;
  linkPlaying?: boolean;
  linkTempoSource?: string;
  crossfader?: number;
  deckAStems?: Array<{ index: number; name: string; gain: number; muted: boolean }>;
  deckBStems?: Array<{ index: number; name: string; gain: number; muted: boolean }>;
  deckASongId?: number | null;
  deckBSongId?: number | null;
}
let enginePlayhead: EnginePlayheadWire = { seconds: 0, samples: 0, duration: 0, playing: false };
export function setEnginePlayhead(p: EnginePlayheadWire) {
  enginePlayhead = p;
  io?.emit("enginePlayhead", p);
}
export function getEnginePlayhead() { return enginePlayhead; }

// Generic relay for one-off engine events (e.g. "engineLoaded").
export function emitEngineEvent(event: string, payload: unknown) {
  io?.emit(event, payload);
}
let currentState: PlaybackState = {
  songId: null,
  songTitle: "No song loaded",
  artist: "",
  bpm: null,
  key: null,
  duration: null,
  isPlaying: false,
  isPaused: false,
  currentTime: 0,
  setListId: null,
  setListName: "",
  currentIndex: 0,
  totalSongs: 0,
  nextSongTitle: "",
  nextSongArtist: "",
  nextSongBpm: null,
  nextSongKey: null,
  lyrics: "",
  lyricsScrollPosition: 0,
  stems: [],
  connectedCompanions: 0,
  lyricCues: [],
  activeCueIndex: -1,
  lyricViewMode: "karaoke",
};

/**
 * Companion PIN — the gate between "anyone on the venue WiFi" and the show.
 * Generated fresh each boot (or pinned via ROCKDJ_PIN). The QR code on the
 * host embeds it, so the band's flow is unchanged: scan → connected. Manual
 * connections type the 4 digits once.
 */
export const COMPANION_PIN: string =
  process.env.ROCKDJ_PIN && /^\d{4,8}$/.test(process.env.ROCKDJ_PIN)
    ? process.env.ROCKDJ_PIN
    : String(Math.floor(1000 + Math.random() * 9000));

/** Pure auth check (unit-tested): companions need the PIN, the host does not. */
export function isSocketAuthorized(query: Record<string, unknown>): boolean {
  if (query.role !== "companion") return true; // host UI runs on the Mac itself
  return typeof query.pin === "string" && query.pin === COMPANION_PIN;
}

export function initSocketIO(httpServer: HttpServer) {
  io = new SocketIOServer(httpServer, {
    cors: { origin: "*", methods: ["GET", "POST"] },
    path: "/socket.io",
  });

  console.log(`[Socket.IO] Companion PIN: ${COMPANION_PIN}`);

  // Reject unauthorized companions BEFORE they see any state or can send any
  // command. The client receives a connect_error with message "PIN_REQUIRED".
  io.use((socket, next) => {
    if (isSocketAuthorized(socket.handshake.query as Record<string, unknown>)) return next();
    next(new Error("PIN_REQUIRED"));
  });

  io.on("connection", (socket) => {
    const isCompanion = socket.handshake.query.role === "companion";
    console.log(`[Socket.IO] Client connected: ${socket.id} role=${isCompanion ? "companion" : "host"}`);

    if (isCompanion) {
      currentState = { ...currentState, connectedCompanions: (currentState.connectedCompanions || 0) + 1 };
      io?.emit("state", currentState);
    }

    socket.emit("state", currentState);
    socket.emit("engineStatus", engineStatus);
    socket.emit("enginePlayhead", enginePlayhead);
    // Replay cached waveforms so the client doesn't need to request them
    deckWaveformCache.forEach((w) => { if (w) socket.emit("deckWaveform", w); });

    // Transport commands from the UI (Play/Stop/Seek/loadSong/setStem) → engine.
    socket.on("engineCommand", (cmd: Record<string, unknown>) => {
      // Imported lazily to avoid a circular import at module load.
      void import("./engineClient").then((m) => m.handleEngineCommand(cmd));
    });

    socket.on("updateState", (patch: Partial<PlaybackState>) => {
      currentState = { ...currentState, ...patch };
      io?.emit("state", currentState);
    });

    socket.on("broadcastState", () => {
      io?.emit("state", currentState);
    });

    // Companion → host transport commands.
    // Only companions can send these; the server forwards to all clients so
    // the host LiveScreen can drive the audio engine.
    socket.on("transportCommand", (cmd: TransportCommand) => {
      if (isCompanion) {
        io?.emit("transportCommand", cmd);
      }
    });

    socket.on("disconnect", () => {
      if (isCompanion) {
        currentState = { ...currentState, connectedCompanions: Math.max(0, (currentState.connectedCompanions || 1) - 1) };
        io?.emit("state", currentState);
      }
      console.log(`[Socket.IO] Client disconnected: ${socket.id}`);
    });
  });

  return io;
}

export function getIO() { return io; }
export function getCurrentState() { return currentState; }
export function broadcastState(patch?: Partial<PlaybackState>) {
  if (patch) currentState = { ...currentState, ...patch };
  io?.emit("state", currentState);
}
