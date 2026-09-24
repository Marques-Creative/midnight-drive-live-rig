import { useState, useEffect, useRef, useCallback } from "react";
import { io, Socket } from "socket.io-client";
import OverviewWaveform from "../components/OverviewWaveform";
import type { PlaybackState, TransportCommand } from "@shared/socketTypes";
import { KaraokeView } from "../components/KaraokeView";
import {
  Play, Pause, Square, SkipForward, SkipBack, Sliders
} from "lucide-react";

// ── Default empty state ─────────────────────────────────────────────────────
const defaultState: PlaybackState = {
  songId: null,
  songTitle: "Waiting for host...",
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

// ── Helpers ──────────────────────────────────────────────────────────────────
function formatTime(s: number): string {
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2, "0")}`;
}

// ── Main component ───────────────────────────────────────────────────────────
/** PIN from the QR link (?pin=1234) or one the user typed earlier. */
function storedPin(): string {
  const fromUrl = new URLSearchParams(window.location.search).get("pin");
  if (fromUrl) { sessionStorage.setItem("rockdj.pin", fromUrl); return fromUrl; }
  return sessionStorage.getItem("rockdj.pin") ?? "";
}


// Set timer display for Live Screen / Companion
function SetTimerBand({ running, startTime }: { running: boolean; startTime: number }) {
  const [display, setDisplay] = useState("00:00:00");
  useEffect(() => {
    if (!running) { setDisplay("00:00:00"); return; }
    const tick = () => {
      const sec = Math.floor((Date.now() - startTime) / 1000);
      const h = Math.floor(sec / 3600).toString().padStart(2, "0");
      const m = Math.floor((sec % 3600) / 60).toString().padStart(2, "0");
      const s = (sec % 60).toString().padStart(2, "0");
      setDisplay(`${h}:${m}:${s}`);
    };
    tick();
    const id = setInterval(tick, 500);
    return () => clearInterval(id);
  }, [running, startTime]);
  return (
    <div style={{ textAlign: "center" }}>
      <div style={{ fontFamily: "Orbitron, monospace", fontSize: 48, fontWeight: 900,
        fontVariantNumeric: "tabular-nums", letterSpacing: 6,
        color: running ? "#38d39f" : "rgba(56,211,159,0.2)",
        textShadow: running ? "0 0 30px #38d39f66" : "none" }}>
        {display}
      </div>
      <div style={{ fontSize: 10, color: "rgba(255,255,255,0.3)", letterSpacing: 3, marginTop: 2 }}>
        SET TIME
      </div>
    </div>
  );
}

export default function Companion() {
  const [state, setState] = useState<PlaybackState>(defaultState);
  const [connected, setConnected] = useState(false);
  const [needsPin, setNeedsPin] = useState(false);
  const [pinDraft, setPinDraft] = useState("");
  const [reconnecting, setReconnecting] = useState(false);
  const [viewMode, setViewMode] = useState<"karaoke" | "chart" | "set" | "mix">("karaoke");
  // ── DJ deck stem state, mirrored from the engine's 30 Hz broadcast ──
  const [deckMix, setDeckMix] = useState<{
    deckAStems: CompanionStem[];
    deckBStems: CompanionStem[];
    masterDeck: number;
  }>({ deckAStems: [], deckBStems: [], masterDeck: 0 });
  const [controlMode, setControlMode] = useState(false);
  const socketRef = useRef<Socket | null>(null);
  const [waveformPeaks, setWaveformPeaks] = useState<number[]>([]);
  const [waveformDuration, setWaveformDuration] = useState(0);
  const hostViewRef = useRef<string | null>(null);

  useEffect(() => {
    const socket = io(window.location.origin, {
      path: "/socket.io",
      query: { role: "companion", pin: storedPin() },
      reconnection: true,
      reconnectionDelay: 1000,
      reconnectionAttempts: Infinity,
    });
    socketRef.current = socket;

    socket.on("connect", () => { setConnected(true); setReconnecting(false); });
    socket.on("disconnect", () => { setConnected(false); setReconnecting(true); });
    socket.on("reconnect_attempt", () => setReconnecting(true));
    socket.on("connect_error", (err: Error) => {
      if (err?.message === "PIN_REQUIRED") {
        socket.disconnect();          // stop hammering the server
        setReconnecting(false);
        setNeedsPin(true);            // show the PIN entry screen
      }
    });
    socket.on("deckWaveform", (w: { deck: number; peaks: number[]; duration: number }) => {
      // Show the master deck waveform — update whenever a deck waveform arrives
      setWaveformPeaks(Array.isArray(w?.peaks) ? w.peaks : []);
      setWaveformDuration(Number(w?.duration ?? 0));
    });
    socket.on("enginePlayhead", (ph: Record<string, unknown>) => {
      setDeckMix({
        deckAStems: (ph.deckAStems as CompanionStem[]) ?? [],
        deckBStems: (ph.deckBStems as CompanionStem[]) ?? [],
        masterDeck: Number(ph.masterDeck ?? 0),
      });
      // Sync duration from playhead when waveform peaks exist
      const mDeck = Number(ph.masterDeck ?? 0);
      const dur = mDeck === 0 ? Number(ph.deckADuration ?? 0) : Number(ph.deckBDuration ?? 0);
      if (dur > 0) setWaveformDuration(dur);
    });
    socket.on("state", (incoming: PlaybackState) => {
      setState(incoming);
      // Follow host view mode when it changes
      if (incoming.lyricViewMode && incoming.lyricViewMode !== hostViewRef.current) {
        hostViewRef.current = incoming.lyricViewMode;
        setViewMode(incoming.lyricViewMode);
      }
    });

    return () => { socket.disconnect(); };
  }, []);

  // ── Transport command sender ─────────────────────────────────────────────
  const sendCommand = useCallback((cmd: TransportCommand) => {
    socketRef.current?.emit("transportCommand", cmd);
  }, []);

  if (needsPin) {
    return (
      <div className="h-screen flex flex-col items-center justify-center gap-4 p-8"
        style={{ background: "var(--md-bg)" }}>
        <div className="text-xs tracking-[0.3em]" style={{ color: "var(--md-text-muted)" }}>
          ROCKDJ COMPANION
        </div>
        <div className="text-lg font-bold" style={{ color: "var(--md-text)" }}>
          Enter the PIN shown on the Live Screen
        </div>
        <input
          autoFocus inputMode="numeric" pattern="[0-9]*" maxLength={8}
          value={pinDraft}
          onChange={(e) => setPinDraft(e.target.value.replace(/\D/g, ""))}
          className="text-center text-3xl font-mono rounded-lg px-4 py-3 tracking-[0.5em]"
          style={{ background: "var(--md-surface)", border: "1px solid var(--md-border)",
                   color: "var(--md-text)", width: 240 }} />
        <button
          disabled={pinDraft.length < 4}
          onClick={() => { sessionStorage.setItem("rockdj.pin", pinDraft); window.location.reload(); }}
          className="rounded-lg px-8 py-3 font-bold text-black"
          style={{ background: "var(--md-blue)", opacity: pinDraft.length < 4 ? 0.4 : 1 }}>
          CONNECT
        </button>
      </div>
    );
  }

  const isIdle = !state.songId;
  const isPlaying = state.isPlaying;
  const isPaused = state.isPaused;
  const hasSong = !!state.songId;
  const canPrev = state.currentIndex > 0;
  const canNext = state.currentIndex < state.totalSongs - 1;

  return (
    <div
      className="flex flex-col h-screen overflow-hidden"
      style={{ background: "var(--md-black)", color: "var(--md-text)" }}
    >
      {/* ── Status bar ── */}
      <div
        className="flex items-center justify-between px-5 py-2 shrink-0"
        style={{ background: "var(--md-surface)", borderBottom: "1px solid var(--md-border)" }}
      >
        {/* Branding + set info */}
        <div className="flex items-center gap-3">
          <span
            className="text-xs font-bold tracking-widest uppercase"
            style={{ color: "var(--md-magenta)", fontFamily: "var(--md-font-mono)" }}
          >
            ROCKDJ
          </span>
          {state.setListName && (
            <>
              <span style={{ color: "var(--md-border-2)" }}>|</span>
              <span className="text-xs" style={{ color: "var(--md-text-muted)", fontFamily: "var(--md-font-mono)" }}>
                {state.setListName}
              </span>
              {state.totalSongs > 0 && (
                <span className="text-xs" style={{ color: "var(--md-text-muted)" }}>
                  {state.currentIndex + 1} / {state.totalSongs}
                </span>
              )}
            </>
          )}
        </div>

        <div className="flex items-center gap-2">
          {/* View mode toggle */}
          <div
            className="flex items-center rounded overflow-hidden"
            style={{ border: "1px solid var(--md-border)", background: "var(--md-surface-2)" }}
          >
            {(["karaoke", "chart", "set", "mix"] as const).map((mode) => (
              <button
                key={mode}
                onClick={() => setViewMode(mode)}
                className="text-xs px-2.5 py-1 tracking-widest uppercase transition-colors"
                style={{
                  background: viewMode === mode ? "rgba(0,180,255,0.18)" : "transparent",
                  color: viewMode === mode ? "var(--md-blue)" : "var(--md-text-muted)",
                  borderRight: mode !== "mix" ? "1px solid var(--md-border)" : "none",
                }}
              >
                {mode === "karaoke" ? "lyrics" : mode}
              </button>
            ))}
          </div>

          {/* Control mode toggle */}
          <button
            onClick={() => setControlMode((v) => !v)}
            title={controlMode ? "Disable remote control" : "Enable remote control"}
            className="flex items-center gap-1.5 text-xs px-2.5 py-1 rounded transition-all duration-150 active:scale-95"
            style={{
              background: controlMode ? "rgba(255,45,120,0.18)" : "var(--md-surface-2)",
              color: controlMode ? "var(--md-magenta)" : "var(--md-text-muted)",
              border: `1px solid ${controlMode ? "rgba(255,45,120,0.4)" : "var(--md-border)"}`,
              boxShadow: controlMode ? "0 0 8px rgba(255,45,120,0.25)" : "none",
            }}
          >
            <Sliders size={11} />
            <span className="tracking-widest uppercase">Control</span>
          </button>

          {/* Connection indicator */}
          <div className="flex items-center gap-1.5">
            <div
              className="w-2 h-2 rounded-full"
              style={{
                background: connected ? "#00e676" : "var(--md-red)",
                boxShadow: connected ? "0 0 6px rgba(0,230,118,0.6)" : "none",
              }}
            />
            <span
              className="text-xs"
              style={{ color: "var(--md-text-muted)", fontFamily: "var(--md-font-mono)" }}
            >
              {reconnecting ? "RECONNECTING" : connected ? "LIVE" : "OFFLINE"}
            </span>
          </div>
        </div>
      </div>

      {/* ── Persistent waveform strip — visible across ALL tabs ── */}
      {waveformPeaks.length > 0 && waveformDuration > 0 && (
        <div style={{ flexShrink: 0, paddingBottom: 2, background: "var(--md-surface)" }}>
          <OverviewWaveform
            peaks={waveformPeaks}
            duration={waveformDuration}
            seconds={state.currentTime ?? 0}
            playing={state.isPlaying}
            color={deckMix.masterDeck === 0 ? "#7B2CF9" : "#00d4ff"}
            height={40}
          />
        </div>
      )}

      {/* ── Next song at-a-glance strip ── */}
      {state.nextSongTitle && (
        <div style={{
          flexShrink: 0, display: "flex", alignItems: "center", gap: 8,
          padding: "4px 16px", background: "rgba(0,180,255,0.06)",
          borderBottom: "1px solid rgba(0,180,255,0.15)",
        }}>
          <span style={{ fontSize: 9, fontWeight: 700, color: "#00b4ff", letterSpacing: "0.12em" }}>NEXT</span>
          <span style={{ fontSize: 12, fontWeight: 700, color: "rgba(255,255,255,0.8)", flex: 1,
            overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {state.nextSongTitle}
          </span>
          {state.nextSongBpm && (
            <span style={{ fontSize: 10, color: "rgba(255,255,255,0.4)", flexShrink: 0 }}>
              {state.nextSongBpm} BPM
            </span>
          )}
          {state.nextSongKey && (
            <span style={{ fontSize: 10, fontWeight: 700, color: "#00b4ff", flexShrink: 0 }}>
              {state.nextSongKey}
            </span>
          )}
        </div>
      )}

      {/* ── Remote transport bar (shown when Control Mode is on) ── */}
      {controlMode && (
        <div
          className="flex items-center justify-between px-5 py-3 shrink-0"
          style={{
            background: "rgba(255,45,120,0.06)",
            borderBottom: "1px solid rgba(255,45,120,0.2)",
          }}
        >
          {/* Song info */}
          <div className="flex flex-col min-w-0 flex-1 mr-4">
            <span
              className="text-sm font-bold truncate"
              style={{ color: "var(--md-text)", fontFamily: "var(--md-font-mono)" }}
            >
              {hasSong ? state.songTitle : "No song loaded"}
            </span>
            {hasSong && (
              <span className="text-xs" style={{ color: "var(--md-text-muted)" }}>
                {state.currentIndex + 1} / {state.totalSongs}
                {state.bpm ? ` · ${state.bpm} BPM` : ""}
                {state.key ? ` · ${state.key}` : ""}
              </span>
            )}
          </div>

          {/* Transport controls */}
          <div className="flex items-center gap-2 shrink-0">
            {/* Prev */}
            <button
              onClick={() => sendCommand({ type: "prev" })}
              disabled={!canPrev || !connected}
              className="flex items-center justify-center rounded transition-all duration-150 active:scale-90"
              style={{
                width: 40, height: 40,
                background: "var(--md-surface-2)",
                border: "1px solid var(--md-border)",
                color: canPrev && connected ? "var(--md-text)" : "var(--md-text-muted)",
                opacity: canPrev && connected ? 1 : 0.4,
              }}
              title="Previous song"
            >
              <SkipBack size={16} />
            </button>

            {/* Play / Pause */}
            <button
              onClick={() => sendCommand(isPlaying ? { type: "pause" } : { type: "play" })}
              disabled={!hasSong || !connected}
              className="flex items-center justify-center rounded transition-all duration-150 active:scale-90"
              style={{
                width: 52, height: 52,
                background: isPlaying ? "rgba(255,45,120,0.2)" : "rgba(0,180,255,0.2)",
                border: `1px solid ${isPlaying ? "rgba(255,45,120,0.5)" : "rgba(0,180,255,0.5)"}`,
                color: isPlaying ? "var(--md-magenta)" : "var(--md-blue)",
                boxShadow: isPlaying
                  ? "0 0 12px rgba(255,45,120,0.3)"
                  : "0 0 12px rgba(0,180,255,0.2)",
                opacity: hasSong && connected ? 1 : 0.4,
              }}
              title={isPlaying ? "Pause" : isPaused ? "Resume" : "Play"}
            >
              {isPlaying ? <Pause size={22} /> : <Play size={22} />}
            </button>

            {/* Stop */}
            <button
              onClick={() => sendCommand({ type: "stop" })}
              disabled={(!isPlaying && !isPaused) || !connected}
              className="flex items-center justify-center rounded transition-all duration-150 active:scale-90"
              style={{
                width: 40, height: 40,
                background: "var(--md-surface-2)",
                border: "1px solid var(--md-border)",
                color: "var(--md-text)",
                opacity: (isPlaying || isPaused) && connected ? 1 : 0.4,
              }}
              title="Stop"
            >
              <Square size={15} />
            </button>

            {/* Next */}
            <button
              onClick={() => sendCommand({ type: "next" })}
              disabled={!canNext || !connected}
              className="flex items-center justify-center rounded transition-all duration-150 active:scale-90"
              style={{
                width: 40, height: 40,
                background: "var(--md-surface-2)",
                border: "1px solid var(--md-border)",
                color: canNext && connected ? "var(--md-text)" : "var(--md-text-muted)",
                opacity: canNext && connected ? 1 : 0.4,
              }}
              title="Next song"
            >
              <SkipForward size={16} />
            </button>
          </div>
        </div>
      )}

      {/* ── Main content ── */}
      <div className="flex-1 overflow-hidden">
        {isIdle ? (
          /* Waiting for host */
          <div className="flex flex-col items-center justify-center h-full gap-6 text-center px-8">
            <div
              className="font-bold tracking-widest"
              style={{
                fontSize: "clamp(2.5rem, 8vw, 5rem)",
                fontFamily: "var(--md-font-mono)",
                color: "var(--md-magenta)",
                textShadow: "0 0 40px rgba(255,45,120,0.4)",
                lineHeight: 1,
              }}
            >
              MIDNIGHT
            </div>
            <div
              className="font-bold tracking-widest"
              style={{
                fontSize: "clamp(2.5rem, 8vw, 5rem)",
                fontFamily: "var(--md-font-mono)",
                color: "var(--md-blue)",
                textShadow: "0 0 40px rgba(0,180,255,0.4)",
                lineHeight: 1,
              }}
            >
              DRIVE
            </div>
            <div className="mt-4 flex items-center gap-2">
              <div
                className="w-2 h-2 rounded-full animate-pulse"
                style={{ background: connected ? "#00e676" : "var(--md-text-muted)" }}
              />
              <span
                className="text-sm"
                style={{ color: "var(--md-text-muted)", fontFamily: "var(--md-font-mono)" }}
              >
                {connected
                  ? "Connected — waiting for host to start"
                  : reconnecting
                  ? "Reconnecting to host…"
                  : "Connecting…"}
              </span>
            </div>
          </div>
        ) : viewMode === "karaoke" ? (
          <KaraokeView
            cues={state.lyricCues ?? []}
            currentTime={state.currentTime}
            duration={state.duration}
            songTitle={state.songTitle}
            artist={state.artist || undefined}
            bpm={state.bpm}
            songKey={state.key}
            nextSongTitle={state.nextSongTitle || undefined}
            nextSongBpm={state.nextSongBpm ?? undefined}
            nextSongKey={state.nextSongKey ?? undefined}
            isPlaying={state.isPlaying}
          />
        ) : viewMode === "chart" ? (
          <ChartView state={state} />
        ) : viewMode === "mix" ? (
          <StemMixerView
            deckMix={deckMix}
            sendEngine={(cmd) => socketRef.current?.emit("engineCommand", cmd)}
          />
        ) : (
          <SetView state={state} />
        )}
      </div>
    </div>
  );
}

// ── Chart View ───────────────────────────────────────────────────────────────
function ChartView({ state }: { state: PlaybackState }) {
  const lines = (state.lyrics || "").split("\n");
  const lyricsRef = useRef<HTMLDivElement>(null);

  return (
    <div
      className="h-full overflow-y-auto p-6"
      ref={lyricsRef}
      style={{ background: "var(--md-surface)" }}
    >
      <div className="mb-6 pb-4" style={{ borderBottom: "1px solid var(--md-border)" }}>
        <h1
          className="text-2xl font-bold mb-1"
          style={{ color: "var(--md-text)", fontFamily: "var(--md-font-mono)" }}
        >
          {state.songTitle}
        </h1>
        <div className="flex items-center gap-4">
          {state.artist && <span style={{ color: "var(--md-text-muted)" }}>{state.artist}</span>}
          {state.bpm && <span style={{ color: "var(--md-blue)" }}>{state.bpm} BPM</span>}
          {state.key && <span style={{ color: "var(--md-magenta)" }}>{state.key}</span>}
        </div>
      </div>

      {lines.length > 0 ? (
        <div className="lyrics-panel">
          {lines.map((line, i) => {
            const trimmed = line.trim();
            const isSectionHeader = /^\[.+\]$/.test(trimmed);
            const isChord = /^[A-G][#b]?/.test(trimmed) && trimmed.length < 20;
            return (
              <div
                key={i}
                className={isSectionHeader ? "section-header" : isChord ? "chord" : ""}
                style={{ marginBottom: isSectionHeader ? "0.75rem" : "0.15rem" }}
              >
                {line || "\u00A0"}
              </div>
            );
          })}
        </div>
      ) : (
        <div className="text-center mt-12" style={{ color: "var(--md-text-muted)" }}>
          No chart for this song
        </div>
      )}
    </div>
  );
}

// ── Set View ─────────────────────────────────────────────────────────────────
function SetView({ state }: { state: PlaybackState }) {
  const progress =
    state.duration && state.duration > 0
      ? Math.min(1, state.currentTime / state.duration)
      : 0;
  const elapsed = formatTime(state.currentTime);
  const remaining = state.duration
    ? formatTime(Math.max(0, state.duration - state.currentTime))
    : "--:--";

  const activeCue =
    state.lyricCues && state.activeCueIndex >= 0
      ? state.lyricCues[state.activeCueIndex]
      : null;

  return (
    <div className="flex flex-col h-full p-6 gap-6">
      {/* Current song */}
      <div className="flex-1 flex flex-col items-center justify-center text-center gap-4">
        <div
          className="text-xs tracking-widest uppercase"
          style={{ color: "var(--md-text-muted)", fontFamily: "var(--md-font-mono)" }}
        >
          NOW PLAYING
        </div>
        <div
          className="font-bold"
          style={{
            fontSize: "clamp(2rem, 6vw, 3.5rem)",
            color: "var(--md-text)",
            fontFamily: "var(--md-font-mono)",
            lineHeight: 1.1,
          }}
        >
          {state.songTitle}
        </div>
        <div className="flex items-center gap-6">
          {state.key && (
            <span
              className="text-3xl font-bold"
              style={{ color: "var(--md-magenta)", textShadow: "0 0 20px rgba(255,45,120,0.4)" }}
            >
              {state.key}
            </span>
          )}
          {state.bpm && (
            <span className="text-2xl" style={{ color: "var(--md-blue)" }}>
              {state.bpm}{" "}
              <span className="text-base" style={{ color: "var(--md-text-muted)" }}>BPM</span>
            </span>
          )}
        </div>

        {activeCue && !activeCue.isSection && (
          <div
            className="mt-2 text-lg"
            style={{ color: "var(--md-text-dim)", fontFamily: "var(--md-font-mono)", maxWidth: "80%" }}
          >
            {activeCue.text}
          </div>
        )}

        {/* Progress bar */}
        <div className="w-full max-w-md mt-4">
          <div
            className="h-1.5 rounded-full overflow-hidden mb-2"
            style={{ background: "var(--md-surface-3)" }}
          >
            <div
              className="h-full rounded-full"
              style={{
                width: `${progress * 100}%`,
                background: "linear-gradient(90deg, var(--md-blue), var(--md-magenta))",
                transition: "width 0.25s linear",
              }}
            />
          </div>
          <div
            className="flex justify-between text-xs"
            style={{ color: "var(--md-text-muted)", fontFamily: "var(--md-font-mono)" }}
          >
            <span>{elapsed}</span>
            <span>-{remaining}</span>
          </div>
        </div>
      </div>

      {/* Next song */}
      {state.nextSongTitle && (
        <div
          className="flex items-center justify-between px-5 py-4 rounded shrink-0"
          style={{ background: "var(--md-surface-2)", border: "1px solid var(--md-border)" }}
        >
          <div className="text-xs tracking-widest uppercase" style={{ color: "var(--md-text-muted)" }}>
            NEXT
          </div>
          <div
            className="text-lg font-bold"
            style={{ color: "var(--md-text-dim)", fontFamily: "var(--md-font-mono)" }}
          >
            {state.nextSongTitle}
          </div>
          <div className="flex items-center gap-3">
            {state.nextSongKey && (
              <span className="font-bold" style={{ color: "var(--md-magenta)" }}>
                {state.nextSongKey}
              </span>
            )}
            {state.nextSongBpm && (
              <span style={{ color: "var(--md-text-muted)" }}>{state.nextSongBpm} BPM</span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}


// ── Stem Mixer View — the Band Master's iPad control surface ─────────────────
// Mirrors the DJ's playing deck and lets the Band Master RIDE the stems live:
// pull the vocal for the live singer, drop the guitar for the guitarist. Sends
// the same setDeckStem command the DJ page uses; the engine is the single
// source of truth and echoes state back at 30 Hz.

interface CompanionStem {
  route?: string;
  index: number;
  name: string;
  gain: number;
  muted: boolean;
}

function StemMixerView({
  deckMix,
  sendEngine,
}: {
  deckMix: { deckAStems: CompanionStem[]; deckBStems: CompanionStem[]; masterDeck: number };
  sendEngine: (cmd: Record<string, unknown>) => void;
}) {
  // Follow the master deck (what the room hears) unless the user picks a deck.
  const [pinnedDeck, setPinnedDeck] = useState<number | null>(null);
  const deck = pinnedDeck ?? deckMix.masterDeck;
  const stems = deck === 0 ? deckMix.deckAStems : deckMix.deckBStems;
  const deckColor = deck === 0 ? "#7B2CF9" : "#00d4ff";

  // Drag-guard: while a finger is on a fader we show the local value so the
  // 30 Hz engine echo can't fight the touch. Keyed by stem index.
  const [drags, setDrags] = useState<Record<number, number>>({});

  return (
    <div className="h-full p-3 flex flex-col gap-3" style={{ overflow: "hidden" }}>
      <div className="flex items-center justify-between">
        <div className="text-[10px] tracking-[0.25em]" style={{ color: "var(--md-text-muted)" }}>
          STEM MIXER — RIDES THE DJ'S PLAYING TRACK
        </div>
        <div className="flex rounded overflow-hidden" style={{ border: "1px solid var(--md-border)" }}>
          {[0, 1].map((d) => (
            <button key={d}
              onClick={() => setPinnedDeck(d === deckMix.masterDeck ? null : d)}
              className="text-xs px-3 py-1.5 font-bold"
              style={{
                background: deck === d ? (d === 0 ? "#7B2CF9" : "#00d4ff") : "transparent",
                color: deck === d ? "#000" : "var(--md-text-muted)",
              }}>
              DECK {d + 1}{d === deckMix.masterDeck ? " •" : ""}
            </button>
          ))}
        </div>
      </div>

      {stems.length === 0 ? (
        <div className="flex-1 flex items-center justify-center text-sm"
          style={{ color: "var(--md-text-muted)" }}>
          No stems — the DJ hasn't loaded a track here yet.
        </div>
      ) : (
        <div style={{ flex: 1, display: "flex", gap: 6, overflowX: "auto", overflowY: "hidden",
          paddingBottom: 4, alignItems: "stretch" }}>
          {stems.map((st) => {
            const val = drags[st.index] ?? st.gain;
            const isIem = /click|guide|iem/i.test(st.name);
            const col = st.muted ? "#555" : isIem ? "#38d39f" : deckColor;
            const pct = Math.min(150, Math.round(val * 100));
            return (
              <div key={st.index} style={{
                flex: "1 0 68px", minWidth: 68, maxWidth: 100,
                display: "flex", flexDirection: "column", alignItems: "center", gap: 5,
                padding: "8px 5px 6px",
                background: "var(--md-surface-2)",
                border: `1px solid ${st.muted ? "rgba(255,85,85,0.3)" : col + "44"}`,
                borderRadius: 10, opacity: st.muted ? 0.65 : 1,
              }}>
                <span style={{ fontSize: 9, fontWeight: 700, color: col, textAlign: "center",
                  overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", width: "100%" }}>
                  {st.name}
                </span>
                <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", minHeight: 80 }}>
                  <input type="range" min={0} max={150} step={1} value={pct}
                    style={{ writingMode: "vertical-lr" as const, direction: "rtl" as const,
                      width: 26, height: "100%", accentColor: col,
                      cursor: "pointer", touchAction: "none" } as React.CSSProperties}
                    onPointerDown={(e) => { e.currentTarget.setPointerCapture(e.pointerId); setDrags((d) => ({ ...d, [st.index]: val })); }}
                    onPointerUp={() => setDrags((d) => { const n = { ...d }; delete n[st.index]; return n; })}
                    onChange={(e) => {
                      const v = parseInt(e.target.value) / 100;
                      setDrags((d) => ({ ...d, [st.index]: v }));
                      sendEngine({ cmd: "setDeckStem", deck, stem: st.index, gain: v });
                    }} />
                </div>
                <span style={{ fontSize: 10, fontVariantNumeric: "tabular-nums",
                  color: pct > 105 ? "#ff8c1a" : "var(--md-text-muted)" }}>{pct}%</span>
                <button onClick={() => sendEngine({ cmd: "setDeckStem", deck, stem: st.index, muted: !st.muted })}
                  style={{ width: "100%", padding: "5px 0", borderRadius: 5, border: "none",
                    cursor: "pointer", fontSize: 10, fontWeight: 800,
                    background: st.muted ? "#ff5555" : col + "22", color: st.muted ? "#fff" : col }}>
                  {st.muted ? "MUTE" : "M"}
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
