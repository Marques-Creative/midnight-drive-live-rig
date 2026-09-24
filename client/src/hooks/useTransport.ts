import { useCallback, useEffect, useRef, useState } from "react";
import { io, Socket } from "socket.io-client";
import { useAudioEngine } from "./useAudioEngine";
import type { AudioEngineAPI, StemDescriptor } from "./useAudioEngine";

/**
 * useTransport — one transport API, two possible engines underneath.
 *
 * When the native ROCKDJ audio engine is connected, Play/Stop/Seek/load go to it
 * over Socket.IO (renderer → server → engine), and the clock (currentTime,
 * isPlaying, duration) comes from the engine's authoritative playhead. When the
 * native engine is NOT connected, everything falls back to the original Web Audio
 * engine, so the app still works exactly as before.
 *
 * This is the "automatic handoff": no double audio (only one engine plays at a
 * time), and always a working path. It exposes the same shape as useAudioEngine,
 * so LiveScreen barely changes.
 *
 * Live per-stem fader/mute changes to the native engine arrive in M3b-2; for now
 * initial stem gains/routes are seeded from the database at load time.
 */

export interface TransportAPI extends AudioEngineAPI {
  /** loadStems gains an optional songId so the native engine can load by song. */
  loadStems: (
    stems: StemDescriptor[],
    backingTrackUrl?: string | null,
    songId?: number,
  ) => Promise<void>;
  /** Send a live per-stem change to the native engine, addressed by stem index. */
  setStemNative: (index: number, patch: { gain?: number; muted?: boolean; route?: string }) => void;
  /** True when the native engine is driving (vs. the legacy Web Audio fallback). */
  nativeActive: boolean;

  // ── DJ clock / authority (DJ integration) ──
  clock: ClockState;
  setDjBpm: (bpm: number) => void;
  tapDownbeat: () => void;
  setMasterBpm: (bpm: number) => void;
  setDjRunning: (running: boolean) => void;
  /** Arm a deliberate, quantized authority change. */
  armHandoff: (target: "dj" | "rockdj", boundaryBeats: number) => void;
  cancelHandoff: () => void;
  /** Arm band transport to start on the next musical boundary. */
  armLaunch: (boundaryBeats: number) => void;
  cancelLaunch: () => void;

  // ── DJ decks ──
  decks: [DeckState, DeckState];
  deckWaveforms: [number[], number[]];
  masterDeck: number;
  crossfader: number;
  /** Load a track's STEMS onto a deck (they share one playhead). */
  loadDeck: (deck: number, stems: Array<{ fileKey: string; name: string; route?: string }>, bpm: number) => void;
  /** Load a track from the LIBRARY onto a deck by songId (one-tap, live-safe). */
  loadDeckSong: (deck: number, songId: number, bpm: number) => void;
  /** The Band Master's live control over a stem of the DJ's playing track. */
  setDeckStem: (deck: number, stem: number, patch: { gain?: number; muted?: boolean; route?: string }) => void;
  deckStems: [DeckStemState[], DeckStemState[]];
  /** Which library song is on each deck (null = ad-hoc files). */
  deckSongIds: [number | null, number | null];
  deckPlay: (deck: number) => void;
  deckPause: (deck: number) => void;
  /** Legacy one-shot back-cue (pause + return to cue point). */
  deckCue: (deck: number) => void;
  /** CDJ CUE press: playing → back-cue; paused → set cue + preview while held. */
  deckCueDown: (deck: number) => void;
  /** CDJ CUE release: if previewing, return to the cue point paused. */
  deckCueUp: (deck: number) => void;
  /** 3-band EQ per deck, gains in dB (-26 kill … 0 flat … +6). */
  setDeckEq: (deck: number, low: number, mid: number, high: number) => void;
  /** DJM-style filter knob: -1 full LPF … 0 off … +1 full HPF. */
  setDeckFilter: (deck: number, position: number) => void;
  /** Vinyl-style tempo: 1.0 = recorded speed (pitch follows, like a turntable). */
  setDeckRate: (deck: number, rate: number) => void;
  /** Cycle the tempo range: 6→10→16→100→6 (matches the RX3 TEMPO RANGE button). */
  cycleDeckTempoRange: (deck: number) => void;
  /** Manually correct a deck's detected BPM (grid, sync and echo follow it). */
  setDeckBpm: (deck: number, bpm: number) => void;
  /** One-shot SYNC: match the other deck's effective tempo + snap beat phase. */
  deckSync: (deck: number) => void;
  /** Hot cues: 8 slots per deck. A jump plays from that point (CDJ behaviour). */
  setHotCue: (deck: number, slot: number) => void;
  setHotCueDirect: (deck: number, slot: number, seconds: number) => void;
  jumpHotCue: (deck: number, slot: number) => void;
  deleteHotCue: (deck: number, slot: number) => void;
  /** Loops. loopBeats is the musical auto-loop: an exact N-beat hold. */
  deckLoopIn: (deck: number) => void;
  deckLoopOut: (deck: number) => void;
  deckLoopExit: (deck: number) => void;
  deckReloop: (deck: number) => void;
  deckLoopBeats: (deck: number, beats: number) => void;
  deckLoopScale: (deck: number, factor: number) => void;
  /** Pre-fader listen: hear this deck in the DJ's headphones only. */
  setDeckCue: (deck: number, on: boolean) => void;
  /** Assign buses to hardware channels (-1 = not connected; iemR/cueR -1 = mono). */
  setOutputRouting: (r: { fohL: number; fohR: number; iemL: number; iemR: number; cueL: number; cueR: number; deckAL?: number; deckAR?: number; deckBL?: number; deckBR?: number }) => void;
  /** MIDI control surface. */
  midiList: () => void;
  /** Ask the engine for the persisted DJ setup (it, not the browser, is the
      source of truth — a mapping must survive a restart). */
  getDjSettings: () => void;
  listAudioOutputs: () => void;
  setAudioOutput: (device: string) => void;
  midiOpen: (device: string) => void;
  setMidiBindings: (bindings: MidiBinding[]) => void;
  clearMidiBindings: () => void;
  midiOpenOut: (device: string) => void;
  midiListOut: () => void;
  midiOutDeviceList: string[];
  sendLedFeedback: (deck: number, note: number, vel: number) => void;
  sendMidiOut: (status: number, data1: number, data2: number) => void;
  setLibraryScrollDiv: (div: number) => void;
  /** Jog tuning: bend per tick, seconds per tick when paused, ease-out time. */
  setJogSensitivity: (nudge: number, search: number, decay: number) => void;
  deckSeek: (deck: number, seconds: number) => void;
  setCrossfader: (position: number) => void;
  setMasterDeck: (deck: number) => void;
  /** Channel fader (0..1 = silence..unity). */
  setDeckGain: (deck: number, gain: number) => void;
  /** Crossfader assign per deck: 0 = A, 1 = THRU, 2 = B (DJM behaviour). */
  setDeckXfAssign: (deck: number, assign: number) => void;
  /** Master Tempo: hold the track's key when tempo changes. */
  setDeckMasterTempo: (deck: number, on: boolean) => void;
  setDeckFxOn: (deck: number, on: boolean) => void;
  setDeckFxDepth: (deck: number, depth: number) => void;
  setDeckFxMode: (deck: number, mode: number) => void;
  /** Let the master deck follow whichever deck the room can hear. */
  setAutoMaster: (on: boolean) => void;
  /** Master output volume: 0..2 (0..200%). Double-click the slider to reset to 100%. */
  setMasterGain: (gain: number) => void;
  masterGain: number;
  masterPeak: number;
  masterCue: boolean;
  setMasterCue: (on: boolean) => void;
  broadcastTimer: (running: boolean, startTime: number) => void;
  setDeckDirectRoute: (deck: number, L: number, R: number) => void;
  // ── Ableton Link ──
  linkEnabled: boolean;
  linkPeers: number;
  linkTempo: number;
  linkBeat: number;
  linkPhase: number;
  linkQuantum: number;
  linkPlaying: boolean;
  linkTempoSource: string;
  // Link control commands
  linkEnable: (on: boolean) => void;
  linkSetQuantum: (q: number) => void;
  linkSetStartStop: (on: boolean) => void;
  linkSetPolicy: (policy: "accept"|"warn"|"restore"|"lock") => void;
  /** Per-deck trim in dB, applied pre-EQ to match levels between tracks. ±12 dB. */
  setDeckTrim: (deck: number, db: number) => void;
  /** Master Tempo: hold the track's key when tempo changes (pitch-preserving sync). */
  /** True while the master deck is following the DJ rather than pinned. */
  autoMaster: boolean;
}

interface EnginePlayhead {
  seconds: number;
  samples: number;
  duration: number;
  playing: boolean;
  authority?: "dj" | "rockdj" | "handoff";
  handoffTarget?: "dj" | "rockdj" | "handoff";
  bpm?: number;
  bar?: number;
  beat?: number;
  phase?: number;
  djRunning?: boolean;
  beatsUntilHandoff?: number;
  beatsUntilLaunch?: number;
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
  autoMaster?: boolean;
  masterDeck?: number;
  crossfader?: number;
  deckAStems?: DeckStemState[];
  deckBStems?: DeckStemState[];
  deckASongId?: number | null;
  deckBSongId?: number | null;
}

/** One stem of a deck's track — what the Band Master rides. */
export interface DeckStemState {
  index: number;
  name: string;
  gain: number;
  muted: boolean;
}

/** One learned MIDI control -> ROCKDJ action. */
export interface MidiBinding {
  status: number;   // 0x90 note, 0xB0 CC
  channel: number;  // 1-16, 0 = any
  data1: number;    // note / CC number
  action: string;
  deck: number;
  param?: number;
  /** Jog only: relative-encoder decoding (0 two's complement, 1 binary offset, 2 signed bit). */
  relMode?: number;
  /** 14-bit CC pair (MSB on data1, LSB on data1+32) — e.g. the RX3 tempo fader. */
  bit14?: boolean;
}

/** DJ deck state for a single deck. */
export interface DeckState {
  playing: boolean;
  loaded: boolean;
  seconds: number;
  duration: number;
  bpm: number;
  /** Cue point position in seconds. */
  cueSeconds: number;
  /** True while the deck is playing only because CUE is held (stutter preview). */
  cuePreview: boolean;
  /** Beat-1 anchor of the detected beatgrid, in seconds. */
  downbeatSeconds: number;
  /** Playback rate (1.0 = recorded tempo). Effective BPM = bpm × rate. */
  rate: number;
  /** Current pitch fader range in percent (6/10/16/100). */
  tempoRange: number;
  eqLow: number;
  eqMid: number;
  eqHigh: number;
  filter: number;
  /** 8 hot cue positions in seconds; -1 = empty slot. */
  hotCues: number[];
  looping: boolean;
  loopStart: number;
  loopEnd: number;
  /** Loop length in beats for auto-loops; 0 for a manual in/out loop. */
  loopBeats: number;
  /** True when this deck is in the DJ's headphones (pre-fader listen). */
  cueEnabled: boolean;
  /** Channel fader, 0..1. Pros mix on THIS, not the crossfader. */
  gain: number;
  /** Pre-EQ trim in dB. */
  trim: number;
  /** True when the deck is pitch-correcting tempo changes. */
  masterTempo: boolean;
  fxOn: boolean;
  fxDepth: number;
  fxMode: number;
  /** Post-fader output peak level: 0..1 = normal, >1 = clipping. */
  peak: number;
  /** Crossfader assign: 0 = A, 1 = THRU (bypassed), 2 = B. */
  xfAssign: number;
  /** What the room actually hears from this deck: playing x fader x crossfader. */
  audible: number;
  /** True when Master Tempo is holding pitch while the rate changes. */
}

/** Musical/clock state derived from the engine, for the CLOCK panel. */
export interface ClockState {
  authority: "dj" | "rockdj" | "handoff";
  handoffTarget: "dj" | "rockdj" | "handoff";
  bpm: number;
  bar: number;
  beat: number;
  djRunning: boolean;
  beatsUntilHandoff: number;
  beatsUntilLaunch: number;
}

// ── Deck loaded state cache: sessionStorage so navigation doesn't flash empty decks ──
// The playhead arrives within 50ms of reconnect, but without this cache the decks
// show as empty for that brief window — jarring mid-gig.
function getCachedDeckState(): [boolean, boolean] {
  try {
    const v = sessionStorage.getItem("rockdj.decksLoaded");
    if (v) return JSON.parse(v);
  } catch { /* ignore */ }
  return [false, false];
}
function cacheDeckState(a: boolean, b: boolean) {
  try { sessionStorage.setItem("rockdj.decksLoaded", JSON.stringify([a, b])); } catch { /* ignore */ }
}

// ── Waveform cache: module-level so data survives page navigation ──────────
// The engine only sends waveforms once at load time. If the user navigates
// away and back, React state is cleared but this cache is not.
const _waveformCache: [number[], number[]] = [[], []];

export function useTransport(): TransportAPI {
  const legacy = useAudioEngine();

  const [nativeConnected, setNativeConnected] = useState(false);
  const [playhead, setPlayhead] = useState<EnginePlayhead>({
    seconds: 0,
    samples: 0,
    duration: 0,
    playing: false,
  });
  const [midiOutDeviceList, setMidiOutDeviceList] = useState<string[]>([]);
  const [deckWaveforms, setDeckWaveforms] = useState<[number[], number[]]>(() => [_waveformCache[0], _waveformCache[1]]);

  const socketRef = useRef<Socket | null>(null);

  useEffect(() => {
    const socket = io(window.location.origin, { path: "/socket.io" });
    socketRef.current = socket;

    socket.on("engineStatus", (s: { connected: boolean }) =>
      setNativeConnected(Boolean(s?.connected)),
    );
    socket.on("enginePlayhead", (p: EnginePlayhead) => setPlayhead(p));
    socket.on("deckWaveform", (w: { deck: number; peaks: number[] }) => {
      const idx = w?.deck === 1 ? 1 : 0;
      const peaks = Array.isArray(w?.peaks) ? w.peaks : [];
      _waveformCache[idx] = peaks;          // persist across navigation
      setDeckWaveforms((prev) => {
        const next: [number[], number[]] = [prev[0], prev[1]];
        next[idx] = peaks;
        return next;
      });
    });
    // NOTE: we intentionally do NOT flip nativeConnected=false on socket
    // "disconnect". Socket.IO auto-reconnects and buffers emits; a transient
    // blip should not switch engines mid-song. The mode changes only when the
    // server tells us the engine's real connection state via engineStatus.

    return () => {
      socket.disconnect();
      socketRef.current = null;
    };
  }, []);

  const send = useCallback((cmd: Record<string, unknown>) => {
    socketRef.current?.emit("engineCommand", cmd);
  }, []);

  const nativeActive = nativeConnected;

  // ── Transport ─────────────────────────────────────────────────────────────
  // Rule: only ONE engine ever makes sound. Every transport action explicitly
  // silences the OTHER engine, so the old Web Audio engine can never be left
  // playing in the background (which would ignore FOH/IEM routing and dump
  // everything to the mains). This makes the handoff robust even if the native
  // "connected" status arrives late or blips.
  const play = useCallback(() => {
    if (nativeActive) {
      legacy.stop();          // make sure the old engine is silent
      send({ cmd: "play" });
    } else {
      legacy.play();
    }
  }, [nativeActive, send, legacy]);

  const pause = useCallback(() => {
    legacy.pause();           // harmless if the old engine isn't playing
    if (nativeActive) send({ cmd: "pause" });
  }, [nativeActive, send, legacy]);

  const stop = useCallback(() => {
    // Belt and suspenders: stop BOTH engines regardless of which we think is
    // active. This is what guarantees "Stop actually stops the sound."
    legacy.stop();
    send({ cmd: "stop" });
  }, [send, legacy]);

  const seek = useCallback(
    (time: number) => {
      if (nativeActive) send({ cmd: "seek", seconds: time });
      else legacy.seek(time);
    },
    [nativeActive, send, legacy],
  );

  const loadStems = useCallback(
    async (stems: StemDescriptor[], backingTrackUrl?: string | null, songId?: number) => {
      if (nativeActive && songId) {
        // When the native engine is active the band ALWAYS follows the DJ decks.
        // loadSong would race with the DJ deck audio callback — do not call it.
        // The Live Screen reads DJ deck audio directly; no separate band stems needed.
        legacy.stop();
      } else {
        await legacy.loadStems(stems, backingTrackUrl);
      }
    },
    [nativeActive, send, legacy],
  );

  const fadeOut = useCallback(
    (durationSec?: number) => {
      if (nativeActive) {
        legacy.stop();
        send({ cmd: "stop" }); // simple stop for now; true native fade in a later milestone
      } else {
        legacy.fadeOut(durationSec);
      }
    },
    [nativeActive, send, legacy],
  );

  // Per-stem live changes. When native is active we send them to the engine by
  // stem INDEX (its position in the song's stem list, which the engine uses).
  // We also call the legacy setters so the fallback engine stays in sync; those
  // are harmless when the old engine isn't the one playing.
  const setStemNative = useCallback(
    (index: number, patch: { gain?: number; muted?: boolean; route?: string }) => {
      if (nativeActive && index >= 0) send({ cmd: "setStem", index, ...patch });
    },
    [nativeActive, send],
  );

  const setStemVolume = legacy.setStemVolume;
  const setStemMuted = legacy.setStemMuted;

  // ── DJ clock / authority commands ──────────────────────────────────────────
  const setDjBpm = useCallback((bpm: number) => send({ cmd: "setDjBpm", bpm }), [send]);
  const tapDownbeat = useCallback(() => send({ cmd: "tapDownbeat" }), [send]);
  const setMasterBpm = useCallback((bpm: number) => send({ cmd: "setMasterBpm", bpm }), [send]);
  const setDjRunning = useCallback((running: boolean) => send({ cmd: "setDjRunning", running }), [send]);
  const armHandoff = useCallback(
    (target: "dj" | "rockdj", boundaryBeats: number) => send({ cmd: "armHandoff", target, boundaryBeats }),
    [send],
  );
  const cancelHandoff = useCallback(() => send({ cmd: "cancelHandoff" }), [send]);
  const armLaunch = useCallback((boundaryBeats: number) => send({ cmd: "armLaunch", boundaryBeats }), [send]);
  const cancelLaunch = useCallback(() => send({ cmd: "cancelLaunch" }), [send]);

  // ── DJ deck commands ────────────────────────────────────────────────────────
  const loadDeck = useCallback(
    (deck: number, stems: Array<{ fileKey: string; name: string; route?: string }>, bpm: number) =>
      send({ cmd: "loadDeck", deck, stems, bpm }),
    [send]);
  const loadDeckSong = useCallback(
    (deck: number, songId: number, bpm: number) => send({ cmd: "loadDeck", deck, songId, bpm }),
    [send]);
  // Self-healing waveform: ask the engine to resend peaks if we don't have them.
  // Runs on every playhead update so that page navigation (which clears React
  // state but not _waveformCache) reliably gets peaks back.
  const requestedRef = useRef<[boolean, boolean]>([false, false]);
  useEffect(() => {
    ([0, 1] as const).forEach((d) => {
      const loaded = d === 0 ? playhead.deckALoaded : playhead.deckBLoaded;
      const havePeaks = deckWaveforms[d].length > 0;
      if (loaded && !havePeaks && !requestedRef.current[d]) {
        requestedRef.current[d] = true;
        socketRef.current?.emit("engineCommand", { cmd: "getWaveform", deck: d });
      }
      if (!loaded) requestedRef.current[d] = false;
      if (havePeaks) requestedRef.current[d] = false;
    });
  }); // no deps — runs every render, idempotent due to requestedRef guard

  const setDeckStem = useCallback(
    (deck: number, stem: number, patch: { gain?: number; muted?: boolean; route?: string }) =>
      send({ cmd: "setDeckStem", deck, stem, ...patch }),
    [send]);
  const deckPlay = useCallback((deck: number) => send({ cmd: "deckPlay", deck }), [send]);
  const deckPause = useCallback((deck: number) => send({ cmd: "deckPause", deck }), [send]);
  const deckCue = useCallback((deck: number) => send({ cmd: "deckCue", deck }), [send]);
  const deckCueDown = useCallback((deck: number) => send({ cmd: "deckCueDown", deck }), [send]);
  const deckCueUp = useCallback((deck: number) => send({ cmd: "deckCueUp", deck }), [send]);
  const setDeckEq = useCallback(
    (deck: number, low: number, mid: number, high: number) => send({ cmd: "setDeckEq", deck, low, mid, high }),
    [send]);
  const setDeckFilter = useCallback(
    (deck: number, position: number) => send({ cmd: "setDeckFilter", deck, position }), [send]);
  const setDeckFxOn = useCallback((deck: number, on: boolean) => send({ cmd: 'setDeckFxOn', deck, on }), [send]);
  const setDeckFxMode = useCallback((deck: number, mode: number) => send({ cmd: 'setDeckFxMode', deck, mode }), [send]);
  const setDeckFxDepth = useCallback((deck: number, depth: number) => send({ cmd: 'setDeckFxDepth', deck, depth }), [send]);
  const cycleDeckTempoRange = useCallback((deck: number) => send({ cmd: "cycleDeckTempoRange", deck }), [send]);
  const setDeckBpm = useCallback((deck: number, bpm: number) => send({ cmd: "setDeckBpm", deck, bpm }), [send]);
  const setDeckRate = useCallback(
    (deck: number, rate: number) => send({ cmd: "setDeckRate", deck, rate }), [send]);
  const deckSync = useCallback((deck: number) => send({ cmd: "deckSync", deck }), [send]);
  const setHotCue = useCallback((deck: number, slot: number) => send({ cmd: "setHotCue", deck, slot }), [send]);
  const jumpHotCue = useCallback((deck: number, slot: number) => send({ cmd: "jumpHotCue", deck, slot }), [send]);
  const deleteHotCue = useCallback((deck: number, slot: number) => send({ cmd: "deleteHotCue", deck, slot }), [send]);
  const setMasterCue = useCallback((on: boolean) => send({ cmd: 'setMasterCue', on }), [send]);
  const broadcastTimer = useCallback((running: boolean, startTime: number) =>
    send({ cmd: 'setTimer', running, startTime }), [send]);
  const setDeckDirectRoute = useCallback((deck: number, L: number, R: number) => send({ cmd: 'setDeckDirectRoute', deck, L, R }), [send]);
  const setHotCueDirect = useCallback((deck: number, slot: number, seconds: number) =>
    send({ cmd: "setHotCueDirect", deck, slot, seconds }), [send]);
  const deckLoopIn = useCallback((deck: number) => send({ cmd: "deckLoopIn", deck }), [send]);
  const deckLoopOut = useCallback((deck: number) => send({ cmd: "deckLoopOut", deck }), [send]);
  const deckLoopExit = useCallback((deck: number) => send({ cmd: "deckLoopExit", deck }), [send]);
  const deckReloop = useCallback((deck: number) => send({ cmd: "deckReloop", deck }), [send]);
  const deckLoopBeats = useCallback((deck: number, beats: number) => send({ cmd: "deckLoopBeats", deck, beats }), [send]);
  const deckLoopScale = useCallback((deck: number, factor: number) => send({ cmd: "deckLoopScale", deck, factor }), [send]);
  const setDeckCue = useCallback((deck: number, on: boolean) => send({ cmd: "setDeckCue", deck, on }), [send]);
  const setOutputRouting = useCallback(
    (r: { fohL: number; fohR: number; iemL: number; iemR: number; cueL: number; cueR: number }) =>
      send({ cmd: "setOutputRouting", ...r }), [send]);
  const midiList = useCallback(() => send({ cmd: "midiList" }), [send]);
  const getDjSettings = useCallback(() => send({ cmd: "getDjSettings" }), [send]);
  const listAudioOutputs = useCallback(() => send({ cmd: "listAudioOutputs" }), [send]);
  const setAudioOutput = useCallback((device: string) => send({ cmd: "setAudioOutput", device }), [send]);
  const midiOpen = useCallback((device: string) => send({ cmd: "midiOpen", device }), [send]);
  const setMidiBindings = useCallback((bindings: MidiBinding[]) => send({ cmd: "setMidiBindings", bindings }), [send]);
  const clearMidiBindings = useCallback(() => send({ cmd: "clearMidiBindings" }), [send]);
  const linkEnable      = useCallback((on: boolean) => send({ cmd: "link.enable", enabled: on }), [send]);
  const linkSetQuantum  = useCallback((q: number) => send({ cmd: "link.setQuantum", quantum: q }), [send]);
  const linkSetStartStop= useCallback((on: boolean) => send({ cmd: "link.setStartStop", enabled: on }), [send]);
  const linkSetPolicy   = useCallback((policy: string) => send({ cmd: "link.setPolicy", policy }), [send]);
  const midiOpenOut = useCallback((device: string) => send({ cmd: "midiOpenOut", device }), [send]);
  const midiListOut = useCallback(() => send({ cmd: "midiListOut" }), [send]);
  const sendLedFeedback = useCallback((deck: number, note: number, vel: number) => send({ cmd: "ledFeedback", deck, note, vel }), [send]);
  const sendMidiOut = useCallback((status: number, data1: number, data2: number) => send({ cmd: "sendMidiOut", status, data1, data2 }), [send]);
  const setLibraryScrollDiv = useCallback((div: number) => send({ cmd: "setLibraryScrollDiv", div }), [send]);
  const setJogSensitivity = useCallback(
    (nudge: number, search: number, decay: number) => send({ cmd: "setJogSensitivity", nudge, search, decay }), [send]);
  const deckSeek = useCallback((deck: number, seconds: number) => send({ cmd: "deckSeek", deck, seconds }), [send]);
  const setCrossfader = useCallback((position: number) => send({ cmd: "setCrossfader", position }), [send]);
  const setMasterDeck = useCallback((deck: number) => send({ cmd: "setMasterDeck", deck }), [send]);
  const setDeckGain = useCallback((deck: number, gain: number) => send({ cmd: "setDeckGain", deck, gain }), [send]);
  const setDeckMasterTempo = useCallback((deck: number, on: boolean) => send({ cmd: "setDeckMasterTempo", deck, on }), [send]);
  const setDeckXfAssign = useCallback((deck: number, assign: number) => send({ cmd: "setDeckXfAssign", deck, assign }), [send]);
  const setAutoMaster = useCallback((on: boolean) => send({ cmd: "setAutoMaster", on }), [send]);
  const setMasterGain = useCallback((gain: number) => send({ cmd: 'setMasterGain', gain }), [send]);
  const setDeckTrim = useCallback((deck: number, db: number) => send({ cmd: 'setDeckTrim', deck, db }), [send]);

  const decks: [DeckState, DeckState] = [
    {
      playing: Boolean(playhead.deckAPlaying),
      loaded: Boolean(playhead.deckALoaded),
      seconds: playhead.deckASeconds ?? 0,
      duration: playhead.deckADuration ?? 0,
      bpm: playhead.deckABpm ?? 0,
      cueSeconds: playhead.deckACue ?? 0,
      cuePreview: Boolean(playhead.deckACuePreview),
      rate: playhead.deckARate ?? 1,
      tempoRange: playhead.deckATempoRange ?? 8,
      eqLow: playhead.deckAEqLow ?? 0,
      eqMid: playhead.deckAEqMid ?? 0,
      eqHigh: playhead.deckAEqHigh ?? 0,
      filter: playhead.deckAFilter ?? 0,
      hotCues: playhead.deckAHotCues ?? [],
      looping: Boolean(playhead.deckALooping),
      loopStart: playhead.deckALoopStart ?? -1,
      loopEnd: playhead.deckALoopEnd ?? -1,
      loopBeats: playhead.deckALoopBeats ?? 0,
      cueEnabled: Boolean(playhead.deckACueEnabled),
      gain: playhead.deckAGain ?? 1,
      trim: playhead.deckATrim ?? 0,
      xfAssign: playhead.deckAXfAssign ?? 1,
      audible: playhead.deckAAudible ?? 0,
      masterTempo: Boolean(playhead.deckAMasterTempo),
      fxOn: Boolean(playhead.deckAFxOn),
      fxDepth: playhead.deckAFxDepth ?? 0,
      fxMode: playhead.deckAFxMode ?? 0,
      peak: playhead.deckAPeak ?? 0,
      downbeatSeconds: playhead.deckADownbeat ?? 0,
    },
    {
      playing: Boolean(playhead.deckBPlaying),
      loaded: Boolean(playhead.deckBLoaded),
      seconds: playhead.deckBSeconds ?? 0,
      duration: playhead.deckBDuration ?? 0,
      bpm: playhead.deckBBpm ?? 0,
      cueSeconds: playhead.deckBCue ?? 0,
      cuePreview: Boolean(playhead.deckBCuePreview),
      rate: playhead.deckBRate ?? 1,
      tempoRange: playhead.deckBTempoRange ?? 8,
      eqLow: playhead.deckBEqLow ?? 0,
      eqMid: playhead.deckBEqMid ?? 0,
      eqHigh: playhead.deckBEqHigh ?? 0,
      filter: playhead.deckBFilter ?? 0,
      hotCues: playhead.deckBHotCues ?? [],
      looping: Boolean(playhead.deckBLooping),
      loopStart: playhead.deckBLoopStart ?? -1,
      loopEnd: playhead.deckBLoopEnd ?? -1,
      loopBeats: playhead.deckBLoopBeats ?? 0,
      cueEnabled: Boolean(playhead.deckBCueEnabled),
      gain: playhead.deckBGain ?? 1,
      trim: playhead.deckBTrim ?? 0,
      xfAssign: playhead.deckBXfAssign ?? 1,
      audible: playhead.deckBAudible ?? 0,
      masterTempo: Boolean(playhead.deckBMasterTempo),
      fxOn: Boolean(playhead.deckBFxOn),
      fxDepth: playhead.deckBFxDepth ?? 0,
      fxMode: playhead.deckBFxMode ?? 0,
      peak: playhead.deckBPeak ?? 0,
      downbeatSeconds: playhead.deckBDownbeat ?? 0,
    },
  ];

  const clock: ClockState = {
    authority: playhead.authority ?? "rockdj",
    handoffTarget: playhead.handoffTarget ?? "rockdj",
    bpm: playhead.bpm ?? 0,
    bar: playhead.bar ?? 1,
    beat: playhead.beat ?? 1,
    djRunning: Boolean(playhead.djRunning),
    beatsUntilHandoff: playhead.beatsUntilHandoff ?? -1,
    beatsUntilLaunch: playhead.beatsUntilLaunch ?? -1,
  };

  return {
    status: legacy.status,
    error: legacy.error,
    resumeContext: legacy.resumeContext,

    // Clock + transport state: native when active, else legacy.
    isPlaying: nativeActive ? playhead.playing : legacy.isPlaying,
    isPaused: nativeActive ? false : legacy.isPaused,
    currentTime: nativeActive ? playhead.seconds : legacy.currentTime,
    duration: nativeActive ? playhead.duration || legacy.duration : legacy.duration,

    loadStems,
    play,
    pause,
    stop,
    seek,
    setStemVolume,
    setStemMuted,
    setStemNative,
    fadeOut,
    nativeActive,
    clock,
    setDjBpm,
    tapDownbeat,
    setMasterBpm,
    setDjRunning,
    armHandoff,
    cancelHandoff,
    armLaunch,
    cancelLaunch,
    decks,
    deckWaveforms,
    masterDeck: playhead.masterDeck ?? 0,
    crossfader: playhead.crossfader ?? 0.5,
    loadDeck,
    loadDeckSong,
    setDeckStem,
    deckStems: [playhead.deckAStems ?? [], playhead.deckBStems ?? []] as [DeckStemState[], DeckStemState[]],
    deckSongIds: [playhead.deckASongId ?? null, playhead.deckBSongId ?? null] as [number | null, number | null],
    deckPlay,
    deckPause,
    deckCue,
    deckCueDown,
    deckCueUp,
    setDeckEq,
    setDeckFilter,
    setDeckRate,
    setDeckFxOn,
    setDeckFxDepth,
    setDeckFxMode,
    cycleDeckTempoRange,
    setDeckBpm,
    deckSync,
    setHotCue,
    jumpHotCue,
    deleteHotCue,
    deckLoopIn,
    deckLoopOut,
    deckLoopExit,
    deckReloop,
    deckLoopBeats,
    deckLoopScale,
    setDeckCue,
    setOutputRouting,
    midiList,
    getDjSettings,
    listAudioOutputs,
    setAudioOutput,
    midiOpen,
    setMidiBindings,
    clearMidiBindings,
    setHotCueDirect,
    midiOpenOut,
    midiListOut,
    midiOutDeviceList,
    setMasterCue,
    setDeckDirectRoute,
    broadcastTimer,
    sendLedFeedback,
    sendMidiOut,
    setLibraryScrollDiv,
    setJogSensitivity,
    deckSeek,
    setCrossfader,
    setMasterDeck,
    setDeckGain,
    setDeckMasterTempo,
    setDeckXfAssign,
    setAutoMaster,
    setMasterGain,
    setDeckTrim,

    autoMaster: Boolean(playhead.autoMaster),
    masterGain: playhead.masterGain ?? 1,
    masterPeak: playhead.masterPeak ?? 0,
    masterCue: playhead.masterCue ?? false,
    linkEnabled: playhead.linkEnabled ?? false,
    linkPeers: playhead.linkPeers ?? 0,
    linkTempo: playhead.linkTempo ?? 120,
    linkBeat: playhead.linkBeat ?? 0,
    linkPhase: playhead.linkPhase ?? 0,
    linkQuantum: playhead.linkQuantum ?? 4,
    linkPlaying: playhead.linkPlaying ?? false,
    linkTempoSource: playhead.linkTempoSource ?? "dj",
    linkEnable,
    linkSetQuantum,
    linkSetStartStop,
    linkSetPolicy,
  };
}
