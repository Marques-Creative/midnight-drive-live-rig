import { useEffect, useMemo, useRef, useState } from "react";
import { trpc } from "@/lib/trpc";
import { io } from "socket.io-client";
import type { TransportAPI } from "@/hooks/useTransport";
import { keyToCamelot, isCompatible, CAMELOT_COLORS } from "./KeyWheel";
import { setDeckTrackName } from "@/lib/deckNames";

/**
 * TrackBrowser — the DJ's library for live use.
 *
 * Supports both click-to-load AND hardware navigation:
 *   – RX3 browse rotary scrolls the list (via MIDI libraryNav/libraryDown)
 *   – RX3 LOAD buttons trigger libraryLoad0 / libraryLoad1
 *   – Arrow keys also work when the search box isn't focused
 *
 * The highlighted row is always visible (scrolls into view).
 */
export default function TrackBrowser({ audio }: { audio: TransportAPI }) {
  const { data: songs, isLoading } = trpc.songs.list.useQuery();
  const [search, setSearch] = useState("");
  const [loaded, setLoaded] = useState<{ [deck: number]: number | null }>({ 0: null, 1: null });
  const [cursor, setCursor] = useState(0);
  const cursorRef = useRef(cursor);
  const rowRefs = useRef<(HTMLDivElement | null)[]>([]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const list = songs ?? [];
    if (!q) return list;
    return list.filter(
      (s) =>
        s.title.toLowerCase().includes(q) ||
        (s.artist ?? "").toLowerCase().includes(q) ||
        String(s.bpm ?? "").includes(q),
    );
  }, [songs, search]);

  // Keep cursorRef in sync so the socket handler always reads the latest value.
  useEffect(() => { cursorRef.current = cursor; }, [cursor]);

  // Clamp cursor when the list changes.
  useEffect(() => {
    setCursor((c) => Math.min(c, Math.max(0, filtered.length - 1)));
  }, [filtered.length]);

  // Scroll the highlighted row into view.
  useEffect(() => {
    rowRefs.current[cursor]?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [cursor]);

  const load = (deck: number, songId: number, bpm: number | null, title: string) => {
    audio.loadDeckSong(deck, songId, bpm ?? 120);
    setLoaded((p) => ({ ...p, [deck]: songId }));
    setDeckTrackName(deck, title);
  };

  // Hardware navigation via MIDI library events from the engine.
  useEffect(() => {
    const socket = io(window.location.origin, { path: "/socket.io" });
    socket.on("libraryNav", ({ dir }: { dir: number }) => {
      setCursor((c) => Math.max(0, Math.min(c + dir, (filtered.length || 1) - 1)));
    });
    socket.on("libraryLoad", ({ deck }: { deck: number }) => {
      const song = filtered[cursorRef.current];
      if (song) load(deck, song.id, song.bpm, song.title);
    });
    return () => { socket.close(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filtered]);

  // Keyboard fallback when the search box isn't focused.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (document.activeElement?.tagName === "INPUT") return;
      if (e.key === "ArrowUp")   { e.preventDefault(); setCursor((c) => Math.max(0, c - 1)); }
      if (e.key === "ArrowDown") { e.preventDefault(); setCursor((c) => Math.min(c + 1, filtered.length - 1)); }
      if (e.key === "1") { const s = filtered[cursor]; if (s) load(0, s.id, s.bpm, s.title); }
      if (e.key === "2") { const s = filtered[cursor]; if (s) load(1, s.id, s.bpm, s.title); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filtered, cursor]);

  const deckBtn = (deck: number, songId: number, bpm: number | null, title: string) => {
    const isOn = loaded[deck] === songId;
    const color = deck === 0 ? "#7B2CF9" : "#00d4ff";
    return (
      <button onClick={() => load(deck, songId, bpm, title)}
        className="w-7 h-7 rounded text-xs font-bold cursor-pointer transition-opacity hover:opacity-80"
        style={{ background: isOn ? color : `${color}26`, color: isOn ? "#000" : color, border: `1px solid ${isOn ? color : "transparent"}` }}
        title={`Load onto Deck ${deck + 1}`}>
        {deck + 1}
      </button>
    );
  };

  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column", background: "#111117",
      border: "1px solid rgba(255,255,255,0.07)", borderRadius: 10, padding: "6px 10px" }}>
      <div className="flex items-center justify-between mb-2 gap-3">
        <span className="text-[10px] tracking-[0.2em]" style={{ color: "var(--md-text-muted)" }}>
          TRACK LIBRARY
        </span>
        <span className="text-[9px]" style={{ color: "var(--md-text-muted)" }}>
          rotary scrolls · LOAD 1/2 loads to deck · scroll speed: BROWSE ÷ strip above
        </span>
        <input value={search} onChange={(e) => { setSearch(e.target.value); setCursor(0); }}
          placeholder="Search title, artist, BPM…"
          className="text-xs px-3 py-1.5 rounded flex-1 max-w-xs"
          style={{ background: "#0B0B0F", color: "#fff", border: "1px solid var(--md-border)" }} />
      </div>

      <div style={{ flex: 1, overflowY: "auto", minHeight: 0 }}>
        {isLoading && <div className="text-xs py-3" style={{ color: "var(--md-text-muted)" }}>Loading library…</div>}
        {!isLoading && filtered.length === 0 && (
          <div className="text-xs py-3" style={{ color: "var(--md-text-muted)" }}>
            {songs?.length ? "No tracks match that search." : "No tracks yet — add songs with stems in Song Library."}
          </div>
        )}
        {filtered.map((s, i) => (
          <div key={s.id} ref={(el) => { rowRefs.current[i] = el; }}
            className="flex items-center gap-3 px-2 py-2 rounded cursor-pointer"
            onClick={() => setCursor(i)}
            onDoubleClick={() => load(0, s.id, s.bpm, s.title)}
            style={{
              borderBottom: "1px solid rgba(255,255,255,0.04)",
              background: i === cursor ? "rgba(123,44,249,0.15)" : "transparent",
              outline: i === cursor ? "1px solid #7B2CF944" : "none",
            }}>
            {/* Deck load buttons */}
            <div className="flex gap-1.5 shrink-0">
              {deckBtn(0, s.id, s.bpm, s.title)}
              {deckBtn(1, s.id, s.bpm, s.title)}
            </div>
            {/* Track info */}
            <div className="min-w-0 flex-1">
              <div className="text-sm font-semibold truncate"
                style={{ color: i === cursor ? "#fff" : "var(--md-text)" }}>
                {s.title}
              </div>
              <div className="text-[10px] truncate" style={{ color: "var(--md-text-muted)" }}>
                {s.artist ?? "—"}
              </div>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              {s.bpm && <span className="text-xs" style={{ color: "var(--md-text-muted)", fontVariantNumeric: "tabular-nums" }}>{s.bpm}</span>}
              {s.key && (() => {
                const cam = keyToCamelot(s.key);
                const col = cam ? CAMELOT_COLORS[parseInt(cam.slice(0,-1),10)] : null;
                return (
                  <span className="text-[10px] font-mono font-bold px-1.5 py-0.5 rounded"
                    style={{ background: col ? col + "33" : "rgba(255,255,255,0.08)", color: col ?? "var(--md-text-muted)", border: `1px solid ${col ?? "rgba(255,255,255,0.1)"}44` }}>
                    {cam ?? s.key}
                  </span>
                );
              })()}
            </div>
            {/* Arrow shows what the LOAD button will do */}
            {i === cursor && (
              <span className="text-xs shrink-0 font-bold" style={{ color: "#7B2CF9" }}>◀</span>
            )}
          </div>
        ))}
      </div>

      {filtered.length > 0 && (
        <div className="mt-2 text-[9px]" style={{ color: "var(--md-text-muted)" }}>
          Track {Math.min(cursor + 1, filtered.length)} / {filtered.length}
          {" "}— press 1 or 2 to load highlighted track
        </div>
      )}
    </div>
  );
}
