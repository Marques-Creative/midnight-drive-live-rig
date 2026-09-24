/**
 * MarkerEditor — add section labels and band notes to the song waveform.
 *
 * Markers appear as coloured flags on the OverviewWaveform in both
 * the DJ Decks and the Live Screen. The upcoming-marker banner on the
 * Live Screen lets the band anticipate section changes.
 */
import { useRef, useState } from "react";
import { trpc } from "../lib/trpc";
import OverviewWaveform from "./OverviewWaveform";

export interface SongMarker {
  id: string;
  timeSeconds: number;
  label: string;
  note?: string;
  color?: string;      // hex e.g. "#38d39f"
  type?: "section" | "note" | "warning";
}

const PRESETS = [
  { label: "Intro",     color: "#38d39f" },
  { label: "Verse",     color: "#7B2CF9" },
  { label: "Pre-Chorus",color: "#b24bff" },
  { label: "Chorus",    color: "#00b4ff" },
  { label: "Bridge",    color: "#ff8c1a" },
  { label: "Breakdown", color: "#ff5555" },
  { label: "Outro",     color: "#aaaaaa" },
  { label: "Solo",      color: "#f0a53a" },
];

function formatTime(s: number) {
  const m = Math.floor(s / 60);
  return `${m}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
}

export default function MarkerEditor({ songId, initialMarkers, peaks, duration }: {
  songId: number;
  initialMarkers?: string | null;
  peaks?: number[];
  duration?: number;
}) {
  const [markers, setMarkers] = useState<SongMarker[]>(() => {
    try { return JSON.parse(initialMarkers ?? "[]"); } catch { return []; }
  });
  const [editId, setEditId]   = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);
  const [pos, setPos]         = useState(0);
  const [saved, setSaved]     = useState(true);
  const audioRef  = useRef<HTMLAudioElement | null>(null);
  const rafRef    = useRef<number>(0);
  const utils     = trpc.useUtils();
  const saveMut   = trpc.songs.saveMarkers.useMutation({
    onSuccess: () => { setSaved(true); utils.songs.list.invalidate(); },
  });

  const dur = duration ?? 0;

  // Tick the playhead for the mini preview
  const tick = () => {
    if (audioRef.current) setPos(audioRef.current.currentTime);
    rafRef.current = requestAnimationFrame(tick);
  };

  const update = (next: SongMarker[]) => {
    const sorted = [...next].sort((a, b) => a.timeSeconds - b.timeSeconds);
    setMarkers(sorted);
    setSaved(false);
  };

  const addAt = (t: number) => {
    const m: SongMarker = {
      id: Math.random().toString(36).slice(2),
      timeSeconds: Math.round(t * 10) / 10,
      label: "Section",
      color: "#7B2CF9",
      type: "section",
    };
    update([...markers, m]);
    setEditId(m.id);
  };

  const editMarker = markers.find((m) => m.id === editId);

  return (
    <div style={{ color: "#fff", fontSize: 11 }}>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
        <div>
          <span style={{ fontWeight: 800, letterSpacing: "0.1em", color: "#38d39f" }}>WAVEFORM MARKERS</span>
          <span style={{ marginLeft: 8, color: "rgba(255,255,255,0.35)", fontSize: 10 }}>
            section labels + band notes shown on the Live Screen
          </span>
        </div>
        <button onClick={() => saveMut.mutate({ songId, markers: JSON.stringify(markers) })}
          disabled={saved}
          style={{ padding: "4px 12px", borderRadius: 4, border: "none", cursor: saved ? "default" : "pointer",
            background: saved ? "rgba(255,255,255,0.06)" : "#38d39f",
            color: saved ? "rgba(255,255,255,0.3)" : "#000", fontWeight: 800, fontSize: 10 }}>
          {saveMut.isPending ? "Saving…" : saved ? "Saved ✓" : "Save markers"}
        </button>
      </div>

      {/* Waveform: click to add marker */}
      {peaks && peaks.length > 0 && dur > 0 ? (
        <div style={{ marginBottom: 8 }}>
          <p style={{ fontSize: 9, color: "rgba(255,255,255,0.4)", marginBottom: 4 }}>
            Click the waveform to add a marker at that position. Drag existing markers to move them.
          </p>
          <OverviewWaveform
            peaks={peaks} duration={dur} seconds={pos} playing={playing}
            height={52} color="#7B2CF9" markers={markers}
            onSeek={(t) => {
              if (audioRef.current) audioRef.current.currentTime = t;
              setPos(t);
            }}
            onMarkerClick={(id) => setEditId(id === editId ? null : id)}
            onWaveformClick={(t) => addAt(t)}
          />
        </div>
      ) : (
        <p style={{ color: "rgba(255,255,255,0.25)", fontSize: 10, marginBottom: 8 }}>
          Load the song in a DJ deck first to see the waveform here.
        </p>
      )}

      {/* Preset quick-add buttons */}
      <div style={{ display: "flex", gap: 4, flexWrap: "wrap", marginBottom: 10 }}>
        {PRESETS.map(({ label, color }) => (
          <button key={label}
            onClick={() => {
              const t = audioRef.current?.currentTime ?? pos;
              const m: SongMarker = {
                id: Math.random().toString(36).slice(2),
                timeSeconds: Math.round(t * 10) / 10,
                label, color, type: "section",
              };
              update([...markers, m]);
              setEditId(m.id);
            }}
            style={{ padding: "3px 8px", borderRadius: 12, border: `1px solid ${color}66`,
              background: `${color}22`, color, cursor: "pointer", fontSize: 10, fontWeight: 700 }}>
            + {label}
          </button>
        ))}
        <button
          onClick={() => addAt(pos)}
          style={{ padding: "3px 8px", borderRadius: 12, border: "1px solid rgba(255,255,255,0.2)",
            background: "rgba(255,255,255,0.06)", color: "rgba(255,255,255,0.6)", cursor: "pointer", fontSize: 10 }}>
          + Custom
        </button>
      </div>

      {/* Edit panel for selected marker */}
      {editMarker && (
        <div style={{ background: "rgba(56,211,159,0.08)", border: "1px solid #38d39f33",
          borderRadius: 6, padding: "10px 12px", marginBottom: 10 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
            <span style={{ fontSize: 9, color: "#38d39f", fontWeight: 700 }}>EDITING</span>
            <span style={{ fontSize: 10, color: "rgba(255,255,255,0.5)" }}>{formatTime(editMarker.timeSeconds)}</span>
            <button onClick={() => update(markers.filter((m) => m.id !== editId))}
              style={{ marginLeft: "auto", background: "none", border: "none",
                color: "#ff5555", cursor: "pointer", fontSize: 11 }}>
              Delete ×
            </button>
          </div>
          {/* Label */}
          <div style={{ display: "flex", gap: 6, marginBottom: 6, alignItems: "center" }}>
            <span style={{ fontSize: 9, color: "rgba(255,255,255,0.5)", width: 36 }}>Label</span>
            <input value={editMarker.label}
              onChange={(e) => update(markers.map((m) => m.id === editId ? { ...m, label: e.target.value } : m))}
              style={{ flex: 1, background: "#0a0a12", border: "1px solid rgba(255,255,255,0.15)",
                color: "#fff", borderRadius: 4, padding: "3px 8px", fontSize: 11 }} />
            {/* Colour dots */}
            <div style={{ display: "flex", gap: 3 }}>
              {PRESETS.map(({ color }) => (
                <button key={color} onClick={() => update(markers.map((m) => m.id === editId ? { ...m, color } : m))}
                  style={{ width: 14, height: 14, borderRadius: "50%", border: editMarker.color === color ? "2px solid #fff" : "none",
                    background: color, cursor: "pointer" }} />
              ))}
            </div>
          </div>
          {/* Time */}
          <div style={{ display: "flex", gap: 6, marginBottom: 6, alignItems: "center" }}>
            <span style={{ fontSize: 9, color: "rgba(255,255,255,0.5)", width: 36 }}>Time</span>
            <input type="number" min={0} max={dur} step={0.1}
              value={editMarker.timeSeconds}
              onChange={(e) => update(markers.map((m) => m.id === editId ? { ...m, timeSeconds: parseFloat(e.target.value) || 0 } : m))}
              style={{ width: 70, background: "#0a0a12", border: "1px solid rgba(255,255,255,0.15)",
                color: "#fff", borderRadius: 4, padding: "3px 8px", fontSize: 11 }} />
            <span style={{ fontSize: 9, color: "rgba(255,255,255,0.35)" }}>seconds ({formatTime(editMarker.timeSeconds)})</span>
          </div>
          {/* Note */}
          <div style={{ display: "flex", gap: 6, alignItems: "flex-start" }}>
            <span style={{ fontSize: 9, color: "rgba(255,255,255,0.5)", width: 36, paddingTop: 4 }}>Note</span>
            <textarea value={editMarker.note ?? ""}
              onChange={(e) => update(markers.map((m) => m.id === editId ? { ...m, note: e.target.value } : m))}
              placeholder="Band note shown on Live Screen when approaching this section…"
              style={{ flex: 1, background: "#0a0a12", border: "1px solid rgba(255,255,255,0.15)",
                color: "#fff", borderRadius: 4, padding: "4px 8px", fontSize: 10,
                resize: "vertical", minHeight: 40 }} />
          </div>
        </div>
      )}

      {/* Marker list */}
      {markers.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
          {markers.map((m) => (
            <div key={m.id}
              onClick={() => setEditId(m.id === editId ? null : m.id)}
              style={{ display: "flex", alignItems: "center", gap: 8, padding: "5px 8px",
                borderRadius: 4, cursor: "pointer",
                background: editId === m.id ? "rgba(56,211,159,0.08)" : "rgba(255,255,255,0.03)",
                border: `1px solid ${editId === m.id ? "#38d39f33" : "rgba(255,255,255,0.07)"}` }}>
              <div style={{ width: 8, height: 8, borderRadius: "50%", flexShrink: 0,
                background: m.color ?? "#7B2CF9" }} />
              <span style={{ width: 40, flexShrink: 0, fontSize: 9, color: "rgba(255,255,255,0.4)",
                fontVariantNumeric: "tabular-nums" }}>
                {formatTime(m.timeSeconds)}
              </span>
              <span style={{ fontWeight: 700, color: m.color ?? "#7B2CF9", fontSize: 10 }}>{m.label}</span>
              {m.note && (
                <span style={{ flex: 1, fontSize: 9, color: "rgba(255,255,255,0.35)",
                  overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  — {m.note}
                </span>
              )}
              <button onClick={(e) => { e.stopPropagation(); update(markers.filter((x) => x.id !== m.id)); }}
                style={{ marginLeft: "auto", background: "none", border: "none",
                  color: "rgba(255,85,85,0.5)", cursor: "pointer", fontSize: 12, flexShrink: 0 }}>
                ×
              </button>
            </div>
          ))}
        </div>
      )}

      {markers.length === 0 && (
        <p style={{ color: "rgba(255,255,255,0.2)", fontSize: 10, textAlign: "center", marginTop: 12 }}>
          No markers yet — click the waveform or use a preset button above to add your first section marker.
        </p>
      )}
    </div>
  );
}
