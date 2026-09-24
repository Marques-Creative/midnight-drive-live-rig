import React, { useCallback, useEffect, useRef, useState } from "react";
import { useLocation } from "wouter";
import { useTransport } from "../hooks/useTransport";
import type { TransportAPI, DeckState, DeckStemState } from "../hooks/useTransport";
import Waveform from "../components/Waveform";
import ZoomWaveform from "../components/ZoomWaveform";
import OverviewWaveform from "../components/OverviewWaveform";
import LinkPanel from "../components/LinkPanel";
import DjSetupPanel from "../components/DjSetupPanel";
import TrackBrowser from "../components/TrackBrowser";
import { useDeckNames } from "../lib/deckNames";
import { keyToCamelot, CAMELOT_COLORS } from "../components/KeyWheel";
import { trpc } from "@/lib/trpc";

/**
 * DjDecks — rekordbox/Serato-style layout:
 *   • Viewport-locked: nothing scrolls except the library panel itself
 *   • Decks A+B side-by-side at the top (all controls visible)
 *   • Crossfader + Master: thin strip between decks and library
 *   • Library: pinned to the bottom with internal scroll
 *   • DJ Setup: always-collapsed header at the very bottom
 */

const DECK_COLORS = ["#7B2CF9", "#00d4ff"];

const BOUNDARIES = [
  { label: "Beat", beats: 1 },
  { label: "Bar", beats: 4 },
  { label: "4 Bars", beats: 16 },
  { label: "8 Bars", beats: 32 },
];

function fmt(sec: number) {
  if (!isFinite(sec) || sec < 0) sec = 0;
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}


// ── Vertical VU Meter + Master Fader ──────────────────────────────────────────
// 20-segment classic VU: green (0-12), yellow (13-16), red (17-19).
// Segment thresholds use a gentle log scale so detail shows in the loud zone.
// The fader (0-200%) sits left of the meter; double-click resets to 100%.
function MasterVU({ peak, gain, onChange }: {
  peak: number; gain: number; onChange: (g: number) => void;
}) {
  const SEGS = 20;
  // Client-side decay so the meter drops immediately when music stops,
  // regardless of engine broadcast timing.
  const [displayPeak, setDisplayPeak] = useState(0);
  const decayRef = useRef(0);
  useEffect(() => {
    if (peak > decayRef.current) { decayRef.current = peak; setDisplayPeak(peak); }
  }, [peak]);
  useEffect(() => {
    const id = setInterval(() => {
      decayRef.current *= 0.80; // ~0.80^30fps ≈ 0.001 — zero in ~1s
      if (decayRef.current < 0.002) decayRef.current = 0;
      setDisplayPeak(decayRef.current);
    }, 33);
    return () => clearInterval(id);
  }, []);
  // Use displayPeak (decaying) instead of raw peak prop
  // Map each segment to a peak threshold in linear (0..1+)
  const segThreshold = (i: number) => {
    // Segments 0-15: linear 0..0.9, segments 16-19: 0.9..1.2 (clip zone)
    if (i < 16) return (i / 15) * 0.9;
    return 0.9 + ((i - 15) / 4) * 0.3;
  };
  const segColor = (i: number) => {
    if (i >= 17) return "#ff2222";
    if (i >= 13) return "#ff8c1a";
    return "#38d39f";
  };

  return (
    <div style={{ display: "flex", height: "100%", gap: 4, alignItems: "stretch" }}>

      {/* Vertical fader — rotated horizontal range; works reliably in all Chromium versions */}
      <div style={{ display: "flex", flexDirection: "column", alignItems: "center",
        gap: 3, width: 36, flexShrink: 0 }}>
        <span style={{ fontSize: 7, color: "var(--md-text-muted)", letterSpacing: "0.08em",
          textAlign: "center" }}>MASTER</span>
        {/* The outer div clips the rotated slider to its bounds */}
        <div style={{ flex: 1, minHeight: 0, position: "relative", width: 28, overflow: "visible" }}>
          <input type="range" min={0} max={200} step={1} value={Math.round(gain * 100)}
            onChange={(e) => onChange(parseInt(e.target.value) / 100)}
            onDoubleClick={() => onChange(1)}
            title="Master output — double-click to reset to 100%"
            style={{
              position: "absolute",
              left: "50%", top: "50%",
              // Rotated: width becomes the visual height of the track
              width: "var(--fader-len, 120px)",
              height: 24,
              transform: "translate(-50%, -50%) rotate(-90deg)",
              accentColor: gain > 1.05 ? "#ff8c1a" : "#38d39f",
              cursor: "pointer",
              touchAction: "none",
            } as React.CSSProperties}
            ref={(el) => {
              if (el) {
                // Set CSS var from parent height so the slider track matches
                const h = el.parentElement?.clientHeight ?? 120;
                el.style.setProperty("--fader-len", h + "px");
                el.style.width = h + "px";
              }
            }}
          />
        </div>
        <span style={{ fontSize: 8, fontVariantNumeric: "tabular-nums", textAlign: "center",
          color: gain > 1.05 ? "#ff8c1a" : "var(--md-text-muted)",
          fontWeight: gain > 1.05 ? 700 : 400 }}>
          {Math.round(gain * 100)}%
        </span>
      </div>

      {/* VU meter — 20 segments bottom to top, reading live masterPeak */}
      <div style={{ display: "flex", flexDirection: "column-reverse",
        flex: 1, gap: 2, justifyContent: "flex-start" }}>
        {Array.from({ length: SEGS }, (_, idx) => {
          const lit = displayPeak >= segThreshold(idx);
          const col = segColor(idx);
          return (
            <div key={idx} style={{
              flex: 1, minHeight: 3, borderRadius: 1,
              background: lit ? col : "rgba(255,255,255,0.06)",
              boxShadow: lit && idx >= 17 ? `0 0 5px ${col}88` : "none",
              transition: "background 50ms",
            }} />
          );
        })}
        <span style={{ fontSize: 6, color: "var(--md-text-muted)", textAlign: "center",
          letterSpacing: "0.05em", flexShrink: 0, marginBottom: 2 }}>VU</span>
      </div>
    </div>
  );
}

/** Compact BPM ring — smaller than the original but still readable at a glance. */
function BpmRing({ bpm, progress, color, playing, onRateChange, onDragStart, onDragEnd }: {
  bpm: number; progress: number; color: string; playing: boolean;
  onRateChange?: (delta: number) => void;
  onDragStart?: (currentRate: number) => void;
  onDragEnd?: () => void;
}) {
  const R = 29, C = 2 * Math.PI * R;
  const dash = C * Math.min(1, Math.max(0, progress));
  const dragRef = React.useRef<{ startY: number; startBpm: number } | null>(null);

  return (
    <div style={{ flexShrink: 0, cursor: onRateChange ? "ns-resize" : "default", touchAction: "none", width: 70, height: 70 }}
      title="Drag up/down to pitch ±"
      onPointerDown={(e) => {
        if (!onRateChange) return;
        e.currentTarget.setPointerCapture(e.pointerId);
        dragRef.current = { startY: e.clientY, startBpm: bpm };
        // Notify parent to capture the current rate as the drag baseline
        if (onDragStart) onDragStart(bpm);
      }}
      onPointerMove={(e) => {
        if (!dragRef.current || !onRateChange) return;
        // Compute rate change from STARTING position, not accumulated frame-by-frame.
        // 300px of drag = ~8 BPM change at 115 BPM (0.00025 * 300 ≈ 0.075 rate delta)
        const delta = (dragRef.current.startY - e.clientY) * 0.00025;
        onRateChange(delta);
      }}
      onPointerUp={() => { dragRef.current = null; if (onDragEnd) onDragEnd(); }}>
    <svg width="70" height="70" viewBox="0 0 70 70">
      <circle cx="35" cy="35" r={R} fill="none" stroke="rgba(255,255,255,0.08)" strokeWidth="5" />
      <circle cx="35" cy="35" r={R} fill="none" stroke={color} strokeWidth="5"
        strokeLinecap="round" strokeDasharray={`${dash} ${C - dash}`}
        transform="rotate(-90 35 35)"
        style={{ filter: playing ? `drop-shadow(0 0 5px ${color})` : "none", transition: "stroke-dasharray 0.1s linear" }} />
      <text x="35" y="33" textAnchor="middle" fill="#fff" fontSize="13" fontWeight="700"
        fontFamily="monospace" style={{ fontVariantNumeric: "tabular-nums" }}>
        {bpm ? bpm.toFixed(1) : "—"}
      </text>
      <text x="35" y="46" textAnchor="middle" fill="rgba(255,255,255,0.4)" fontSize="8" letterSpacing="1">BPM</text>
    </svg>
    </div>
  );
}

// ── Compact knob: label + mini range, double-click resets ─────────────────────
function Knob({ label, value, min, max, step, display, onChange, resetTo, accent, w = 52 }: {
  label: string; value: number; min: number; max: number; step: number;
  display: (v: number) => string; onChange: (v: number) => void; resetTo: number;
  accent: string; w?: number;
}) {
  const [drag, setDrag] = useState<number | null>(null);
  const shown = drag ?? value;
  const active = Math.abs(shown - resetTo) > step / 2;
  return (
    <div className="flex flex-col items-center gap-0.5" style={{ width: w }}>
      <div className="flex justify-between w-full" style={{ fontSize: 8, color: active ? accent : "var(--md-text-muted)" }}>
        <span style={{ letterSpacing: "0.06em" }}>{label}</span>
        <span style={{ fontVariantNumeric: "tabular-nums" }}>{display(shown)}</span>
      </div>
      <input type="range" min={min} max={max} step={step} value={shown}
        onChange={(e) => { setDrag(parseFloat(e.target.value)); onChange(parseFloat(e.target.value)); }}
        onPointerUp={() => setDrag(null)}
        onDoubleClick={() => { setDrag(null); onChange(resetTo); }}
        style={{ width: "100%", height: 14, accentColor: active ? accent : "#444", margin: 0 }} />
    </div>
  );
}

// ── Compact button ─────────────────────────────────────────────────────────────
function Btn({ children, onClick, active, color, disabled, title, style: s, onPointerDown, onPointerUp, onPointerCancel }: {
  children: React.ReactNode; onClick?: () => void; active?: boolean; color?: string;
  disabled?: boolean; title?: string; style?: React.CSSProperties;
  onPointerDown?: (e: React.PointerEvent) => void;
  onPointerUp?: () => void;
  onPointerCancel?: () => void;
}) {
  const bg = active ? (color ?? "#38d39f") : "#1a1a22";
  const fg = active ? "#000" : (color ?? "var(--md-text-muted)");
  return (
    <button disabled={disabled} onClick={onClick} title={title}
      onPointerDown={onPointerDown} onPointerUp={onPointerUp} onPointerCancel={onPointerCancel}
      style={{ background: bg, color: fg, border: `1px solid ${color ?? "#444"}44`,
        borderRadius: 4, padding: "2px 8px", fontSize: 10, fontWeight: 700,
        cursor: disabled ? "not-allowed" : "pointer", opacity: disabled ? 0.35 : 1,
        whiteSpace: "nowrap", touchAction: "none", userSelect: "none", ...s }}>
      {children}
    </button>
  );
}

// ── Single deck panel ──────────────────────────────────────────────────────────
function Deck({ index, state, peaks, stems, isMaster, autoMaster, audio, songKey }: {
  index: number; state: DeckState; peaks: number[]; stems: DeckStemState[];
  isMaster: boolean; autoMaster: boolean; audio: TransportAPI; songKey?: string | null;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [bpm, setBpm] = useState("120");
  const [uploading, setUploading] = useState(false);
  const [stemsOpen, setStemsOpen] = useState(true);
  const [zoomBeats, setZoomBeats] = useState(16);
  const [editingBpm, setEditingBpm] = useState(false);
  const [quantise, setQuantise] = useState(false);

  // ── Hot cue persistence ─────────────────────────────────────────────────
  // songId for the currently loaded track — used to associate cues with songs
  const songId = audio.deckSongIds?.[index] ?? null;

  // MIDI patch indicator — shows when the loaded song has patches configured
  const { data: allSongs } = trpc.songs.list.useQuery(undefined, { enabled: !!songId });
  const loadedSong = allSongs?.find((s) => s.id === songId);
  const hasMidiPatches = !!loadedSong?.midiPatches && (() => {
    try { return JSON.parse(loadedSong.midiPatches!).length > 0; } catch { return false; }
  })();
  const resendPatches = () => {
    if (!loadedSong?.midiPatches) return;
    try {
      const patches = JSON.parse(loadedSong.midiPatches) as Array<{
        type: string; channel: number; program?: number;
        bankMSB?: number; bankLSB?: number; cc?: number; value?: number; delayMs?: number;
      }>;
      let delay = 0;
      for (const patch of patches) {
        const d = delay;
        setTimeout(() => {
          const ch = Math.max(0, Math.min(15, (patch.channel ?? 1) - 1));
          if (patch.type === "bank+pc") {
            audio.sendMidiOut?.(0xB0 | ch, 0, patch.bankMSB ?? 0);
            audio.sendMidiOut?.(0xB0 | ch, 32, patch.bankLSB ?? 0);
            audio.sendMidiOut?.(0xC0 | ch, patch.program ?? 0, 0);
          } else if (patch.type === "pc") {
            audio.sendMidiOut?.(0xC0 | ch, patch.program ?? 0, 0);
          } else if (patch.type === "cc") {
            audio.sendMidiOut?.(0xB0 | ch, patch.cc ?? 0, patch.value ?? 0);
          }
        }, d);
        delay += patch.delayMs ?? 20;
      }
    } catch { /* ignore */ }
  };
  const utils = trpc.useUtils();
  const saveHotCue  = trpc.songs.saveHotCue.useMutation({
    onSuccess: () => utils.songs.list.invalidate(),
  });
  const clearHotCueMut = trpc.songs.clearHotCue.useMutation({
    onSuccess: () => utils.songs.list.invalidate(),
  });

  // Restore saved hot cues from DB whenever a new song is loaded onto this deck
  // Pending-save set: when the user presses an empty pad we immediately fire
  // setHotCue to the engine. We then watch for the engine's next telemetry
  // update confirming the position (arrives within ~33ms) and save to the DB.
  // No timeout or stale-ref issues.
  // Maps slot → the playhead time at which the DJ pressed the pad.
  // We only save once the engine confirms that exact position (within 0.5s).
  // Prevents saving 0.0 from stale engine state before the cue is actually set.
  const pendingSaveSlotsRef = useRef<Map<number, number>>(new Map());
  const dragStartRateRef = useRef<number | null>(null);
  useEffect(() => {
    const pending = pendingSaveSlotsRef.current;
    if (!songId || pending.size === 0) return;
    const toSave: { slot: number; seconds: number }[] = [];
    pending.forEach((expectedSec, slot) => {
      const sec = state.hotCues[slot];
      // Accept the engine value if it's within 0.5s of when we pressed the pad
      if (sec != null && sec > 0 && Math.abs(sec - expectedSec) < 0.5) {
        toSave.push({ slot, seconds: sec });
        pending.delete(slot);
      }
    });
    toSave.forEach(({ slot, seconds }) =>
      saveHotCue.mutate({ songId, slot, seconds })
    );
  }, [state.hotCues]); // eslint-disable-line react-hooks/exhaustive-deps

  // Hot cue restore is handled server-side: loadDeck includes hotCues from the DB,
  // the engine sets them atomically after stems load. No client-side restore needed.

  // Client-side peak decay for the LEVEL bar
  const [displayDeckPeak, setDisplayDeckPeak] = useState(0);
  const deckDecayRef = useRef(0);
  useEffect(() => {
    if (state.peak > deckDecayRef.current) { deckDecayRef.current = state.peak; setDisplayDeckPeak(state.peak); }
  }, [state.peak]);
  useEffect(() => {
    const id = setInterval(() => {
      deckDecayRef.current *= 0.80;
      if (deckDecayRef.current < 0.002) deckDecayRef.current = 0;
      setDisplayDeckPeak(deckDecayRef.current);
    }, 33);
    return () => clearInterval(id);
  }, []);


  const name = useDeckNames()[index];
  const color = DECK_COLORS[index];
  const progress = state.duration > 0 ? state.seconds / state.duration : 0;
  const effBpm = (state.bpm || parseFloat(bpm) || 0) * (state.rate || 1);
  const camelot = keyToCamelot(songKey);

  // ── Hardware LED feedback ─────────────────────────────────────────────
  // Sends MIDI back to the XDJ-RX3 to light buttons and pads.
  // Pioneer's protocol: same note numbers as input, velocity 127 = lit, 0 = off.
  // Only fires when state actually changes (not every render).
  useEffect(() => {
    const PLAY_NOTE = 0x0B, CUE_NOTE = 0x0C;
    audio.sendLedFeedback(index, PLAY_NOTE, state.playing ? 127 : 0);
  }, [state.playing]);  // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const CUE_NOTE = 0x0C;
    audio.sendLedFeedback(index, CUE_NOTE, state.cuePreview ? 127 : 0);
  }, [state.cuePreview]);  // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    // Hot cue pads: notes 0x00-0x03 (pads 1-4), 0x10-0x13 (pads 5-8)
    // Send on the pad channels: ch6 for deck1, ch7 for deck2
    const notes = [0x00,0x01,0x02,0x03,0x10,0x11,0x12,0x13];
    // We abuse sendLedFeedback slightly: the "ch6/ch7 for pads" means we need
    // to send on a different channel. For now send on the deck's channel — the
    // setup panel wires the actual channel. Pads use a dedicated send in the engine.
    state.hotCues.forEach((sec, i) => {
      if (i < 8) audio.sendLedFeedback(index, notes[i], sec >= 0 ? 65 : 0);
    });
  }, [JSON.stringify(state.hotCues)]);  // eslint-disable-line react-hooks/exhaustive-deps
  const keyColor = camelot ? CAMELOT_COLORS[parseInt(camelot.slice(0, -1), 10)] : null;

  const onPick = async (files: FileList) => {
    setUploading(true);
    try {
      const uploaded: Array<{ fileKey: string; name: string; route: string }> = [];
      for (const f of Array.from(files)) {
        const form = new FormData();
        form.append("audio", f);
        form.append("fileName", f.name);
        const res = await fetch("/api/upload/deck", { method: "POST", body: form });
        const data = await res.json();
        if (!data.key) continue;
        const lower = f.name.toLowerCase();
        uploaded.push({ fileKey: data.key, name: f.name.replace(/\.[^.]+$/, ""),
          route: /click|cue|iem|count/.test(lower) ? "iem" : "foh" });
      }
      if (uploaded.length) audio.loadDeck(index, uploaded, parseFloat(bpm) || 120);
    } finally { setUploading(false); }
  };

  return (
    <div style={{ flex: 1, minWidth: 0, background: "#111117",
      border: `1px solid ${isMaster ? color : "rgba(255,255,255,0.08)"}`,
      borderRadius: 10, padding: "6px 8px", display: "flex", flexDirection: "column", gap: 4, overflow: "hidden" }}>

      {/* ── Row 1: track name + BPM + key + time ── */}
      <div style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
        <span style={{ background: color, color: "#000", fontWeight: 900, fontSize: 9,
          padding: "1px 5px", borderRadius: 3, fontFamily: "Orbitron,sans-serif", flexShrink: 0 }}>
          {index === 0 ? "A" : "B"}
        </span>
        <span style={{ fontWeight: 700, fontSize: 12, flex: 1, minWidth: 0,
          overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {name || "— load a track —"}
        </span>
        {editingBpm ? (
          <input autoFocus defaultValue={state.bpm ? state.bpm.toFixed(2) : ""} type="number" step="0.01"
            onBlur={(e) => { const v = parseFloat(e.target.value); if (v > 20) audio.setDeckBpm(index, v); setEditingBpm(false); }}
            onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); if (e.key === "Escape") setEditingBpm(false); }}
            style={{ width: 64, fontSize: 12, background: "#0B0B0F", color, border: `1px solid ${color}`, borderRadius: 3, padding: "1px 4px" }} />
        ) : (
          <span onClick={() => state.loaded && setEditingBpm(true)}
            title="Click to correct the BPM manually"
            style={{ fontWeight: 700, fontSize: 14, color, fontVariantNumeric: "tabular-nums", flexShrink: 0,
              cursor: state.loaded ? "pointer" : "default", borderBottom: state.loaded ? `1px dotted ${color}55` : "none" }}>
            {effBpm > 0 ? effBpm.toFixed(2) : "—"}
          </span>
        )}
        {/* beat grid zoom */}
        <span style={{ display: "flex", gap: 2, flexShrink: 0 }}>
          {[8, 16, 32].map((z) => (
            <button key={z} onClick={() => setZoomBeats(z)}
              style={{ fontSize: 7, padding: "1px 4px", borderRadius: 2, border: "none", cursor: "pointer",
                background: zoomBeats === z ? color : "#1a1a22",
                color: zoomBeats === z ? "#000" : "var(--md-text-muted)" }}>
              {z}
            </button>
          ))}
        </span>
        {camelot && (
          <span style={{ fontSize: 9, fontWeight: 700, padding: "1px 4px", borderRadius: 3,
            background: keyColor ? keyColor + "33" : "#333", color: keyColor ?? "#fff",
            border: `1px solid ${keyColor ?? "#555"}55`, flexShrink: 0 }}>
            {camelot}
          </span>
        )}
        <span style={{ fontSize: 10, color: "var(--md-text-muted)", fontVariantNumeric: "tabular-nums", flexShrink: 0 }}>
          -{fmt(state.duration - state.seconds)}
        </span>
      </div>

      {/* ── Row 2: waveform or empty-state placeholder ── */}
      {!state.loaded && (
        <div style={{ height: 110, background: "#0B0B0F", borderRadius: 4,
          border: "1px dashed rgba(255,255,255,0.1)", display: "flex",
          alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
          <span style={{ color: "rgba(255,255,255,0.2)", fontSize: 11, letterSpacing: "0.2em" }}>
            TAP 1 OR 2 IN THE LIBRARY TO LOAD
          </span>
        </div>
      )}
      {/* ── Overview strip — full-track bird's-eye, like CDJ screens ── */}
      {state.loaded && (
        <OverviewWaveform
          peaks={peaks} duration={state.duration} seconds={state.seconds}
          playing={state.playing} color={color}
          cueSeconds={state.cueSeconds >= 0 ? state.cueSeconds : undefined}
          loopStart={state.loopStart}
          loopEnd={state.loopEnd}
          looping={state.looping}
          hotCues={state.hotCues}
          height={28}
          onSeek={(t) => audio.deckSeek(index, t)}
        />
      )}

      {state.loaded && <ZoomWaveform peaks={peaks} duration={state.duration} seconds={state.seconds}
        playing={state.playing} bpm={state.bpm} downbeatSeconds={state.downbeatSeconds}
        cueSeconds={state.cueSeconds} windowBeats={zoomBeats} color={color} height={110}
        onSeek={(sec) => audio.deckSeek(index, sec)}
        quantise={quantise} />}

      {/* ── Row 3: transport — ring + buttons ── */}
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <BpmRing bpm={(state.bpm || parseFloat(bpm) || 0) * (state.rate || 1)}
          progress={progress} color={color} playing={state.playing}
          onRateChange={state.loaded ? (delta) => {
            // delta is from the STARTING position (not cumulative frame-by-frame)
            // so we need the rate AT DRAG START, stored in dragStartRateRef
            const base = dragStartRateRef.current ?? (state.rate || 1);
            const newRate = Math.max(0.5, Math.min(2.0, base + delta));
            audio.setDeckRate(index, newRate);
          } : undefined}
          onDragStart={(r) => { dragStartRateRef.current = r; }}
          onDragEnd={() => { dragStartRateRef.current = null; }} />
        <div style={{ flex: 1, display: "flex", alignItems: "center", gap: 4, flexWrap: "wrap" }}>
        <input ref={fileRef} type="file" accept="audio/*" multiple style={{ display: "none" }}
          onChange={(e) => { const fs = e.target.files; if (fs?.length) onPick(fs); }} />

        {/* PLAY */}
        <button disabled={!state.loaded} onClick={() => state.playing ? audio.deckPause(index) : audio.deckPlay(index)}
          style={{ width: 34, height: 30, borderRadius: 6, background: state.playing ? "#f0a53a" : "#38d39f",
            color: "#000", fontWeight: 900, fontSize: 13, border: "none", cursor: state.loaded ? "pointer" : "not-allowed",
            opacity: state.loaded ? 1 : 0.35 }}>
          {state.playing ? "❚❚" : "▶"}
        </button>

        {/* CUE (hold-to-preview) */}
        <Btn active={state.cuePreview} color="#ff8c1a" disabled={!state.loaded}
          onPointerDown={(e) => { e.currentTarget.setPointerCapture(e.pointerId); audio.deckCueDown(index); }}
          onPointerUp={() => audio.deckCueUp(index)} onPointerCancel={() => audio.deckCueUp(index)}
          style={{ boxShadow: state.cuePreview ? "0 0 10px #ff8c1a99" : "none" }}>
          CUE
        </Btn>

        <Btn disabled={!state.loaded} onClick={() => audio.deckSync(index)} color="#38d39f"
          active={Math.abs(state.rate - 1) > 0.002}
          style={{ boxShadow: Math.abs(state.rate - 1) > 0.002 ? "0 0 8px #38d39f88" : "none" }}>
          SYNC
        </Btn>

        <Btn active={quantise} color="#f0a53a" disabled={!state.loaded}
          onClick={() => setQuantise((q) => !q)}
          title="Quantise — snap scroll and click to nearest beat grid point"
          style={{ boxShadow: quantise ? "0 0 8px #f0a53a88" : "none", fontSize: 9 }}>
          QNTZ
        </Btn>

        <Btn active={state.masterTempo} color={color} disabled={!state.loaded}
          onClick={() => audio.setDeckMasterTempo(index, !state.masterTempo)} title="Key Lock — hold pitch when tempo changes"
          style={{ boxShadow: state.masterTempo ? `0 0 8px ${color}88` : "none" }}>
          🔑
        </Btn>

        <Btn active={state.cueEnabled} color="#ff8c1a" disabled={!state.loaded}
          onClick={() => audio.setDeckCue(index, !state.cueEnabled)} title="Headphone cue (PFL)"
          style={{ boxShadow: state.cueEnabled ? "0 0 10px #ff8c1a99" : "none",
            background: state.cueEnabled ? "#ff8c1a" : "#1a1a22" }}>
          🎧
        </Btn>

        {/* MIDI patch indicator — tap to re-send */}
        {hasMidiPatches && (
          <button onClick={resendPatches}
            title="MIDI patches configured — click to re-send"
            style={{ padding: "2px 7px", borderRadius: 3, border: "1px solid #b24bff55",
              background: "rgba(178,75,255,0.15)", color: "#b24bff",
              fontSize: 9, fontWeight: 700, cursor: "pointer", letterSpacing: "0.08em" }}>
            MIDI
          </button>
        )}

        {/* BEAT FX */}
        {[{ mode: 0, label: "ECH" }, { mode: 1, label: "REV" }].map(({ mode, label }) => (
          <Btn key={mode} active={state.fxOn && state.fxMode === mode} color="#ff8c1a" disabled={!state.loaded}
            onClick={() => state.fxOn && state.fxMode === mode ? audio.setDeckFxOn(index, false)
              : (audio.setDeckFxMode(index, mode), audio.setDeckFxOn(index, true))}>
            {label}
          </Btn>
        ))}
        {state.fxOn && (
          <input type="range" min={0} max={100} value={Math.round(state.fxDepth * 100)}
            onChange={(e) => audio.setDeckFxDepth(index, parseInt(e.target.value) / 100)}
            style={{ width: 50, height: 14, accentColor: "#ff8c1a" }} />
        )}

        <div style={{ marginLeft: "auto", display: "flex", gap: 4 }}>
          {/* MASTER button */}
          <Btn active={isMaster} color={color}
            onClick={() => isMaster && !autoMaster ? audio.setAutoMaster(true) : audio.setMasterDeck(index)}>
            {isMaster ? (autoMaster ? "MSTR⟳" : "MSTR📌") : "MASTER"}
          </Btn>
          <Btn onClick={() => fileRef.current?.click()} color={color} style={{ background: `${color}22` }}>
            {uploading ? "…" : "LOAD"}
          </Btn>
        </div>
        </div>
      </div>

      {/* ── Clip meter ── */}
      <div style={{ display: "flex", alignItems: "center", gap: 4, height: 10 }}>
        <span style={{ fontSize: 7, color: "var(--md-text-muted)", width: 24 }}>LEVEL</span>
        <div style={{ flex: 1, height: 8, background: "rgba(255,255,255,0.06)", borderRadius: 2, overflow: "hidden" }}>
          <div style={{
            height: "100%", borderRadius: 2, transition: "width 60ms linear",
            width: `${Math.min(100, displayDeckPeak * 100)}%`,
            background: displayDeckPeak > 1 ? "#ff2222"
                       : displayDeckPeak > 0.85 ? "#ff8c1a"
                       : `linear-gradient(to right, #38d39f, ${color})`,
          }} />
        </div>
        {displayDeckPeak > 1 && (
          <span style={{ fontSize: 7, color: "#ff2222", fontWeight: 900, flexShrink: 0 }}>CLIP</span>
        )}
      </div>

      {/* ── Row 4: fader + audible meter + XF assign ── */}
      <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
        <span style={{ fontSize: 8, color: "var(--md-text-muted)", flexShrink: 0 }}>VOL</span>
        <input type="range" min={0} max={100} value={Math.round(state.gain * 100)}
          onChange={(e) => audio.setDeckGain(index, parseInt(e.target.value) / 100)}
          onDoubleClick={() => audio.setDeckGain(index, 1)}
          style={{ flex: 1, height: 14, accentColor: color }} />
        {/* Audible level bar */}
        <div style={{ width: 36, height: 8, background: "rgba(255,255,255,0.08)", borderRadius: 2, flexShrink: 0 }}>
          <div style={{ width: `${Math.min(100, state.audible * 100)}%`, height: "100%",
            background: isMaster ? "#38d39f" : color, borderRadius: 2, transition: "width 80ms" }} />
        </div>
        <span style={{ fontSize: 8, color: "var(--md-text-muted)", flexShrink: 0 }}>XF</span>
        {(["A","T","B"] as const).map((v, i) => (
          <button key={v} onClick={() => audio.setDeckXfAssign(index, i)}
            style={{ padding: "1px 5px", fontSize: 8, fontWeight: 700, borderRadius: 3,
              background: state.xfAssign === i ? color : "#1a1a22",
              color: state.xfAssign === i ? "#000" : "var(--md-text-muted)",
              border: "none", cursor: "pointer" }}>
            {v}
          </button>
        ))}
      </div>

      {/* ── Row 5: TRIM + EQ + Filter + Tempo ── */}
      <div style={{ display: "flex", gap: 3, alignItems: "flex-end", flexWrap: "wrap" }}>
        <Knob label="TRIM" value={state.trim} min={-12} max={12} step={0.5} resetTo={0} accent="#fff" w={46}
          display={(v) => `${v >= 0 ? "+" : ""}${v.toFixed(0)}`} onChange={(v) => audio.setDeckTrim(index, v)} />
        <Knob label="LOW" value={state.eqLow} min={-26} max={6} step={0.5} resetTo={0} accent={color} w={44}
          display={(v) => `${v >= 0 ? "+" : ""}${v.toFixed(0)}`} onChange={(v) => audio.setDeckEq(index, v, state.eqMid, state.eqHigh)} />
        <Knob label="MID" value={state.eqMid} min={-26} max={6} step={0.5} resetTo={0} accent={color} w={44}
          display={(v) => `${v >= 0 ? "+" : ""}${v.toFixed(0)}`} onChange={(v) => audio.setDeckEq(index, state.eqLow, v, state.eqHigh)} />
        <Knob label="HI" value={state.eqHigh} min={-26} max={6} step={0.5} resetTo={0} accent={color} w={44}
          display={(v) => `${v >= 0 ? "+" : ""}${v.toFixed(0)}`} onChange={(v) => audio.setDeckEq(index, state.eqLow, state.eqMid, v)} />
        <Knob label="FILTER" value={state.filter} min={-1} max={1} step={0.02} resetTo={0} accent="#ff8c1a" w={50}
          display={(v) => Math.abs(v) < 0.05 ? "off" : v < 0 ? `LP${Math.round(-v*100)}` : `HP${Math.round(v*100)}`}
          onChange={(v) => audio.setDeckFilter(index, v)} />
        <Knob label={`TEMPO ±${state.tempoRange}%`} value={(state.rate - 1) * 100}
          min={-state.tempoRange} max={state.tempoRange} step={state.tempoRange / 160}
          resetTo={0} accent={color} w={56}
          display={(v) => `${v >= 0 ? "+" : ""}${v.toFixed(1)}%`}
          onChange={(v) => audio.setDeckRate(index, 1 + v / 100)} />
        <button onClick={() => audio.cycleDeckTempoRange(index)} title="Cycle tempo range"
          style={{ fontSize: 8, padding: "2px 4px", borderRadius: 3, background: "#1a1a22",
            color: state.tempoRange >= 100 ? "#ff8c1a" : color, border: "none", cursor: "pointer",
            alignSelf: "flex-end", marginBottom: 1 }}>
          {state.tempoRange >= 100 ? "WD" : `±${state.tempoRange}`}
        </button>
      </div>

      {/* ── Row 6: hot cues ── */}
      <div style={{ display: "flex", gap: 3, alignItems: "center" }}>
        <span style={{ fontSize: 8, color: "var(--md-text-muted)", flexShrink: 0, width: 22 }}>CUES</span>
        {Array.from({ length: 8 }, (_, i) => {
          const set = (state.hotCues[i] ?? -1) >= 0;
          return (
            <button key={i} disabled={!state.loaded}
              onClick={(e) => {
                if (!set) {
                  audio.setHotCue(index, i);
                  // Record the current position so we can verify the engine set it correctly
                  if (songId) pendingSaveSlotsRef.current.set(i, state.seconds ?? 0);
                } else if (e.shiftKey) {
                  audio.deleteHotCue(index, i);
                  if (songId) clearHotCueMut.mutate({ songId, slot: i });
                } else {
                  audio.jumpHotCue(index, i);
                }
              }}
              onContextMenu={(e) => {
                e.preventDefault();
                if (set) {
                  audio.deleteHotCue(index, i);
                  if (songId) clearHotCueMut.mutate({ songId, slot: i });
                }
              }}
              style={{ flex: 1, height: 22, borderRadius: 3, fontSize: 9, fontWeight: 700,
                background: set ? "#00b4ff" : "rgba(255,255,255,0.05)",
                color: set ? "#000" : "var(--md-text-muted)", border: "none",
                cursor: state.loaded ? "pointer" : "not-allowed", opacity: state.loaded ? 1 : 0.35 }}>
              {i + 1}
            </button>
          );
        })}
      </div>

      {/* ── Row 7: loops ── */}
      <div style={{ display: "flex", gap: 3, alignItems: "center", flexWrap: "wrap" }}>
        <span style={{ fontSize: 8, color: "var(--md-text-muted)", flexShrink: 0, width: 22 }}>LOOP</span>
        {[1, 2, 4, 8, 16].map((b) => (
          <button key={b} disabled={!state.loaded} onClick={() => audio.deckLoopBeats(index, b)}
            style={{ padding: "2px 6px", borderRadius: 3, fontSize: 9, fontWeight: 700,
              background: state.looping && state.loopBeats === b ? "#38d39f" : "#1a1a22",
              color: state.looping && state.loopBeats === b ? "#000" : "#38d39f",
              border: "none", cursor: state.loaded ? "pointer" : "not-allowed", opacity: state.loaded ? 1 : 0.35 }}>
            {b}
          </button>
        ))}
        <button disabled={!state.loaded} onClick={() => audio.deckLoopScale(index, 0.5)}
          style={{ padding: "2px 5px", borderRadius: 3, fontSize: 9, fontWeight: 700, background: "#1a1a22", color: "#38d39f", border: "none", cursor: "pointer" }}>÷2</button>
        <button disabled={!state.loaded} onClick={() => audio.deckLoopScale(index, 2)}
          style={{ padding: "2px 5px", borderRadius: 3, fontSize: 9, fontWeight: 700, background: "#1a1a22", color: "#38d39f", border: "none", cursor: "pointer" }}>×2</button>
        <button disabled={!state.loaded} onClick={() => audio.deckLoopIn(index)}
          style={{ padding: "2px 6px", borderRadius: 3, fontSize: 9, background: "#1a1a22", color: "#fff", border: "none", cursor: "pointer" }}>IN</button>
        <button disabled={!state.loaded} onClick={() => audio.deckLoopOut(index)}
          style={{ padding: "2px 6px", borderRadius: 3, fontSize: 9, background: "#1a1a22", color: "#fff", border: "none", cursor: "pointer" }}>OUT</button>
        <button disabled={!state.loaded}
          onClick={() => state.looping ? audio.deckLoopExit(index) : audio.deckReloop(index)}
          style={{ padding: "2px 6px", borderRadius: 3, fontSize: 9, fontWeight: 700,
            background: state.looping ? "#38d39f" : "#1a1a22", color: state.looping ? "#000" : "#38d39f",
            border: "none", cursor: "pointer" }}>
          {state.looping ? "EXIT" : "RELOOP"}
        </button>
      </div>

      {/* ── Row 8: STEMS — channel strips, flex-1 fills remaining deck height ── */}
      {stems.length > 0 && (
        <div style={{ flex: 1, minHeight: 0, overflow: "hidden", display: "flex", flexDirection: "column" }}>

          <button onClick={() => setStemsOpen((o) => !o)}
            style={{ fontSize: 8, letterSpacing: "0.12em", padding: "2px 0",
              background: "none", border: "none", cursor: "pointer", textAlign: "left", flexShrink: 0,
              color: stems.some((s) => s.muted) ? "#ff8c1a" : "var(--md-text-muted)" }}>
            {stemsOpen ? "▾" : "▸"} STEMS ({stems.length})
            {stems.some((s) => s.muted) && " · MUTED"}
          </button>

          {stemsOpen && (
            <div style={{ flex: 1, minHeight: 0, display: "flex", gap: 3, paddingTop: 3 }}>
              {stems.map((stem) => {
                const isIem = /click|guide|iem/i.test(stem.name);
                const sc = isIem ? "#38d39f" : color;
                // 150 max so 100% = 2/3 up the fader — gives real headroom above unity
                const val = Math.round((stem.gain ?? 1) * 100);
                const clamped = Math.min(150, val);

                return (
                  <div key={stem.index}
                    style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column",
                      alignItems: "center", gap: 2,
                      padding: "4px 3px 4px", borderRadius: 5,
                      background: stem.muted ? "rgba(255,85,85,0.1)" : "rgba(255,255,255,0.04)",
                      border: `1px solid ${stem.muted ? "#ff555533" : sc + "22"}` }}>

                    {/* Name */}
                    <span style={{ fontSize: 7, fontWeight: 700, textAlign: "center",
                      overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                      width: "100%", flexShrink: 0,
                      color: stem.muted ? "rgba(255,255,255,0.3)" : sc,
                      opacity: stem.muted ? 0.6 : 1 }}>
                      {stem.name}
                    </span>

                    {/* Route badge */}
                    <span style={{ fontSize: 6, padding: "0 4px", borderRadius: 2, flexShrink: 0,
                      background: isIem ? "#38d39f33" : sc + "22",
                      color: isIem ? "#38d39f" : sc, fontWeight: 700, letterSpacing: "0.1em" }}>
                      {isIem ? "IEM" : "MAIN"}
                    </span>

                    {/* Vertical fader — fills all available height.
                        Max=150 so 100% sits at 2/3 up, leaving visual headroom.
                        A thin mark at 2/3 height (100% position) helps orientation. */}
                    <div style={{ flex: 1, minHeight: 0, display: "flex", alignItems: "center",
                      justifyContent: "center", position: "relative", width: "100%" }}>
                      {/* Unity-gain line at the 100/150 = 66.7% position from bottom */}
                      <div style={{ position: "absolute", left: 0, right: 0,
                        bottom: "calc(66.7% - 1px)", height: 1,
                        background: "rgba(255,255,255,0.15)", pointerEvents: "none" }} />
                      <input type="range" min={0} max={150} value={clamped}
                        onChange={(e) => audio.setDeckStem(index, stem.index, { gain: Number(e.target.value) / 100 })}
                        style={{
                          writingMode: "vertical-lr" as const,
                          direction: "rtl" as const,
                          WebkitAppearance: "slider-vertical" as const,
                          width: 24, height: "100%",
                          accentColor: stem.muted ? "#555" : sc,
                          cursor: "pointer", opacity: stem.muted ? 0.4 : 1,
                        } as React.CSSProperties} />
                    </div>

                    {/* % value — red if clipping above 100 */}
                    <span style={{ fontSize: 7, flexShrink: 0, textAlign: "center",
                      fontVariantNumeric: "tabular-nums",
                      color: val > 105 ? "#ff8c1a" : "var(--md-text-muted)" }}>
                      {val}%
                    </span>

                    {/* Mute button */}
                    <button onClick={() => audio.setDeckStem(index, stem.index, { muted: !stem.muted })}
                      title={stem.muted ? `Unmute ${stem.name}` : `Mute ${stem.name}`}
                      style={{ width: "100%", padding: "3px 0", borderRadius: 3, flexShrink: 0,
                        border: "none", cursor: "pointer", fontSize: 7, fontWeight: 900,
                        background: stem.muted ? "#ff5555" : sc + "22",
                        color: stem.muted ? "#fff" : sc }}>
                      {stem.muted ? "MUTE" : "M"}
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Page ───────────────────────────────────────────────────────────────────────

// BPM display: drag up/down to adjust · double-click to type exact value
function BpmDisplay({ bpm, onChange }: { bpm: number | null; onChange: (v: number) => void }) {
  const [editing, setEditing] = React.useState(false);
  const [draft, setDraft] = React.useState("");
  const dragRef = React.useRef<{ startY: number; startBpm: number } | null>(null);

  const commit = (val: string) => {
    const n = parseFloat(val);
    if (!isNaN(n) && n > 20 && n < 300) onChange(Math.round(n * 10) / 10);
    setEditing(false);
  };

  const onPointerDown = (e: React.PointerEvent<HTMLSpanElement>) => {
    if (editing) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    dragRef.current = { startY: e.clientY, startBpm: bpm ?? 120 };
  };
  const onPointerMove = (e: React.PointerEvent<HTMLSpanElement>) => {
    if (!dragRef.current) return;
    const delta = dragRef.current.startY - e.clientY; // drag up = increase
    const newBpm = Math.max(20, Math.min(300,
      dragRef.current.startBpm + delta * 0.1  // 10px per 1 BPM
    ));
    onChange(Math.round(newBpm * 10) / 10);
  };
  const onPointerUp = () => { dragRef.current = null; };

  if (editing) return (
    <input autoFocus type="number" step="0.1" min="20" max="300" value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={(e) => commit(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter") commit((e.target as HTMLInputElement).value);
        if (e.key === "Escape") setEditing(false);
      }}
      style={{ width: 68, fontWeight: 700, fontSize: 16, fontVariantNumeric: "tabular-nums",
        background: "rgba(0,180,255,0.12)", border: "1px solid #00b4ff", borderRadius: 4,
        color: "#00b4ff", padding: "0 4px", textAlign: "center" }} />
  );

  return (
    <span
      onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp}
      onDoubleClick={() => { setDraft(bpm ? bpm.toFixed(1) : ""); setEditing(true); }}
      title="Drag up/down to adjust BPM · double-click to type exact value"
      style={{ cursor: "ns-resize", borderRadius: 4, padding: "0 2px", userSelect: "none",
        touchAction: "none" }}>
      {bpm ? bpm.toFixed(2) : "—"}
    </span>
  );
}


// ── Set Timer ──────────────────────────────────────────────────────────────
// Shared timer hook — returns formatted elapsed string
function useSetTimer(running: boolean, startTime: number) {
  const [display, setDisplay] = React.useState("00:00:00");
  React.useEffect(() => {
    if (!running) return;
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
  return display;
}

// Compact header display — small green digits + REC dot
function SetTimerDisplay({ recording, startTime }: { recording: boolean; startTime: number }) {
  const display = useSetTimer(recording, startTime);
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6, marginLeft: 4 }}>
      {recording && <span style={{ width: 6, height: 6, borderRadius: "50%",
        background: "#ff3333", boxShadow: "0 0 6px #ff3333", flexShrink: 0,
        animation: "pulse 1s infinite" }} />}
      <span style={{ fontFamily: "monospace", fontSize: 13, fontWeight: 700,
        fontVariantNumeric: "tabular-nums", letterSpacing: 1,
        color: recording ? "#38d39f" : "rgba(255,255,255,0.25)" }}>
        {display}
      </span>
    </div>
  );
}

// Large green timer for the strip area
function SetTimerLarge({ running, startTime, onStart, onStop, onReset }: {
  running: boolean; startTime: number;
  onStart: () => void; onStop: () => void; onReset: () => void;
}) {
  const display = useSetTimer(running, startTime);
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 16, padding: "0 8px" }}>
      <div style={{ fontFamily: "Orbitron, monospace", fontSize: 36, fontWeight: 900,
        fontVariantNumeric: "tabular-nums", letterSpacing: 4,
        color: running ? "#38d39f" : "rgba(56,211,159,0.3)",
        textShadow: running ? "0 0 20px #38d39f66" : "none",
        transition: "color 0.4s, text-shadow 0.4s", minWidth: 220 }}>
        {display}
      </div>
      <div style={{ display: "flex", gap: 6 }}>
        {!running ? (
          <button onClick={onStart}
            style={{ padding: "5px 14px", borderRadius: 5, fontSize: 10, fontWeight: 700,
              cursor: "pointer", background: "#38d39f", color: "#000", border: "none",
              boxShadow: "0 0 10px #38d39f55" }}>
            ▶ START
          </button>
        ) : (
          <button onClick={onStop}
            style={{ padding: "5px 14px", borderRadius: 5, fontSize: 10, fontWeight: 700,
              cursor: "pointer", background: "#ff8c1a", color: "#000", border: "none" }}>
            ⏸ STOP
          </button>
        )}
        <button onClick={onReset}
          style={{ padding: "5px 12px", borderRadius: 5, fontSize: 10, fontWeight: 700,
            cursor: "pointer", background: "#2a1a1a", color: "#ff4444",
            border: "1px solid #ff444433" }}>
          ↺ RESET
        </button>
      </div>
    </div>
  );
}

export default function DjDecks() {
  const [, navigate] = useLocation();
  const audio = useTransport();
  const { decks, deckWaveforms, deckStems, clock, masterDeck, crossfader, deckSongIds } = audio;
  const [boundary, setBoundary] = useState(16);
  // masterCue now comes from the engine via telemetry
  const [scrollDiv, setScrollDiv] = useState(1);

  // Tap tempo — records last 8 timestamps, calculates BPM from average interval
  const [setRecording, setSetRecording] = React.useState(false);
  const [setStartTime, setSetStartTime] = React.useState(0);

  // Sync timer to all connected screens (Live Screen, Companion)
  React.useEffect(() => {
    audio.broadcastTimer(setRecording, setStartTime);
  }, [setRecording, setStartTime]); // eslint-disable-line react-hooks/exhaustive-deps

  const tapTsRef = useRef<number[]>([]);
  const tapClearRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const handleTapTempo = useCallback(() => {
    const now = performance.now();
    const taps = tapTsRef.current;
    if (taps.length > 0 && now - taps[taps.length - 1] > 2000) taps.length = 0;
    taps.push(now);
    if (taps.length > 8) taps.splice(0, taps.length - 8);
    if (taps.length >= 2) {
      const avg = taps.slice(1).reduce((sum, t, i) => sum + (t - taps[i]), 0) / (taps.length - 1);
      const tappedBpm = Math.round((60000 / avg) * 10) / 10;
      // Always update both clocks — the active authority wins in the engine
      audio.setMasterBpm(tappedBpm);
      // Also pitch the master deck to match if loaded
      if (decks[masterDeck]?.bpm && decks[masterDeck].bpm > 0) {
        const newRate = Math.max(0.5, Math.min(2.0, tappedBpm / decks[masterDeck].bpm));
        audio.setDeckRate(masterDeck, newRate);
      }
    }
    if (tapClearRef.current) clearTimeout(tapClearRef.current);
    tapClearRef.current = setTimeout(() => { tapTsRef.current = []; }, 2500);
  }, [audio]);
  const { data: songs } = trpc.songs.list.useQuery();

  let clockText = "SPLIT", clockColor = "#ff8c1a";
  if (clock.authority === "dj")      { clockText = "DJ MASTER";     clockColor = "#38d39f"; }
  if (clock.authority === "rockdj")  { clockText = "ROCKDJ MASTER"; clockColor = "#00b4ff"; }
  if (clock.authority === "handoff") { clockText = "HANDOFF…";      clockColor = "#f0a53a"; }

  // Look up the current track key for each deck
  const deckKeys = deckSongIds.map((id) => {
    const s = songs?.find((t) => t.id === id);
    return s?.key ?? null;
  });

  const launchBars = clock.beatsUntilLaunch > 0 ? Math.ceil(clock.beatsUntilLaunch / 4) : 0;

  return (
    <div style={{
      height: "100vh", display: "flex", flexDirection: "column", overflow: "clip",
      padding: "6px", gap: "5px", background: "#0B0B0F", color: "#fff", fontFamily: "system-ui,sans-serif",
    }}>
      {/* ── Header: logo + global clock ── */}
      <div style={{ flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "space-between",
        background: "#111117", borderRadius: 8, padding: "4px 12px",
        border: "1px solid rgba(255,255,255,0.07)" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          {/* ← Back — large enough to find in a dim venue */}
          <button onClick={() => navigate("/")}
            style={{
              display: "flex", alignItems: "center", gap: 6,
              padding: "5px 14px", borderRadius: 6, cursor: "pointer",
              background: "rgba(123,44,249,0.2)",
              border: "1px solid rgba(123,44,249,0.6)",
              color: "#fff", fontSize: 11, fontWeight: 800,
              letterSpacing: "0.08em",
              boxShadow: "0 0 8px rgba(123,44,249,0.3)",
            }}>
            ◀ MENU
          </button>
          <span style={{ fontFamily: "Orbitron,sans-serif", fontWeight: 900, fontSize: "0.95rem", letterSpacing: "0.05em" }}>
            <span style={{ color: "#fff" }}>ROCK</span>
            <span style={{ background: "linear-gradient(135deg,#7B2CF9,#B24BFF)", WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent" }}>DJ</span>
          </span>
          <span style={{ fontSize: 8, letterSpacing: "0.2em", color: "var(--md-text-muted)" }}>LIVE OS</span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <span style={{ fontWeight: 700, fontSize: 16, fontVariantNumeric: "tabular-nums" }}>
            <BpmDisplay bpm={clock.bpm} onChange={(v) => audio.setMasterBpm(v)} />
            {" "}<span style={{ fontSize: 9, color: "var(--md-text-muted)" }}>BPM</span>
          </span>
          <span style={{ fontSize: 11, color: "var(--md-text-muted)" }}>
            BAR <span style={{ color: "#fff", fontVariantNumeric: "tabular-nums" }}>{clock.bar}.{clock.beat}</span>
          </span>
          <button onClick={handleTapTempo}
            title="Tap to the beat — 2+ taps sets the BPM, resets after 2.5s"
            style={{ fontSize: 9, padding: "2px 8px", borderRadius: 4, background: "#1a1a22", color: "#fff", border: "1px solid rgba(255,255,255,0.15)", cursor: "pointer",
              transition: "background 0.05s" }}
            onMouseDown={(e) => (e.currentTarget.style.background = "#444")}
            onMouseUp={(e) => (e.currentTarget.style.background = "#1a1a22")}>
            TAP
          </button>
          <span style={{ fontSize: 10, fontWeight: 700, padding: "2px 8px", borderRadius: 4, color: clockColor, border: `1px solid ${clockColor}` }}>{clockText}</span>
          {/* Ableton Link */}
          <LinkPanel audio={audio} />

          {/* Band sync shortcuts */}
          <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
            {BOUNDARIES.map((b) => (
              <button key={b.beats} onClick={() => setBoundary(b.beats)}
                style={{ fontSize: 8, padding: "2px 5px", borderRadius: 3, cursor: "pointer",
                  background: boundary === b.beats ? "#00b4ff22" : "#1a1a22",
                  color: boundary === b.beats ? "#00b4ff" : "var(--md-text-muted)", border: "none" }}>
                {b.label}
              </button>
            ))}
            <button onClick={() => audio.armLaunch(boundary)}
              style={{ fontSize: 8, padding: "2px 6px", borderRadius: 3, cursor: "pointer",
                background: "rgba(240,165,58,0.15)", color: "#f0a53a", border: "none" }}>
              LAUNCH{launchBars > 0 ? ` (${launchBars})` : ""}
            </button>
            <button onClick={() => audio.armHandoff("dj", boundary)}
              style={{ fontSize: 8, padding: "2px 6px", borderRadius: 3, cursor: "pointer", background: "rgba(56,211,159,0.1)", color: "#38d39f", border: "none" }}>
              →DJ
            </button>
            <button onClick={() => audio.armHandoff("rockdj", boundary)}
              style={{ fontSize: 8, padding: "2px 6px", borderRadius: 3, cursor: "pointer", background: "rgba(0,180,255,0.1)", color: "#00b4ff", border: "none" }}>
              →BAND
            </button>
          </div>
        </div>
      </div>

      {/* ── Decks: side by side, takes all available height ── */}
      <div style={{ flex: 1, minHeight: 0, display: "flex", gap: 5 }}>
        <Deck index={0} state={decks[0]} peaks={deckWaveforms[0]} stems={deckStems[0]}
          isMaster={masterDeck === 0} autoMaster={audio.autoMaster} audio={audio} songKey={deckKeys[0]} />
        {/* ── Master section: VU meter + fader between the two decks ── */}
        <div style={{ width: 72, flexShrink: 0, background: "#111117",
          border: "1px solid rgba(255,255,255,0.1)", borderRadius: 8,
          padding: "6px 4px", display: "flex", flexDirection: "column" }}>
          <MasterVU peak={audio.masterPeak ?? 0} gain={audio.masterGain}
            onChange={(g) => audio.setMasterGain(g)} />
        </div>

        <Deck index={1} state={decks[1]} peaks={deckWaveforms[1]} stems={deckStems[1]}
          isMaster={masterDeck === 1} autoMaster={audio.autoMaster} audio={audio} songKey={deckKeys[1]} />
      </div>

      {/* ── Crossfader + PFL + Scroll speed + Master VU ── */}
      <div style={{ flexShrink: 0, height: 108, display: "flex", alignItems: "stretch", gap: 8,
        background: "#111117", borderRadius: 6, padding: "6px 10px",
        border: "1px solid rgba(255,255,255,0.07)" }}>
        {/* Left: crossfader + PFL + scroll — flex column */}
        <div style={{ flex: 1, display: "flex", flexDirection: "column", justifyContent: "space-between", gap: 4, overflow: "hidden" }}>

        {/* Crossfader + PFL inline */}
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ fontSize: 8, color: "#7B2CF9", fontWeight: 700 }}>A</span>
          <span style={{ fontSize: 8, color: "var(--md-text-muted)" }}>XFADER</span>
          <input type="range" min={0} max={100} value={Math.round(crossfader * 100)}
            onChange={(e) => audio.setCrossfader(parseInt(e.target.value) / 100)}
            style={{ width: 180, height: 14, accentColor: "#fff" }} />
          <span style={{ fontSize: 8, color: "#00d4ff", fontWeight: 700 }}>B</span>
          <div style={{ width: 1, height: 12, background: "rgba(255,255,255,0.1)", margin: "0 4px" }} />
          <span style={{ fontSize: 8, color: "var(--md-text-muted)" }}>🎧</span>
          {[0, 1].map((di) => {
            const active = decks[di].cueEnabled;
            const col = DECK_COLORS[di];
            return (
              <button key={di} onClick={() => audio.setDeckCue(di, !active)}
                style={{ padding: "2px 7px", borderRadius: 4, fontSize: 9, fontWeight: 700, cursor: "pointer",
                  background: active ? col : "#1a1a22", color: active ? "#000" : col,
                  border: `1px solid ${col}55`, boxShadow: active ? `0 0 8px ${col}88` : "none" }}>
                {di === 0 ? "A" : "B"}
              </button>
            );
          })}
          <button onClick={() => audio.setMasterCue(!audio.masterCue)}
            style={{ padding: "2px 7px", borderRadius: 4, fontSize: 9, fontWeight: 700, cursor: "pointer",
              background: audio.masterCue ? "#38d39f" : "#1a1a22",
              color: audio.masterCue ? "#000" : "#38d39f",
              border: "1px solid #38d39f33",
              boxShadow: audio.masterCue ? "0 0 8px #38d39f88" : "none" }}>
            M
          </button>
        </div>

        {/* MASTER readout + LARGE SET TIMER */}
        <div style={{ display: "flex", alignItems: "center", gap: 10, flex: 1 }}>
          <div style={{ flex: 1 }} />
          <SetTimerLarge
            running={setRecording}
            startTime={setStartTime}
            onStart={() => { setSetStartTime(Date.now()); setSetRecording(true); }}
            onStop={() => setSetRecording(false)}
            onReset={() => { setSetRecording(false); setSetStartTime(0); }}
          />
        </div>

        {/* Browse scroll speed */}
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <span style={{ fontSize: 8, color: "var(--md-text-muted)", flexShrink: 0 }}>BROWSE ÷</span>
          {[1, 2, 4, 8].map((d) => (
            <button key={d} onClick={() => { setScrollDiv(d); audio.setLibraryScrollDiv(d); }}
              style={{ padding: "2px 7px", borderRadius: 3, fontSize: 9, fontWeight: 700, cursor: "pointer",
                background: scrollDiv === d ? "#7B2CF9" : "#1a1a22",
                color: scrollDiv === d ? "#fff" : "var(--md-text-muted)",
                border: `1px solid ${scrollDiv === d ? "#7B2CF9" : "rgba(255,255,255,0.12)"}` }}>
              {d}
            </button>
          ))}
        </div>
        </div>{/* end left column */}


      </div>

      {/* ── Library: pinned to bottom, fills its fixed height, scrolls internally ── */}
      <div style={{ flexShrink: 0, height: 210, display: "flex", flexDirection: "column", overflow: "hidden" }}>
        <TrackBrowser audio={audio} />
      </div>

      {/* ── DJ Setup: always-collapsed footer ── */}
      <div style={{ flexShrink: 0 }}>
        <DjSetupPanel audio={audio} decks={decks} />
      </div>
    </div>
  );
}
