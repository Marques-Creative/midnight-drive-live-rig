import { useState, useEffect, useRef, useCallback } from "react";
import { useParams, useLocation } from "wouter";
import { trpc } from "@/lib/trpc";
import {
  ArrowLeft, Play, Pause, Square, ChevronDown, ChevronUp,
  Save, Mic2, SkipForward, Clock, Eye, EyeOff, Plus, Trash2,
} from "lucide-react";
import { parseLyricCues, serialiseLyricCues } from "@shared/lyricParser";
import type { LyricCue } from "@shared/lyricParser";
import { toast } from "sonner";

function formatTs(seconds: number): string {
  const m = Math.floor(seconds / 60).toString().padStart(2, "0");
  const s = (seconds % 60).toFixed(1).padStart(4, "0");
  return `${m}:${s}`;
}

function parseTs(str: string): number | null {
  const m = str.match(/^(\d{1,2}):(\d{2}(?:\.\d+)?)$/);
  if (!m) return null;
  return parseInt(m[1]) * 60 + parseFloat(m[2]);
}

type EditorLine = {
  id: string;
  startTime: number | null;
  endTime: number | null;
  chord: string;
  text: string;
  sectionLabel: string;
  isSection: boolean;
};

function cueToLine(cue: LyricCue, idx: number): EditorLine {
  return {
    id: `${idx}-${Date.now()}`,
    startTime: cue.startTime ?? null,
    endTime: cue.endTime ?? null,
    chord: cue.chord ?? "",
    text: cue.text,
    sectionLabel: cue.sectionLabel ?? "",
    isSection: cue.isSection ?? false,
  };
}

function lineToRaw(lines: EditorLine[]): string {
  return serialiseLyricCues(
    lines.map((l) => ({
      startTime: l.startTime ?? 0,
      endTime: l.endTime ?? undefined,
      chord: l.chord || undefined,
      text: l.text,
      sectionLabel: l.sectionLabel || undefined,
      isSection: l.isSection,
    }))
  );
}

export default function LyricCueEditor() {
  const { id } = useParams<{ id: string }>();
  const songId = parseInt(id ?? "0");
  const [, navigate] = useLocation();

  const { data: song } = trpc.songs.byId.useQuery({ id: songId }, { enabled: !!songId });
  const { data: stems } = trpc.stems.bySong.useQuery({ songId }, { enabled: !!songId });
  const updateCuesMutation = trpc.songs.updateLyricCues.useMutation({
    onSuccess: () => toast.success("Lyric cues saved"),
    onError: () => toast.error("Failed to save cues"),
  });

  // ── Editor lines state ─────────────────────────────────────────────────────
  const [lines, setLines] = useState<EditorLine[]>([]);
  const [pasteMode, setPasteMode] = useState(false);
  const [pasteText, setPasteText] = useState("");
  const [activeLine, setActiveLine] = useState(0);
  const [showPreview, setShowPreview] = useState(false);
  const [editingTs, setEditingTs] = useState<{ id: string; field: "start" | "end"; value: string } | null>(null);

  // ── Audio playback — ALL stems mixed together ───────────────────────────────
  // Playing only stem 1 made it impossible to know where you were in the song.
  // We now create one Audio element per stem file, keep them in sync, and use
  // stem 1 as the time reference.  IEM/click stems are muted so you hear the
  // full FOH mix while tapping cues.
  const stemAudiosRef = useRef<HTMLAudioElement[]>([]);
  const audioRef = useRef<HTMLAudioElement | null>(null); // primary (time ref)
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const animFrameRef = useRef<number>(0);
  const stemUrl = stems?.find((s) => s.fileUrl)?.fileUrl ?? null; // kept for "no audio" guard

  useEffect(() => {
    // Tear down previous players
    stemAudiosRef.current.forEach((a) => { a.pause(); a.src = ""; });
    stemAudiosRef.current = [];
    audioRef.current = null;

    const stemFiles = (stems ?? []).filter((s) => s.fileUrl);
    if (stemFiles.length === 0) return;

    const players = stemFiles.map((st, i) => {
      const a = new Audio(st.fileUrl!);
      // Mute IEM/click tracks — we want the FOH mix for monitoring
      const isIem = /click|guide|iem/i.test(st.name ?? "");
      a.muted = isIem;
      a.volume = 1;
      if (i === 0) {
        a.addEventListener("loadedmetadata", () => setDuration(a.duration));
        a.addEventListener("ended", () => {
          setIsPlaying(false);
          cancelAnimationFrame(animFrameRef.current);
        });
      }
      return a;
    });

    stemAudiosRef.current = players;
    audioRef.current = players[0] ?? null;

    return () => {
      players.forEach((a) => { a.pause(); a.src = ""; });
      stemAudiosRef.current = [];
      audioRef.current = null;
    };
  }, [stems]);

  const tick = useCallback(() => {
    const primary = audioRef.current;
    if (primary) {
      // Resync all other stems to the primary every ~500ms to prevent drift
      const t = primary.currentTime;
      setCurrentTime(t);
      stemAudiosRef.current.forEach((a, i) => {
        if (i === 0) return;
        if (Math.abs(a.currentTime - t) > 0.15) a.currentTime = t;
      });
    }
    animFrameRef.current = requestAnimationFrame(tick);
  }, []);

  const handlePlay = () => {
    const players = stemAudiosRef.current;
    if (players.length === 0) return;
    const t = players[0].currentTime;
    // Start all stems at the same time
    players.forEach((a, i) => {
      if (i !== 0) a.currentTime = t;
    });
    Promise.all(players.map((a) => a.play())).then(() => {
      setIsPlaying(true);
      animFrameRef.current = requestAnimationFrame(tick);
    }).catch(() => {
      // Partial success is ok — at least the primary will play
      setIsPlaying(true);
      animFrameRef.current = requestAnimationFrame(tick);
    });
  };
  const handlePause = () => {
    stemAudiosRef.current.forEach((a) => a.pause());
    setIsPlaying(false);
    cancelAnimationFrame(animFrameRef.current);
  };
  const handleStop = () => {
    stemAudiosRef.current.forEach((a) => { a.pause(); a.currentTime = 0; });
    setIsPlaying(false);
    setCurrentTime(0);
    cancelAnimationFrame(animFrameRef.current);
  };

  // ── Load existing cues ─────────────────────────────────────────────────────
  useEffect(() => {
    if (!song) return;
    const raw = song.lyricCues ?? song.lyrics ?? "";
    if (raw.trim()) {
      const parsed = parseLyricCues(raw);
      setLines(parsed.map(cueToLine));
    }
  }, [song]);

  // ── Paste import ───────────────────────────────────────────────────────────
  const handleImportPaste = () => {
    const rawLines = pasteText.split("\n").map((l) => l.trim()).filter(Boolean);
    const newLines: EditorLine[] = rawLines.map((l, i) => {
      // Detect section markers like [Verse 1], [Chorus]
      const sectionMatch = l.match(/^\[([^\]]+)\]$/);
      if (sectionMatch) {
        return {
          id: `${i}-${Date.now()}`,
          startTime: null, endTime: null,
          chord: "", text: "",
          sectionLabel: sectionMatch[1],
          isSection: true,
        };
      }
      // Detect chord prefix like [Am] or [Dm/F]
      const chordMatch = l.match(/^\[([A-G][^\]]*)\]\s*(.*)/);
      if (chordMatch) {
        return {
          id: `${i}-${Date.now()}`,
          startTime: null, endTime: null,
          chord: chordMatch[1], text: chordMatch[2],
          sectionLabel: "", isSection: false,
        };
      }
      return {
        id: `${i}-${Date.now()}`,
        startTime: null, endTime: null,
        chord: "", text: l,
        sectionLabel: "", isSection: false,
      };
    });
    setLines(newLines);
    setActiveLine(0);
    setPasteMode(false);
    setPasteText("");
    toast.success(`Imported ${newLines.length} lines`);
  };

  // ── Tap to cue ─────────────────────────────────────────────────────────────
  const handleCueLine = () => {
    if (activeLine >= lines.length) return;
    const t = audioRef.current?.currentTime ?? currentTime;
    setLines((prev) => {
      const updated = [...prev];
      updated[activeLine] = { ...updated[activeLine], startTime: t };
      return updated;
    });
    if (activeLine < lines.length - 1) {
      setActiveLine((i) => i + 1);
    }
  };

  // ── Nudge ──────────────────────────────────────────────────────────────────
  const nudge = (lineId: string, field: "start" | "end", delta: number) => {
    setLines((prev) =>
      prev.map((l) => {
        if (l.id !== lineId) return l;
        if (field === "start") {
          return { ...l, startTime: Math.max(0, (l.startTime ?? 0) + delta) };
        } else {
          return { ...l, endTime: l.endTime !== null ? Math.max(0, l.endTime + delta) : null };
        }
      })
    );
  };

  // ── Add / delete lines ─────────────────────────────────────────────────────
  const addLine = (afterIdx: number) => {
    const newLine: EditorLine = {
      id: `new-${Date.now()}`,
      startTime: null, endTime: null,
      chord: "", text: "",
      sectionLabel: "", isSection: false,
    };
    setLines((prev) => {
      const next = [...prev];
      next.splice(afterIdx + 1, 0, newLine);
      return next;
    });
    setActiveLine(afterIdx + 1);
  };

  const deleteLine = (lineId: string) => {
    setLines((prev) => prev.filter((l) => l.id !== lineId));
  };

  // ── Save ───────────────────────────────────────────────────────────────────
  const handleSave = () => {
    const raw = lineToRaw(lines);
    updateCuesMutation.mutate({ id: songId, lyricCues: raw });
  };

  // ── Keyboard shortcut: Space = cue line ───────────────────────────────────
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (e.code === "Space") { e.preventDefault(); handleCueLine(); }
      if (e.code === "ArrowDown") { e.preventDefault(); setActiveLine((i) => Math.min(i + 1, lines.length - 1)); }
      if (e.code === "ArrowUp") { e.preventDefault(); setActiveLine((i) => Math.max(i - 1, 0)); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [activeLine, lines.length, currentTime]);

  const progress = duration > 0 ? (currentTime / duration) * 100 : 0;

  return (
    <div className="flex flex-col h-full" style={{ background: "var(--md-black)", color: "var(--md-text)" }}>
      {/* ── Header ── */}
      <div
        className="flex items-center justify-between px-6 py-3 border-b shrink-0"
        style={{ background: "var(--md-surface)", borderColor: "var(--md-border)" }}
      >
        <div className="flex items-center gap-4">
          <button
            onClick={() => navigate(`/songs/${songId}`)}
            className="flex items-center gap-2 text-xs opacity-60 hover:opacity-100 transition-opacity"
            style={{ color: "var(--md-text-dim)" }}
          >
            <ArrowLeft size={14} /> Back to Song
          </button>
          <div className="flex items-center gap-2">
            <Mic2 size={14} style={{ color: "var(--md-magenta)" }} />
            <span className="text-xs font-bold tracking-widest uppercase" style={{ color: "var(--md-text-dim)" }}>
              Lyric Cue Editor
            </span>
            {song && (
              <span className="text-xs" style={{ color: "var(--md-text-muted)" }}>— {song.title}</span>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setShowPreview(!showPreview)}
            className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded transition-colors"
            style={{
              background: showPreview ? "rgba(0,180,255,0.15)" : "var(--md-surface-2)",
              color: showPreview ? "var(--md-blue)" : "var(--md-text-dim)",
              border: `1px solid ${showPreview ? "rgba(0,180,255,0.3)" : "var(--md-border)"}`,
            }}
          >
            {showPreview ? <EyeOff size={12} /> : <Eye size={12} />}
            Preview
          </button>
          <button
            onClick={() => setPasteMode(true)}
            className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded transition-colors"
            style={{ background: "var(--md-surface-2)", color: "var(--md-text-dim)", border: "1px solid var(--md-border)" }}
          >
            <Plus size={12} /> Import Lyrics
          </button>
          <button
            onClick={handleSave}
            disabled={updateCuesMutation.isPending}
            className="flex items-center gap-1.5 text-xs px-4 py-1.5 rounded font-bold transition-all active:scale-95"
            style={{
              background: "linear-gradient(135deg, var(--md-blue), #0077cc)",
              color: "var(--md-black)",
            }}
          >
            <Save size={12} /> Save Cues
          </button>
        </div>
      </div>

      {/* ── Paste Import Modal ── */}
      {pasteMode && (
        <div className="fixed inset-0 z-50 flex items-center justify-center" style={{ background: "rgba(0,0,0,0.8)" }}>
          <div
            className="w-full max-w-2xl rounded-lg p-6"
            style={{ background: "var(--md-surface-2)", border: "1px solid var(--md-border)" }}
          >
            <h2 className="text-sm font-bold tracking-widest uppercase mb-3" style={{ color: "var(--md-text-dim)" }}>
              Import Lyrics
            </h2>
            <p className="text-xs mb-3" style={{ color: "var(--md-text-muted)" }}>
              Paste your lyrics below. Use <code style={{ color: "var(--md-blue)" }}>[Verse 1]</code> for sections and{" "}
              <code style={{ color: "var(--md-blue)" }}>[Am]</code> for chords. Each line becomes a cue.
            </p>
            <textarea
              autoFocus
              value={pasteText}
              onChange={(e) => setPasteText(e.target.value)}
              rows={14}
              className="w-full rounded p-3 text-sm font-mono resize-none"
              style={{
                background: "var(--md-black)",
                border: "1px solid var(--md-border)",
                color: "var(--md-text)",
                outline: "none",
              }}
              placeholder={"[Verse 1]\n[Dm] Driving through the midnight rain\n[Bb] City lights are calling again\n\n[Chorus]\n[F] I see your face in the rear view glow\n[C] Neon in the windows as we go"}
            />
            <div className="flex justify-end gap-2 mt-4">
              <button
                onClick={() => setPasteMode(false)}
                className="text-xs px-4 py-2 rounded"
                style={{ background: "var(--md-surface-3)", color: "var(--md-text-dim)" }}
              >
                Cancel
              </button>
              <button
                onClick={handleImportPaste}
                disabled={!pasteText.trim()}
                className="text-xs px-4 py-2 rounded font-bold"
                style={{ background: "var(--md-blue)", color: "var(--md-black)" }}
              >
                Import {pasteText.split("\n").filter(Boolean).length} lines
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Main area ── */}
      <div className="flex flex-1 overflow-hidden">
        {/* ── Left: Cue list ── */}
        <div className="flex-1 flex flex-col overflow-hidden">
          {/* Transport bar */}
          <div
            className="flex items-center gap-3 px-4 py-2 border-b shrink-0"
            style={{ background: "var(--md-surface)", borderColor: "var(--md-border)" }}
          >
            {/* Transport */}
            <div className="flex items-center gap-2">
              {isPlaying ? (
                <button onClick={handlePause} className="w-8 h-8 rounded flex items-center justify-center transition-all active:scale-95"
                  style={{ background: "rgba(0,180,255,0.15)", color: "var(--md-blue)", border: "1px solid rgba(0,180,255,0.3)" }}>
                  <Pause size={14} />
                </button>
              ) : (
                <button onClick={handlePlay} disabled={!stemUrl} className="w-8 h-8 rounded flex items-center justify-center transition-all active:scale-95"
                  style={{ background: stemUrl ? "rgba(0,180,255,0.15)" : "var(--md-surface-2)", color: stemUrl ? "var(--md-blue)" : "var(--md-text-muted)", border: "1px solid var(--md-border)" }}>
                  <Play size={14} />
                </button>
              )}
              <button onClick={handleStop} className="w-8 h-8 rounded flex items-center justify-center transition-all active:scale-95"
                style={{ background: "var(--md-surface-2)", color: "var(--md-text-dim)", border: "1px solid var(--md-border)" }}>
                <Square size={12} />
              </button>
            </div>

            {/* Progress */}
            <div className="flex-1 flex items-center gap-2">
              <span className="text-xs tabular-nums w-10" style={{ color: "var(--md-blue)" }}>
                {formatTs(currentTime)}
              </span>
              <div
                className="flex-1 h-1.5 rounded-full cursor-pointer overflow-hidden"
                style={{ background: "var(--md-surface-3)" }}
                onClick={(e) => {
                  if (!audioRef.current || !duration) return;
                  const rect = e.currentTarget.getBoundingClientRect();
                  const ratio = (e.clientX - rect.left) / rect.width;
                  stemAudiosRef.current.forEach((a) => { a.currentTime = ratio * duration; });
                  setCurrentTime(ratio * duration);
                }}
              >
                <div className="h-full rounded-full" style={{ width: `${progress}%`, background: "var(--md-blue)", transition: "width 0.1s linear" }} />
              </div>
              <span className="text-xs tabular-nums w-10 text-right" style={{ color: "var(--md-text-muted)" }}>
                {formatTs(duration)}
              </span>
            </div>

            {/* Cue button */}
            <button
              onClick={handleCueLine}
              className="flex items-center gap-2 px-5 py-2 rounded font-bold text-sm tracking-widest uppercase transition-all active:scale-95"
              style={{
                background: "linear-gradient(135deg, var(--md-magenta), #cc0066)",
                color: "#fff",
                boxShadow: "0 0 20px rgba(255,45,120,0.4)",
              }}
            >
              <Clock size={14} /> CUE LINE
            </button>
            <span className="text-xs" style={{ color: "var(--md-text-muted)" }}>or press Space</span>

            {/* Skip active line */}
            <button
              onClick={() => setActiveLine((i) => Math.min(i + 1, lines.length - 1))}
              className="w-8 h-8 rounded flex items-center justify-center"
              style={{ background: "var(--md-surface-2)", color: "var(--md-text-dim)", border: "1px solid var(--md-border)" }}
              title="Skip to next line"
            >
              <SkipForward size={12} />
            </button>
          </div>

          {/* No stems notice */}
          {!stemUrl && (
            <div className="px-4 py-2 text-xs" style={{ background: "rgba(255,204,0,0.06)", color: "var(--md-yellow)", borderBottom: "1px solid rgba(255,204,0,0.15)" }}>
              No audio stem uploaded for this song — playback unavailable. You can still tap cues manually.
            </div>
          )}

          {/* Cue lines list */}
          <div className="flex-1 overflow-y-auto px-4 py-3 space-y-1">
            {lines.length === 0 && (
              <div className="flex flex-col items-center justify-center h-full text-center py-16">
                <Mic2 size={40} className="mb-4 opacity-10" />
                <p className="text-sm mb-1" style={{ color: "var(--md-text-dim)" }}>No lyrics yet</p>
                <p className="text-xs mb-4" style={{ color: "var(--md-text-muted)" }}>Import lyrics to get started</p>
                <button
                  onClick={() => setPasteMode(true)}
                  className="text-xs px-4 py-2 rounded font-bold"
                  style={{ background: "var(--md-blue)", color: "var(--md-black)" }}
                >
                  Import Lyrics
                </button>
              </div>
            )}

            {lines.map((line, idx) => {
              const isActive = idx === activeLine;
              const isCued = line.startTime !== null;

              if (line.isSection) {
                return (
                  <div
                    key={line.id}
                    className="flex items-center gap-2 py-1 cursor-pointer"
                    onClick={() => setActiveLine(idx)}
                  >
                    <div className="flex-1 h-px" style={{ background: "var(--md-border)" }} />
                    <span
                      className="text-xs px-2 py-0.5 rounded font-bold tracking-widest uppercase"
                      style={{
                        background: "rgba(255,45,120,0.1)",
                        color: "var(--md-magenta)",
                        border: "1px solid rgba(255,45,120,0.2)",
                      }}
                    >
                      {line.sectionLabel}
                    </span>
                    <div className="flex-1 h-px" style={{ background: "var(--md-border)" }} />
                    <button onClick={(e) => { e.stopPropagation(); deleteLine(line.id); }} className="opacity-30 hover:opacity-80">
                      <Trash2 size={10} style={{ color: "var(--md-red)" }} />
                    </button>
                  </div>
                );
              }

              return (
                <div
                  key={line.id}
                  className="flex items-start gap-2 rounded px-2 py-1.5 cursor-pointer transition-all"
                  style={{
                    background: isActive
                      ? "rgba(255,45,120,0.12)"
                      : isCued
                      ? "rgba(0,180,255,0.04)"
                      : "transparent",
                    border: `1px solid ${isActive ? "rgba(255,45,120,0.3)" : "transparent"}`,
                  }}
                  onClick={() => setActiveLine(idx)}
                >
                  {/* Line number */}
                  <span className="text-xs w-5 shrink-0 pt-0.5 tabular-nums text-right" style={{ color: "var(--md-text-muted)" }}>
                    {idx + 1}
                  </span>

                  {/* Timestamp controls */}
                  <div className="flex flex-col gap-0.5 shrink-0 w-28">
                    {/* Start time */}
                    <div className="flex items-center gap-1">
                      {editingTs?.id === line.id && editingTs.field === "start" ? (
                        <input
                          autoFocus
                          className="text-xs w-16 px-1 rounded tabular-nums"
                          style={{ background: "var(--md-surface-3)", color: "var(--md-blue)", border: "1px solid var(--md-blue)", outline: "none" }}
                          value={editingTs.value}
                          onChange={(e) => setEditingTs({ ...editingTs, value: e.target.value })}
                          onBlur={() => {
                            const t = parseTs(editingTs.value);
                            if (t !== null) setLines((prev) => prev.map((l) => l.id === line.id ? { ...l, startTime: t } : l));
                            setEditingTs(null);
                          }}
                          onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); if (e.key === "Escape") setEditingTs(null); }}
                        />
                      ) : (
                        <button
                          className="text-xs w-16 text-left tabular-nums px-1 rounded"
                          style={{ color: isCued ? "var(--md-blue)" : "var(--md-text-muted)", background: "var(--md-surface-3)" }}
                          onClick={(e) => { e.stopPropagation(); setEditingTs({ id: line.id, field: "start", value: line.startTime !== null ? formatTs(line.startTime) : "00:00.0" }); }}
                        >
                          {line.startTime !== null ? formatTs(line.startTime) : "—:——.—"}
                        </button>
                      )}
                      <button onClick={(e) => { e.stopPropagation(); nudge(line.id, "start", -0.1); }} className="text-xs opacity-50 hover:opacity-100" title="-0.1s"><ChevronDown size={10} /></button>
                      <button onClick={(e) => { e.stopPropagation(); nudge(line.id, "start", 0.1); }} className="text-xs opacity-50 hover:opacity-100" title="+0.1s"><ChevronUp size={10} /></button>
                    </div>
                  </div>

                  {/* Chord */}
                  <input
                    className="text-xs w-14 shrink-0 px-1.5 py-0.5 rounded tabular-nums font-bold"
                    style={{
                      background: "var(--md-surface-3)",
                      border: "1px solid var(--md-border)",
                      color: "var(--md-magenta)",
                      outline: "none",
                    }}
                    value={line.chord}
                    placeholder="Chord"
                    onChange={(e) => setLines((prev) => prev.map((l) => l.id === line.id ? { ...l, chord: e.target.value } : l))}
                    onClick={(e) => e.stopPropagation()}
                  />

                  {/* Lyric text */}
                  <input
                    className="flex-1 text-sm px-2 py-0.5 rounded"
                    style={{
                      background: "transparent",
                      border: "1px solid transparent",
                      color: isActive ? "var(--md-text)" : "var(--md-text-dim)",
                      outline: "none",
                      fontWeight: isActive ? 600 : 400,
                    }}
                    value={line.text}
                    onChange={(e) => setLines((prev) => prev.map((l) => l.id === line.id ? { ...l, text: e.target.value } : l))}
                    onClick={(e) => e.stopPropagation()}
                    onFocus={() => setActiveLine(idx)}
                  />

                  {/* Actions */}
                  <div className="flex items-center gap-1 shrink-0">
                    <button
                      onClick={(e) => { e.stopPropagation(); addLine(idx); }}
                      className="opacity-30 hover:opacity-80 transition-opacity"
                      title="Add line below"
                    >
                      <Plus size={10} style={{ color: "var(--md-blue)" }} />
                    </button>
                    <button
                      onClick={(e) => { e.stopPropagation(); deleteLine(line.id); }}
                      className="opacity-30 hover:opacity-80 transition-opacity"
                      title="Delete line"
                    >
                      <Trash2 size={10} style={{ color: "var(--md-red)" }} />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* ── Right: Lyrics Preview ── */}
        {showPreview && (
          <div
            className="w-80 shrink-0 border-l flex flex-col"
            style={{ background: "#050508", borderColor: "var(--md-border)" }}
          >
            <div className="px-4 py-2 border-b" style={{ borderColor: "var(--md-border)" }}>
              <span className="text-xs font-bold tracking-widest uppercase" style={{ color: "var(--md-text-dim)" }}>
                Lyrics Preview
              </span>
            </div>
            <KaraokePreview lines={lines} currentTime={currentTime} songTitle={song?.title ?? ""} />
          </div>
        )}
      </div>
    </div>
  );
}

// ── Inline Lyrics Preview ──────────────────────────────────────────────────────
function KaraokePreview({ lines, currentTime, songTitle }: {
  lines: EditorLine[];
  currentTime: number;
  songTitle: string;
}) {
  // Find active line index
  let activeIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].isSection && lines[i].startTime !== null && lines[i].startTime! <= currentTime) {
      activeIdx = i;
    } else if (!lines[i].isSection && lines[i].startTime !== null && lines[i].startTime! > currentTime) {
      break;
    }
  }

  const prevLine = activeIdx > 0 ? lines[activeIdx - 1] : null;
  const currLine = activeIdx >= 0 ? lines[activeIdx] : null;
  const nextLine = activeIdx < lines.length - 1 ? lines[activeIdx + 1] : null;

  // Find current section
  let currentSection = "";
  for (let i = 0; i <= activeIdx; i++) {
    if (lines[i]?.isSection) currentSection = lines[i].sectionLabel;
    else if (lines[i]?.sectionLabel) currentSection = lines[i].sectionLabel;
  }

  // Karaoke fill
  const fill = currLine && currLine.endTime !== null && currLine.startTime !== null
    ? Math.min(1, Math.max(0, (currentTime - currLine.startTime) / (currLine.endTime - currLine.startTime)))
    : 0;

  return (
    <div className="flex-1 flex flex-col items-center justify-center p-6 text-center gap-4">
      <div className="text-xs tracking-widest uppercase" style={{ color: "var(--md-magenta)", opacity: 0.7 }}>
        {songTitle}
      </div>
      {currentSection && (
        <div className="text-xs tracking-widest uppercase px-2 py-0.5 rounded"
          style={{ background: "rgba(255,45,120,0.1)", color: "var(--md-magenta)", border: "1px solid rgba(255,45,120,0.2)" }}>
          {currentSection}
        </div>
      )}
      {currLine?.chord && (
        <div className="text-2xl font-bold" style={{ color: "var(--md-blue)", fontFamily: "monospace" }}>
          {currLine.chord}
        </div>
      )}
      {/* Prev */}
      {prevLine && !prevLine.isSection && (
        <div className="text-sm" style={{ color: "var(--md-text-muted)", opacity: 0.5 }}>
          {prevLine.text || "\u00A0"}
        </div>
      )}
      {/* Current */}
      <div className="relative text-lg font-bold leading-snug" style={{ color: "var(--md-text)", minHeight: "2rem" }}>
        {currLine && !currLine.isSection ? (
          <>
            <span style={{ position: "relative", zIndex: 1 }}>{currLine.text || "\u00A0"}</span>
            {fill > 0 && (
              <span
                className="absolute inset-0 overflow-hidden"
                style={{ width: `${fill * 100}%`, color: "var(--md-blue)", whiteSpace: "nowrap" }}
              >
                {currLine.text}
              </span>
            )}
          </>
        ) : (
          <span style={{ color: "var(--md-text-muted)", opacity: 0.3 }}>Waiting…</span>
        )}
      </div>
      {/* Next */}
      {nextLine && !nextLine.isSection && (
        <div className="text-sm" style={{ color: "var(--md-text-dim)", opacity: 0.5 }}>
          {nextLine.text || "\u00A0"}
        </div>
      )}
    </div>
  );
}
