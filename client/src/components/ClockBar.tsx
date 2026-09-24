import { useState } from "react";
import type { TransportAPI } from "@/hooks/useTransport";

/**
 * ClockBar — the always-visible clock-authority display and DJ controls.
 *
 * Shows exactly who owns the musical clock right now:
 *   CLOCK: DJ MASTER      — the DJ's tempo grid leads; the band follows.
 *   CLOCK: ROCKDJ MASTER  — the engine's timeline leads (planned band sections).
 *   HANDOFF IN n BARS     — control is about to pass, at a musical boundary.
 *
 * Controls let the DJ/Band Master set the tempo, tap the downbeat, arm a
 * quantized handoff between masters, and arm band content to launch on a phrase.
 */

const BOUNDARIES: Array<{ label: string; beats: number }> = [
  { label: "Beat", beats: 1 },
  { label: "Bar", beats: 4 },
  { label: "4 Bars", beats: 16 },
  { label: "8 Bars", beats: 32 },
];

export default function ClockBar({ audio }: { audio: TransportAPI }) {
  const { clock } = audio;
  const [boundary, setBoundary] = useState(16); // default 4 bars
  const [bpmInput, setBpmInput] = useState<string>("");

  const beatsPerBar = 4;
  const handoffBars = clock.beatsUntilHandoff >= 0 ? Math.ceil(clock.beatsUntilHandoff / beatsPerBar) : -1;
  const launchBars = clock.beatsUntilLaunch >= 0 ? Math.ceil(clock.beatsUntilLaunch / beatsPerBar) : -1;

  // Status line + colour.
  let statusText: string;
  let statusColor: string;
  if (clock.authority === "handoff") {
    const targetName = clock.handoffTarget === "dj" ? "DJ" : "ROCKDJ";
    statusText = handoffBars > 0 ? `HANDOFF → ${targetName} IN ${handoffBars} BAR${handoffBars === 1 ? "" : "S"}` : `HANDOFF → ${targetName}`;
    statusColor = "#f0a53a";
  } else if (clock.authority === "dj") {
    statusText = "CLOCK: DJ MASTER";
    statusColor = "#38d39f";
  } else {
    statusText = "CLOCK: ROCKDJ MASTER";
    statusColor = "var(--md-blue)";
  }

  const btn = "text-xs px-3 py-1.5 rounded font-semibold transition-opacity hover:opacity-80";

  return (
    <div
      className="mb-4 p-3 rounded-lg"
      style={{ border: `1px solid ${statusColor}`, background: "rgba(255,255,255,0.02)" }}
    >
      {/* Status + position */}
      <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
        <span
          className="text-sm font-bold tracking-wide"
          style={{ color: statusColor, textShadow: clock.authority === "handoff" ? `0 0 8px ${statusColor}` : "none" }}
        >
          {statusText}
        </span>
        <div className="flex items-center gap-4 text-xs" style={{ color: "var(--md-text-muted)" }}>
          <span>
            BAR <span style={{ color: "var(--md-text)", fontVariantNumeric: "tabular-nums" }}>{clock.bar}.{clock.beat}</span>
          </span>
          <span>
            <span style={{ color: "var(--md-text)", fontVariantNumeric: "tabular-nums" }}>{Math.round(clock.bpm)}</span> BPM
          </span>
          {launchBars > 0 && (
            <span style={{ color: "#38d39f" }}>LAUNCH IN {launchBars} BAR{launchBars === 1 ? "" : "S"}</span>
          )}
        </div>
      </div>

      {/* Controls */}
      <div className="flex items-center gap-2 flex-wrap">
        {/* BPM set */}
        <input
          type="number"
          value={bpmInput}
          placeholder={clock.bpm ? String(Math.round(clock.bpm)) : "BPM"}
          onChange={(e) => setBpmInput(e.target.value)}
          onBlur={() => { const v = parseFloat(bpmInput); if (v) audio.setDjBpm(v); }}
          className="w-16 text-xs px-2 py-1.5 rounded"
          style={{ background: "var(--md-surface-3)", color: "var(--md-text)", border: "1px solid var(--md-border)" }}
        />
        <button className={btn} onClick={audio.tapDownbeat}
          style={{ background: "rgba(56,211,159,0.15)", color: "#38d39f" }}>
          TAP DOWNBEAT
        </button>

        {/* Boundary selector */}
        <div className="flex items-center gap-1 ml-2">
          {BOUNDARIES.map((b) => (
            <button key={b.beats} onClick={() => setBoundary(b.beats)} className={btn}
              style={{
                background: boundary === b.beats ? "var(--md-blue)" : "var(--md-surface-3)",
                color: boundary === b.beats ? "#000" : "var(--md-text-muted)",
              }}>
              {b.label}
            </button>
          ))}
        </div>

        {/* Authority arm buttons */}
        <div className="flex items-center gap-1 ml-2">
          <button className={btn} onClick={() => audio.armHandoff("dj", boundary)}
            style={{ background: "rgba(56,211,159,0.15)", color: "#38d39f" }}>
            → DJ MASTER
          </button>
          <button className={btn} onClick={() => audio.armHandoff("rockdj", boundary)}
            style={{ background: "rgba(0,180,255,0.15)", color: "var(--md-blue)" }}>
            → ROCKDJ MASTER
          </button>
          {clock.authority === "handoff" && (
            <button className={btn} onClick={audio.cancelHandoff}
              style={{ background: "rgba(255,51,85,0.15)", color: "var(--md-red)" }}>
              CANCEL
            </button>
          )}
        </div>

        {/* Quantized launch */}
        <button className={btn} onClick={() => audio.armLaunch(boundary)}
          style={{ background: "rgba(240,165,58,0.15)", color: "#f0a53a", marginLeft: "auto" }}>
          ARM LAUNCH
        </button>
      </div>
    </div>
  );
}
