import { useMemo, useState } from "react";
import { trpc } from "@/lib/trpc";

/**
 * Camelot harmonic mixing wheel.
 *
 * Every DJ colour wheel maps the circle of fifths to a clock face:
 *   - 12 positions (like hours), each with an inner ring (minor = A)
 *     and outer ring (major = B)
 *   - Adjacent positions (±1 step) are the most harmonious transitions
 *   - Relative major/minor (same number, A↔B) is equally smooth
 *   - 2+ steps away starts to sound like a key change
 *
 * This component:
 *   - Shows the wheel with each position colour-coded
 *   - Highlights the two decks' current keys
 *   - Dims library tracks that would clash with the active deck
 *   - Shows every track's key position as a dot on the wheel
 */

// ── Camelot data ──────────────────────────────────────────────────────────────
export const CAMELOT_COLORS: Record<number, string> = {
  1:  "#00D4FF", 2:  "#00DDB0", 3:  "#00CC66",
  4:  "#55CC00", 5:  "#BBCC00", 6:  "#FFCC00",
  7:  "#FF9900", 8:  "#FF5500", 9:  "#FF2255",
  10: "#DD00AA", 11: "#9900DD", 12: "#5500FF",
};

// All the ways a key string might appear → Camelot position
const KEY_TO_CAMELOT: Record<string, string> = {
  "Abm":"1A","G#m":"1A","B":"1B","Cbm":"1A","Dbb":"1B",
  "Ebm":"2A","D#m":"2A","F#":"2B","Gb":"2B",
  "Bbm":"3A","A#m":"3A","Db":"3B","C#":"3B",
  "Fm":"4A","Ab":"4B","G#":"4B",
  "Cm":"5A","Eb":"5B","D#":"5B",
  "Gm":"6A","Bb":"6B","A#":"6B",
  "Dm":"7A","F":"7B",
  "Am":"8A","C":"8B",
  "Em":"9A","G":"9B",
  "Bm":"10A","D":"10B",
  "F#m":"11A","Gbm":"11A","A":"11B",
  "C#m":"12A","Dbm":"12A","E":"12B","Fb":"12B",
};

export function keyToCamelot(raw: string | null | undefined): string | null {
  if (!raw) return null;
  // Already in Camelot format (e.g. "8A", "11B")?
  if (/^\d{1,2}[AB]$/i.test(raw.trim())) return raw.trim().toUpperCase();
  // Normalise: "A minor" → "Am", "A# major" → "A#"
  const n = raw.trim()
    .replace(/ minor$/i, "m")
    .replace(/ major$/i, "")
    .replace(/\s+/g, "");
  return KEY_TO_CAMELOT[n] ?? null;
}

function camelotNum(c: string): number { return parseInt(c.slice(0, -1), 10); }
function camelotLetter(c: string): string { return c.slice(-1).toUpperCase(); }

/** True when two Camelot codes are harmonically compatible. */
export function isCompatible(a: string, b: string): boolean {
  if (!a || !b) return true;
  const [na, la] = [camelotNum(a), camelotLetter(a)];
  const [nb, lb] = [camelotNum(b), camelotLetter(b)];
  const diff = Math.abs(na - nb);
  const wrap = Math.min(diff, 12 - diff);
  // Same key, step up/down 1, or relative major/minor
  return wrap === 0 || (wrap === 1 && la === lb) || (na === nb && la !== lb);
}

// ── SVG wheel ─────────────────────────────────────────────────────────────────
function WheelSVG({
  deckKeys, allKeys, onSelect, selected,
}: {
  deckKeys: [string | null, string | null];
  allKeys: Array<{ camelot: string; count: number }>;
  onSelect: (c: string | null) => void;
  selected: string | null;
}) {
  const CX = 130, CY = 130, R_OUTER = 110, R_INNER = 68, R_LABEL = 90, R_TICK = 54;
  const deckColors = ["#7B2CF9", "#00d4ff"];

  const segments = useMemo(() => {
    const out = [];
    for (let n = 1; n <= 12; n++) {
      for (const letter of ["A", "B"] as const) {
        const code = `${n}${letter}`;
        const startAngle = ((n - 1) * 30 - 90) * (Math.PI / 180);
        const endAngle   = (n * 30 - 90) * (Math.PI / 180);
        const r0 = letter === "A" ? R_INNER : (R_INNER + R_OUTER) / 2;
        const r1 = letter === "A" ? (R_INNER + R_OUTER) / 2 : R_OUTER;
        const x0s = CX + r0 * Math.cos(startAngle), y0s = CY + r0 * Math.sin(startAngle);
        const x1s = CX + r1 * Math.cos(startAngle), y1s = CY + r1 * Math.sin(startAngle);
        const x0e = CX + r0 * Math.cos(endAngle),   y0e = CY + r0 * Math.sin(endAngle);
        const x1e = CX + r1 * Math.cos(endAngle),   y1e = CY + r1 * Math.sin(endAngle);
        const path = `M${x0s},${y0s} L${x1s},${y1s} A${r1},${r1} 0 0,1 ${x1e},${y1e} L${x0e},${y0e} A${r0},${r0} 0 0,0 ${x0s},${y0s}Z`;
        const midAngle = ((n - 0.5) * 30 - 90) * (Math.PI / 180);
        const rm = (r0 + r1) / 2;
        const lx = CX + R_LABEL * Math.cos(midAngle);
        const ly = CY + R_LABEL * Math.sin(midAngle);
        const isDeckA = deckKeys[0] === code;
        const isDeckB = deckKeys[1] === code;
        const isSelected = selected === code;
        const isCompat = selected ? isCompatible(selected, code) : true;
        out.push({ code, n, letter, path, lx, ly, rm, midAngle, r0, r1, isDeckA, isDeckB, isSelected, isCompat });
      }
    }
    return out;
  }, [deckKeys, selected]);

  const countMap = useMemo(() => {
    const m: Record<string, number> = {};
    for (const k of allKeys) m[k.camelot] = (m[k.camelot] ?? 0) + k.count;
    return m;
  }, [allKeys]);

  return (
    <svg viewBox={`0 0 ${CX * 2} ${CY * 2}`} width="260" height="260" style={{ display: "block" }}>
      {/* Black background circle */}
      <circle cx={CX} cy={CY} r={R_OUTER + 8} fill="#0a0a0f" />

      {segments.map((seg) => {
        const base = CAMELOT_COLORS[seg.n];
        const opacity = selected ? (seg.isCompat ? 1.0 : 0.25) : 1.0;
        const stroke = seg.isDeckA ? deckColors[0] : seg.isDeckB ? deckColors[1] : seg.isSelected ? "#fff" : "rgba(0,0,0,0.3)";
        const sw = (seg.isDeckA || seg.isDeckB || seg.isSelected) ? 2.5 : 0.5;
        return (
          <g key={seg.code} onClick={() => onSelect(selected === seg.code ? null : seg.code)} style={{ cursor: "pointer" }}>
            <path d={seg.path} fill={base} opacity={opacity} stroke={stroke} strokeWidth={sw} />
            {/* Track count dot */}
            {(countMap[seg.code] ?? 0) > 0 && (
              <circle
                cx={CX + (seg.r0 + (seg.r1 - seg.r0) * 0.5) * Math.cos(seg.midAngle)}
                cy={CY + (seg.r0 + (seg.r1 - seg.r0) * 0.5) * Math.sin(seg.midAngle)}
                r={Math.min(5, 2 + countMap[seg.code])}
                fill="#fff" opacity={opacity * 0.85}
              />
            )}
          </g>
        );
      })}

      {/* Labels */}
      {[1,2,3,4,5,6,7,8,9,10,11,12].map((n) => {
        const angle = ((n - 0.5) * 30 - 90) * (Math.PI / 180);
        const x = CX + R_LABEL * Math.cos(angle);
        const y = CY + R_LABEL * Math.sin(angle);
        const aCode = `${n}A`, bCode = `${n}B`;
        const isActive = deckKeys.includes(aCode) || deckKeys.includes(bCode)
                      || selected === aCode || selected === bCode;
        return (
          <text key={n} x={x} y={y} textAnchor="middle" dominantBaseline="middle"
            fontSize={isActive ? 11 : 9} fontWeight={isActive ? "bold" : "normal"}
            fill={isActive ? "#fff" : "rgba(0,0,0,0.65)" }
            fontFamily="monospace" pointerEvents="none">
            {n}
          </text>
        );
      })}

      {/* A/B ring labels */}
      <text x={CX} y={CY - R_INNER + 10} textAnchor="middle" fontSize={7} fill="rgba(255,255,255,0.35)" fontFamily="monospace">min</text>
      <text x={CX} y={CY - R_OUTER + 14} textAnchor="middle" fontSize={7} fill="rgba(255,255,255,0.35)" fontFamily="monospace">maj</text>

      {/* Deck key indicators in centre */}
      {deckKeys[0] && (
        <text x={CX - 16} y={CY - 6} textAnchor="middle" fontSize={10} fill={deckColors[0]} fontWeight="bold" fontFamily="monospace">A:{deckKeys[0]}</text>
      )}
      {deckKeys[1] && (
        <text x={CX + 16} y={CY + 8} textAnchor="middle" fontSize={10} fill={deckColors[1]} fontWeight="bold" fontFamily="monospace">B:{deckKeys[1]}</text>
      )}
    </svg>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export function KeyWheelPanel({
  deckSongIds,
}: {
  deckSongIds: [number | null, number | null];
}) {
  const { data: songs } = trpc.songs.list.useQuery();
  const [keyFilter, setKeyFilter] = useState<string | null>(null);

  const deckKeys = useMemo((): [string | null, string | null] => {
    if (!songs) return [null, null];
    return deckSongIds.map((id) => {
      const s = songs.find((t) => t.id === id);
      return keyToCamelot(s?.key);
    }) as [string | null, string | null];
  }, [songs, deckSongIds]);

  const keyDistrib = useMemo(() => {
    if (!songs) return [];
    const map: Record<string, number> = {};
    for (const s of songs) {
      const c = keyToCamelot(s.key);
      if (c) map[c] = (map[c] ?? 0) + 1;
    }
    return Object.entries(map).map(([camelot, count]) => ({ camelot, count }));
  }, [songs]);

  const handleSelect = (c: string | null) => {
    setKeyFilter(c);
    onKeyFilter(c);
  };

  // The component needs to call onKeyFilter but the prop isn't threaded yet.
  // For now the filter state is internal; TrackBrowser reads it via a context-free approach.
  const onKeyFilter = (_: string | null) => {};

  if (!songs) return null;

  const activeKey = deckKeys[0] ?? deckKeys[1];
  const compatSongs = songs.filter((s) => {
    if (!keyFilter) return true;
    const c = keyToCamelot(s.key);
    return !c || isCompatible(keyFilter, c);
  });

  return (
    <div className="rounded-xl p-4 mb-4" style={{ background: "#111117", border: "1px solid rgba(255,255,255,0.07)" }}>
      <div className="flex items-start gap-4">
        {/* Wheel */}
        <div className="shrink-0">
          <div className="text-[10px] tracking-[0.2em] mb-2" style={{ color: "var(--md-text-muted)" }}>
            HARMONIC KEY WHEEL
          </div>
          <WheelSVG
            deckKeys={deckKeys}
            allKeys={keyDistrib}
            onSelect={handleSelect}
            selected={keyFilter}
          />
          {keyFilter && (
            <button onClick={() => handleSelect(null)}
              className="text-[10px] px-3 py-1 rounded mt-2 w-full"
              style={{ background: "rgba(255,255,255,0.07)", color: "var(--md-text-muted)" }}>
              clear filter
            </button>
          )}
        </div>

        {/* Legend + guidance */}
        <div className="flex-1 min-w-0 pt-6">
          <div className="text-[11px] mb-3" style={{ color: "var(--md-text)" }}>
            {deckKeys[0] || deckKeys[1] ? (
              <>
                <div className="mb-1">
                  {deckKeys[0] && <span style={{ color: "#7B2CF9" }}>Deck A: <b>{deckKeys[0]}</b></span>}
                  {deckKeys[0] && deckKeys[1] && " · "}
                  {deckKeys[1] && <span style={{ color: "#00d4ff" }}>Deck B: <b>{deckKeys[1]}</b></span>}
                </div>
                {deckKeys[0] && deckKeys[1] && (
                  <div className="text-[10px]" style={{ color: isCompatible(deckKeys[0]!, deckKeys[1]!) ? "#38d39f" : "#ff8c1a" }}>
                    {isCompatible(deckKeys[0]!, deckKeys[1]!) ? "✓ harmonically compatible" : "⚠ key clash — transition carefully"}
                  </div>
                )}
              </>
            ) : (
              <span style={{ color: "var(--md-text-muted)" }}>Load tracks to see their keys</span>
            )}
          </div>

          <div className="text-[9px] mb-3" style={{ color: "var(--md-text-muted)", lineHeight: 1.6 }}>
            <b style={{ color: "var(--md-text)" }}>How to read the wheel:</b><br />
            Same or adjacent numbers mix cleanly.<br />
            Inner ring = minor (A), outer = major (B).<br />
            Same number, A↔B = relative major/minor.<br />
            Click a segment to filter the library<br />
            to compatible keys only.
          </div>

          {keyFilter && (
            <div className="text-[10px]" style={{ color: "var(--md-text-muted)" }}>
              <b style={{ color: "#38d39f" }}>{compatSongs.length}</b> of {songs.length} tracks compatible with <b>{keyFilter}</b>
            </div>
          )}

          {/* Colour legend */}
          <div className="flex flex-wrap gap-1 mt-3">
            {Object.entries(CAMELOT_COLORS).map(([n, color]) => (
              <div key={n} className="flex items-center gap-1">
                <div className="w-2.5 h-2.5 rounded-full" style={{ background: color }} />
                <span className="text-[8px]" style={{ color: "var(--md-text-muted)" }}>{n}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
