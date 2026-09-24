/**
 * engineClient.ts — the server's connection to the native ROCKDJ audio engine.
 *
 * The Electron main process launches the `rockdj-engine` binary and tells us
 * (via the ROCKDJ_ENGINE_PORT env var) which localhost port it's listening on.
 * We open a TCP connection to it, speak the newline-delimited JSON protocol, and
 * relay the engine's status to the UI over the Socket.IO channel the app already
 * uses. This is also the path that will carry transport commands in Milestone 3b.
 *
 * The connection retries forever with a short backoff, so the order in which the
 * engine and server start doesn't matter, and a restarted engine reconnects.
 */

import net from "net";
import { setEngineStatus, setEnginePlayhead, emitEngineEvent, setDeckWaveformCache } from "./socket";
import { getStemsBySongId, getSongById } from "./db";
import { storageKeyToPath } from "./storage";

export interface EngineStatus {
  connected: boolean;          // is the TCP link to the engine up?
  device: string;              // audio device name, or "none"
  outputs: number;             // active output channels
  sampleRate: number;
  playing: boolean;
  readyForRouting: boolean;    // true when >= 4 outputs (FOH + IEM)
}

const DISCONNECTED: EngineStatus = {
  connected: false,
  device: "none",
  outputs: 0,
  sampleRate: 0,
  playing: false,
  readyForRouting: false,
};

let socket: net.Socket | null = null;
let buffer = "";
let pingTimer: NodeJS.Timeout | null = null;
let reconnectTimer: NodeJS.Timeout | null = null;
let stopped = false;
let pingId = 0;
// Which library song is loaded on each deck. The engine deals in stems/paths;
// the server owns this mapping so the UI can mirror the DJ (lyrics, chords,
// mixer) for whatever track is on the master deck.
const deckSongIds: (number | null)[] = [null, null];

function log(msg: string) {
  console.log(`[EngineClient] ${msg}`);
}

/** Send one JSON command (newline-delimited) to the engine, if connected. */
export function sendToEngine(cmd: Record<string, unknown>): boolean {
  if (socket && !socket.destroyed) {
    socket.write(JSON.stringify(cmd) + "\n");
    return true;
  }
  return false;
}

/**
 * Handle a transport command coming from the UI (over Socket.IO). Most commands
 * pass straight through. `loadSong` is special: the UI sends only a songId, and
 * the SERVER looks up that song's stems in the database and resolves their real
 * file paths, routes and gains. This means the renderer never supplies file
 * paths — a small but real security/robustness win.
 */
export async function handleEngineCommand(cmd: Record<string, unknown>): Promise<void> {
  if (cmd.cmd === "loadSong") {
    const songId = Number(cmd.songId);
    if (!songId) return;
    try {
      const rows = await getStemsBySongId(songId);
      const stems = rows
        .filter((r) => r.fileKey)
        .map((r) => ({
          path: storageKeyToPath(r.fileKey as string),
          name: r.name,
          // main -> FOH (out 1-2); click/guide -> IEM (out 3-4)
          route: r.outputRoute === "main" ? "foh" : "iem",
          gain: r.volume ?? 1,
          muted: r.muted ?? false,
        }));
      sendToEngine({ cmd: "loadSong", songId, stems });
      log(`loadSong ${songId}: sent ${stems.length} stems to engine`);
    } catch (e) {
      log(`loadSong ${songId} failed: ${(e as Error).message}`);
    }
    return;
  }
  // play / stop / seek / setStem / setBpm / triggerSample pass straight through.
  if (cmd.cmd === "loadDeck") {
    const deck = Number(cmd.deck ?? 0);

    // Fast path for live use: load a track from the LIBRARY by songId. The
    // server resolves the song's stems + paths + routes from the database, so
    // the DJ taps once and the deck is loaded — no file picking mid-show.
    if (cmd.songId) {
      const songId = Number(cmd.songId);
      try {
        const rows = await getStemsBySongId(songId);
        const stems = rows
          .filter((r) => r.fileKey)
          .map((r) => ({
            path: storageKeyToPath(r.fileKey as string),
            name: r.name,
            route: r.outputRoute === "main" ? "foh" : "iem", // click/guide -> in-ears
            gain: r.volume ?? 1,
            muted: r.muted ?? false,
          }));
        if (stems.length === 0) {
          log(`loadDeck[${deck === 0 ? "A" : "B"}]: song ${songId} has no stems`);
          return;
        }
        setDeckWaveformCache(deck, { peaks: [], duration: 0, bpm: 0 }); // clear stale waveform
        // Fetch hot cues from DB and send them with loadDeck so the engine
        // sets them atomically right after loading stems. No client-side
        // restore timing issues.
        const song = await getSongById(songId);
        let hotCues: number[] = Array(8).fill(-1);
        try { hotCues = JSON.parse(song?.hotCues ?? "null") ?? Array(8).fill(-1); } catch { /* */ }
        const activeCues = hotCues.filter(v => v >= 0).length;
        log(`loadDeck[${deck===0?"A":"B"}] song ${songId}: ${stems.length} stems, ${activeCues} hot cues (${JSON.stringify(hotCues)})`);
        sendToEngine({ cmd: "loadDeck", deck, bpm: Number(cmd.bpm ?? 120), stems, hotCues });
        deckSongIds[deck] = songId;
        // Auto-fire MIDI patches for this song (non-blocking)
        getSongById(songId).then((song) => {
          if (!song?.midiPatches) return;
          try {
            const patches = JSON.parse(song.midiPatches) as Array<{
              type: string; channel: number; program?: number;
              bankMSB?: number; bankLSB?: number; cc?: number; value?: number; delayMs?: number;
            }>;
            let delay = 0;
            for (const patch of patches) {
              const d = delay;
              setTimeout(() => {
                const ch = Math.max(1, Math.min(16, patch.channel ?? 1)) - 1; // 0-indexed
                if (patch.type === "bank+pc") {
                  // Bank Select MSB (CC 0), Bank Select LSB (CC 32), then Program Change
                  sendToEngine({ cmd: "sendMidiOut", status: 0xB0 | ch, data1: 0,  data2: patch.bankMSB ?? 0 });
                  sendToEngine({ cmd: "sendMidiOut", status: 0xB0 | ch, data1: 32, data2: patch.bankLSB ?? 0 });
                  sendToEngine({ cmd: "sendMidiOut", status: 0xC0 | ch, data1: patch.program ?? 0, data2: 0 });
                } else if (patch.type === "pc") {
                  sendToEngine({ cmd: "sendMidiOut", status: 0xC0 | ch, data1: patch.program ?? 0, data2: 0 });
                } else if (patch.type === "cc") {
                  sendToEngine({ cmd: "sendMidiOut", status: 0xB0 | ch, data1: patch.cc ?? 0, data2: patch.value ?? 0 });
                }
              }, d);
              delay += patch.delayMs ?? 20; // stagger messages so hardware can keep up
            }
          } catch { /* invalid JSON, ignore */ }
        }).catch(() => {});
        log(`loadDeck[${deck === 0 ? "A" : "B"}]: song \${songId} — ${stems.length} stems`);
      } catch (e) {
        log(`loadDeck song ${songId} failed: ${(e as Error).message}`);
      }
      return;
    }

    // Ad-hoc path: the UI uploaded stem files and sends their storage fileKeys.
    const rawStems = Array.isArray(cmd.stems) ? (cmd.stems as Array<Record<string, unknown>>) : [];
    const stems = rawStems
      .filter((s) => s && s.fileKey)
      .map((s) => ({
        path: storageKeyToPath(String(s.fileKey)),
        name: String(s.name ?? "Stem"),
        route: String(s.route ?? "foh") === "iem" ? "iem" : "foh",
        gain: Number(s.gain ?? 1),
        muted: Boolean(s.muted),
      }));
    if (stems.length === 0) return;
    sendToEngine({ cmd: "loadDeck", deck, bpm: Number(cmd.bpm ?? 120), stems });
    deckSongIds[deck] = null;   // ad-hoc files aren't a library track
    log(`loadDeck[${deck === 0 ? "A" : "B"}]: ${stems.length} stems @ ${cmd.bpm} BPM`);
    return;
  }
  sendToEngine(cmd);
}

function handleEvent(evt: Record<string, unknown>) {
  switch (evt.evt) {
    case "ready":
      log(`Engine ready (version ${evt.version ?? "?"})`);
      break;
    case "status":
      setEngineStatus({
        connected: true,
        device: String(evt.device ?? "none"),
        outputs: Number(evt.outputs ?? 0),
        sampleRate: Number(evt.sampleRate ?? 0),
        playing: Boolean(evt.playing),
        readyForRouting: Boolean(evt.readyForRouting),
      });
      break;
    case "pong":
      // Health check succeeded; nothing else needed for now.
      break;
    case "playhead":
      // The engine's authoritative clock — relay to the UI + companions.
      setEnginePlayhead({
        seconds: Number(evt.seconds ?? 0),
        samples: Number(evt.samples ?? 0),
        duration: Number(evt.duration ?? 0),
        playing: Boolean(evt.playing),
        authority: (evt.authority as "dj" | "rockdj" | "handoff") ?? "rockdj",
        handoffTarget: (evt.handoffTarget as "dj" | "rockdj" | "handoff") ?? "rockdj",
        bpm: Number(evt.bpm ?? 0),
        bar: Number(evt.bar ?? 1),
        beat: Number(evt.beat ?? 1),
        phase: Number(evt.phase ?? 0),
        djRunning: Boolean(evt.djRunning),
        beatsUntilHandoff: Number(evt.beatsUntilHandoff ?? -1),
        beatsUntilLaunch: Number(evt.beatsUntilLaunch ?? -1),
        deckAPlaying: Boolean(evt.deckAPlaying),
        deckALoaded: Boolean(evt.deckALoaded),
        deckASeconds: Number(evt.deckASeconds ?? 0),
        deckADuration: Number(evt.deckADuration ?? 0),
        deckABpm: Number(evt.deckABpm ?? 0),
        deckACue: Number(evt.deckACue ?? 0),
        deckACuePreview: Boolean(evt.deckACuePreview),
        deckADownbeat: Number(evt.deckADownbeat ?? 0),
        deckARate: Number(evt.deckARate ?? 1),
        deckATempoRange: Number(evt.deckATempoRange ?? 8),
        deckAEqLow: Number(evt.deckAEqLow ?? 0),
        deckAEqMid: Number(evt.deckAEqMid ?? 0),
        deckAEqHigh: Number(evt.deckAEqHigh ?? 0),
        deckAFilter: Number(evt.deckAFilter ?? 0),
        deckACueEnabled: Boolean(evt.deckACueEnabled),
        deckAGain: Number(evt.deckAGain ?? 1),
        deckATrim: Number(evt.deckATrim ?? 0),
        deckAAudible: Number(evt.deckAAudible ?? 0),
        deckAMasterTempo: Boolean(evt.deckAMasterTempo),
        deckAFxOn: Boolean(evt.deckAFxOn),
        deckAFxDepth: Number(evt.deckAFxDepth ?? 0),
        deckAFxMode: Number(evt.deckAFxMode ?? 0),
        deckAPeak: Number(evt.deckAPeak ?? 0),
        deckAXfAssign: Number(evt.deckAXfAssign ?? 1),
        deckAHotCues: Array.isArray(evt.deckAHotCues)
          ? (evt.deckAHotCues as unknown[]).map((v) => Number(v))
          : [],
        deckALooping: Boolean(evt.deckALooping),
        deckALoopStart: Number(evt.deckALoopStart ?? -1),
        deckALoopEnd: Number(evt.deckALoopEnd ?? -1),
        deckALoopBeats: Number(evt.deckALoopBeats ?? 0),
        deckBPlaying: Boolean(evt.deckBPlaying),
        deckBLoaded: Boolean(evt.deckBLoaded),
        deckBSeconds: Number(evt.deckBSeconds ?? 0),
        deckBDuration: Number(evt.deckBDuration ?? 0),
        deckBBpm: Number(evt.deckBBpm ?? 0),
        deckBCue: Number(evt.deckBCue ?? 0),
        deckBCuePreview: Boolean(evt.deckBCuePreview),
        deckBDownbeat: Number(evt.deckBDownbeat ?? 0),
        deckBRate: Number(evt.deckBRate ?? 1),
        deckBTempoRange: Number(evt.deckBTempoRange ?? 8),
        deckBEqLow: Number(evt.deckBEqLow ?? 0),
        deckBEqMid: Number(evt.deckBEqMid ?? 0),
        deckBEqHigh: Number(evt.deckBEqHigh ?? 0),
        deckBFilter: Number(evt.deckBFilter ?? 0),
        deckBCueEnabled: Boolean(evt.deckBCueEnabled),
        deckBGain: Number(evt.deckBGain ?? 1),
        deckBTrim: Number(evt.deckBTrim ?? 0),
        deckBAudible: Number(evt.deckBAudible ?? 0),
        deckBMasterTempo: Boolean(evt.deckBMasterTempo),
        deckBFxOn: Boolean(evt.deckBFxOn),
        deckBFxDepth: Number(evt.deckBFxDepth ?? 0),
        deckBFxMode: Number(evt.deckBFxMode ?? 0),
        deckBPeak: Number(evt.deckBPeak ?? 0),
        deckBXfAssign: Number(evt.deckBXfAssign ?? 1),
        deckBHotCues: Array.isArray(evt.deckBHotCues)
          ? (evt.deckBHotCues as unknown[]).map((v) => Number(v))
          : [],
        deckBLooping: Boolean(evt.deckBLooping),
        deckBLoopStart: Number(evt.deckBLoopStart ?? -1),
        deckBLoopEnd: Number(evt.deckBLoopEnd ?? -1),
        deckBLoopBeats: Number(evt.deckBLoopBeats ?? 0),
        autoMaster: Boolean(evt.autoMaster),
        masterDeck: Number(evt.masterDeck ?? 0),
        crossfader: Number(evt.crossfader ?? 0.5),
        masterGain: Number(evt.masterGain ?? 1),
        masterPeak: Number(evt.masterPeak ?? 0),
        masterCue: Boolean(evt.masterCue ?? false),
        timerRunning: Boolean(evt.timerRunning ?? false),
        timerStartTime: Number(evt.timerStartTime ?? 0),
        linkEnabled:     Boolean(evt.linkEnabled ?? false),
        linkPeers:       Number(evt.linkPeers ?? 0),
        linkTempo:       Number(evt.linkTempo ?? 120),
        linkBeat:        Number(evt.linkBeat ?? 0),
        linkPhase:       Number(evt.linkPhase ?? 0),
        linkQuantum:     Number(evt.linkQuantum ?? 4),
        linkPlaying:     Boolean(evt.linkPlaying ?? false),
        linkTempoSource: String(evt.linkTempoSource ?? "dj"),
        deckAStems: Array.isArray(evt.deckAStems) ? evt.deckAStems : [],
        deckBStems: Array.isArray(evt.deckBStems) ? evt.deckBStems : [],
        deckASongId: deckSongIds[0],
        deckBSongId: deckSongIds[1],
      });
      break;
    case "loaded":
      emitEngineEvent("engineLoaded", {
        ok: Boolean(evt.ok),
        stems: Number(evt.stems ?? 0),
        duration: Number(evt.duration ?? 0),
        songId: evt.songId ?? null,
      });
      break;
    case "error":
      log(`Engine error: ${evt.message ?? "(unknown)"}`);
      break;
    case "deckLoaded":
      emitEngineEvent("deckLoaded", { deck: Number(evt.deck ?? 0), ok: Boolean(evt.ok), bpm: Number(evt.bpm ?? 0), duration: Number(evt.duration ?? 0) });
      break;
    case "deckWaveform": {
      const wData = {
        deck: Number(evt.deck ?? 0),
        peaks: Array.isArray(evt.peaks) ? evt.peaks : [],
        duration: Number(evt.duration ?? 0),
        bpm: Number(evt.bpm ?? 0),
      };
      setDeckWaveformCache(wData.deck, wData);  // cache for new connections
      emitEngineEvent("deckWaveform", wData);
      break;
    }
    case "midi":
      emitEngineEvent("midi", {
        status: Number(evt.status ?? 0), channel: Number(evt.channel ?? 0),
        data1: Number(evt.data1 ?? 0), data2: Number(evt.data2 ?? 0),
      });
      break;
    case "djSettings":
      emitEngineEvent("djSettings", {
        routing: evt.routing ?? null,
        jog: evt.jog ?? null,
        bindings: Array.isArray(evt.bindings) ? evt.bindings : [],
        midiDevice: String(evt.midiDevice ?? ""),
      });
      break;
    case "audioOutputs":
      emitEngineEvent("audioOutputs", {
        devices: Array.isArray(evt.devices) ? evt.devices : [],
        current: String(evt.current ?? ""),
        sampleRate: Number(evt.sampleRate ?? 0),
        outputs: Number(evt.outputs ?? 0),
      });
      break;
    case "libraryNav":
      emitEngineEvent("libraryNav", { dir: Number(evt.dir ?? 0) });
      break;
    case "librarySelect":
      emitEngineEvent("librarySelect", {});
      break;
    case "libraryLoad":
      emitEngineEvent("libraryLoad", { deck: Number(evt.deck ?? 0) });
      break;
    case "audioOutputSet":
      emitEngineEvent("audioOutputSet", {
        device: String(evt.device ?? ""),
        sampleRate: Number(evt.sampleRate ?? 0),
        outputs: Number(evt.outputs ?? 0),
        error: String(evt.error ?? ""),
      });
      break;
    case "midiDevices":
      emitEngineEvent("midiDevices", {
        devices: Array.isArray(evt.devices) ? evt.devices : [],
        open: String(evt.open ?? ""),
      });
      break;
    case "midiOpened":
      emitEngineEvent("midiOpened", { device: String(evt.device ?? ""), error: String(evt.error ?? "") });
      break;
    default:
      break;
  }
}

function connect(port: number) {
  if (stopped) return;

  socket = net.createConnection({ host: "127.0.0.1", port }, () => {
    log(`Connected to engine on 127.0.0.1:${port}`);
    sendToEngine({ cmd: "getStatus" });
    if (pingTimer) clearInterval(pingTimer);
    pingTimer = setInterval(() => sendToEngine({ cmd: "ping", id: ++pingId }), 5000);

    // ── Auto-restore: reload any songs that were on the decks before the engine
    // disconnected. This covers two cases:
    //   1. Engine crashed and restarted (deckSongIds still set from before crash)
    //   2. Page navigation that caused a brief disconnect
    // We wait 500ms to let the engine finish initialising its audio device.
    setTimeout(() => {
      for (let deck = 0; deck < 2; deck++) {
        const songId = deckSongIds[deck];
        if (!songId) continue;
        log(`[Auto-restore] Reloading song ${songId} onto deck ${deck}`);
        getStemsBySongId(songId).then((rows) => {
          if (!rows.length) return;
          const stems = rows.map((row) => ({
            path: require("./storage").storageKeyToPath(row.fileKey ?? ""),
            name: row.name || "Stem",
            route: (row.outputRoute === "click" || row.outputRoute === "guide") ? "iem" : "foh",
            gain: row.volume ?? 1,
            muted: row.muted ?? false,
          }));
          sendToEngine({ cmd: "loadDeck", deck, bpm: 120, stems });
          log(`[Auto-restore] Sent loadDeck for deck ${deck} (${stems.length} stems)`);
        }).catch((e) => log(`[Auto-restore] Failed to restore deck ${deck}: ${e.message}`));
      }
    }, 500);
  });

  socket.on("data", (chunk) => {
    buffer += chunk.toString("utf8");
    let nl: number;
    while ((nl = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      try {
        handleEvent(JSON.parse(line));
      } catch {
        log(`Bad JSON from engine: ${line}`);
      }
    }
  });

  const onGone = (why: string) => {
    if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
    setEngineStatus(DISCONNECTED);
    socket = null;
    buffer = "";
    if (!stopped) {
      log(`Engine link down (${why}); retrying in 1s`);
      if (reconnectTimer) clearTimeout(reconnectTimer);
      reconnectTimer = setTimeout(() => connect(port), 1000);
    }
  };

  socket.on("error", (err) => onGone(err.message));
  socket.on("close", () => onGone("closed"));
}

/** Begin connecting to the engine. Safe to call once at server startup. */
export function startEngineClient() {
  const port = parseInt(process.env.ROCKDJ_ENGINE_PORT || "", 10);
  if (!port) {
    log("ROCKDJ_ENGINE_PORT not set — native engine link disabled (UI-only mode).");
    setEngineStatus(DISCONNECTED);
    return;
  }
  stopped = false;
  setEngineStatus(DISCONNECTED);
  log(`Will connect to native engine on port ${port}`);
  connect(port);
}

export function stopEngineClient() {
  stopped = true;
  if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  if (socket) { socket.destroy(); socket = null; }
}
