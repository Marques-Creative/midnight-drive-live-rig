/**
 * LinkPanel — Ableton Link status and controls for DJ Decks header.
 *
 * Compact enough to live in the header bar without taking over.
 * Expands to a full status overlay when clicked.
 */
import { useState } from "react";
import type { TransportAPI } from "../hooks/useTransport";

const POLICIES = [
  { value: "accept",  label: "Follow Link tempo" },
  { value: "warn",    label: "Warn on changes" },
  { value: "restore", label: "Restore once" },
  { value: "lock",    label: "Lock local tempo" },
] as const;

const QUANTUMS = [1, 2, 4, 8];

export default function LinkPanel({ audio }: { audio: TransportAPI }) {
  const [open, setOpen]       = useState(false);
  const [policy, setPolicy]   = useState<"accept"|"warn"|"restore"|"lock">("lock");
  const [quantum, setQuantum] = useState(4);
  const [startStop, setStartStop] = useState(false);

  const {
    linkEnabled, linkPeers, linkTempo, linkBeat,
    linkPhase, linkQuantum: liveQuantum, linkTempoSource,
    linkEnable, linkSetQuantum, linkSetStartStop, linkSetPolicy,
  } = audio;

  // Pill indicator that lives in the header bar
  const indicator = (
    <button
      onClick={() => setOpen((o) => !o)}
      title="Ableton Link — click for details"
      style={{
        display: "flex", alignItems: "center", gap: 5,
        padding: "3px 10px", borderRadius: 12, cursor: "pointer",
        border: `1px solid ${linkEnabled ? "#00d084" : "rgba(255,255,255,0.15)"}`,
        background: linkEnabled ? "rgba(0,208,132,0.15)" : "rgba(255,255,255,0.05)",
        color: linkEnabled ? "#00d084" : "rgba(255,255,255,0.4)",
        fontSize: 10, fontWeight: 700, letterSpacing: "0.08em",
      }}>
      {/* Link logo (simplified chain links) */}
      <svg width="14" height="10" viewBox="0 0 14 10" fill="none">
        <rect x="0" y="3" width="5" height="4" rx="2"
          fill={linkEnabled ? "#00d084" : "rgba(255,255,255,0.3)"}/>
        <rect x="9" y="3" width="5" height="4" rx="2"
          fill={linkEnabled ? "#00d084" : "rgba(255,255,255,0.3)"}/>
        <line x1="5" y1="5" x2="9" y2="5" stroke={linkEnabled ? "#00d084" : "rgba(255,255,255,0.3)"} strokeWidth="1.5"/>
      </svg>
      LINK
      {linkEnabled && (
        <span style={{ fontSize: 9, opacity: 0.8 }}>
          {linkPeers} peer{linkPeers !== 1 ? "s" : ""}
        </span>
      )}
    </button>
  );

  if (!open) return indicator;

  return (
    <div style={{ position: "relative" }}>
      {indicator}

      {/* Drop-down panel */}
      <div style={{
        position: "absolute", top: "calc(100% + 6px)", right: 0,
        width: 300, zIndex: 200,
        background: "#111117", borderRadius: 8,
        border: "1px solid rgba(255,255,255,0.12)",
        boxShadow: "0 8px 32px rgba(0,0,0,0.6)",
        padding: "14px 16px",
        color: "#fff", fontSize: 11,
      }}>
        {/* Header */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
          <span style={{ fontWeight: 800, letterSpacing: "0.1em", color: "#00d084" }}>
            ABLETON LINK
          </span>
          <button onClick={() => setOpen(false)}
            style={{ background: "none", border: "none", color: "rgba(255,255,255,0.4)", cursor: "pointer", fontSize: 14 }}>
            ×
          </button>
        </div>

        {/* Enable toggle */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
          <span style={{ color: "rgba(255,255,255,0.7)" }}>Link Enabled</span>
          <button
            onClick={() => linkEnable(!linkEnabled)}
            style={{
              padding: "4px 14px", borderRadius: 10, border: "none", cursor: "pointer",
              fontWeight: 700, fontSize: 10, letterSpacing: "0.08em",
              background: linkEnabled ? "#00d084" : "rgba(255,255,255,0.1)",
              color: linkEnabled ? "#000" : "rgba(255,255,255,0.6)",
              boxShadow: linkEnabled ? "0 0 10px #00d08488" : "none",
            }}>
            {linkEnabled ? "ON" : "OFF"}
          </button>
        </div>

        {/* Status grid */}
        {linkEnabled && (
          <div style={{
            display: "grid", gridTemplateColumns: "1fr 1fr",
            gap: "6px 12px", marginBottom: 12,
            padding: "10px", borderRadius: 6,
            background: "rgba(0,208,132,0.06)",
            border: "1px solid rgba(0,208,132,0.15)",
          }}>
            {[
              ["Peers",  linkPeers],
              ["Tempo",  `${linkTempo.toFixed(2)} BPM`],
              ["Beat",   linkBeat.toFixed(2)],
              ["Phase",  `${linkPhase.toFixed(2)} / ${liveQuantum}`],
              ["Source", linkTempoSource === "dj" ? "🎛 DJ" : "🔗 Link"],
              ["Health", linkPeers >= 0 ? "✓ OK" : "⚠ ?"],
            ].map(([label, value]) => (
              <div key={String(label)}>
                <div style={{ color: "rgba(255,255,255,0.4)", fontSize: 9, marginBottom: 1 }}>{label}</div>
                <div style={{ fontWeight: 700, fontVariantNumeric: "tabular-nums" }}>{value}</div>
              </div>
            ))}
          </div>
        )}

        {/* Quantum */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
          <span style={{ color: "rgba(255,255,255,0.7)" }}>Quantum</span>
          <div style={{ display: "flex", gap: 4 }}>
            {QUANTUMS.map((q) => (
              <button key={q}
                onClick={() => { setQuantum(q); linkSetQuantum(q); }}
                style={{
                  padding: "3px 8px", borderRadius: 4, border: "none", cursor: "pointer",
                  fontWeight: 700, fontSize: 10,
                  background: quantum === q ? "#00d084" : "rgba(255,255,255,0.08)",
                  color: quantum === q ? "#000" : "rgba(255,255,255,0.5)",
                }}>
                {q}
              </button>
            ))}
          </div>
        </div>

        {/* Start/stop sync */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
          <span style={{ color: "rgba(255,255,255,0.7)" }}>Start/Stop Sync</span>
          <button
            onClick={() => { const next = !startStop; setStartStop(next); linkSetStartStop(next); }}
            style={{
              padding: "3px 10px", borderRadius: 4, border: "none", cursor: "pointer",
              fontWeight: 700, fontSize: 10,
              background: startStop ? "#00d084" : "rgba(255,255,255,0.08)",
              color: startStop ? "#000" : "rgba(255,255,255,0.5)",
            }}>
            {startStop ? "ON" : "OFF"}
          </button>
        </div>

        {/* Tempo policy */}
        <div style={{ marginBottom: 10 }}>
          <div style={{ color: "rgba(255,255,255,0.4)", fontSize: 9, marginBottom: 4 }}>TEMPO POLICY</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
            {POLICIES.map(({ value, label }) => (
              <button key={value}
                onClick={() => { setPolicy(value); linkSetPolicy(value); }}
                style={{
                  padding: "5px 8px", borderRadius: 4, border: "none", cursor: "pointer",
                  textAlign: "left", fontWeight: policy === value ? 700 : 400, fontSize: 10,
                  background: policy === value ? "rgba(0,208,132,0.2)" : "rgba(255,255,255,0.05)",
                  color: policy === value ? "#00d084" : "rgba(255,255,255,0.5)",
                  borderLeft: policy === value ? "2px solid #00d084" : "2px solid transparent",
                }}>
                {label}
              </button>
            ))}
          </div>
        </div>

        {/* Hint */}
        <p style={{ fontSize: 9, color: "rgba(255,255,255,0.3)", margin: 0, lineHeight: 1.4 }}>
          Enable Link → open MainStage → enable Ableton Link in MainStage preferences.
          Both devices must be on the same WiFi network.
        </p>
      </div>
    </div>
  );
}
