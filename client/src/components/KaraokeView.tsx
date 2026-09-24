import { useEffect, useRef } from "react";
import type { LyricCueSummary } from "@shared/socketTypes";
import { getActiveCueIndex, getKaraokeFill } from "@shared/lyricParser";

interface KaraokeViewProps {
  cues: LyricCueSummary[];
  currentTime: number;
  duration: number | null;
  songTitle: string;
  artist?: string;
  bpm?: number | null;
  songKey?: string | null;
  nextSongTitle?: string;
  nextSongBpm?: number | null;
  nextSongKey?: string | null;
  isPlaying?: boolean;
}

function formatTime(s: number): string {
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2, "0")}`;
}

export function KaraokeView({
  cues,
  currentTime,
  duration,
  songTitle,
  artist,
  bpm,
  songKey,
  nextSongTitle,
  nextSongBpm,
  nextSongKey,
  isPlaying,
}: KaraokeViewProps) {
  const activeCueIndex = getActiveCueIndex(cues, currentTime);

  // Walk backwards to find the nearest non-section cue
  const activeCue = activeCueIndex >= 0 ? cues[activeCueIndex] : null;

  // Previous visible (non-section) cue
  let prevCue: LyricCueSummary | null = null;
  for (let i = activeCueIndex - 1; i >= 0; i--) {
    if (!cues[i].isSection) { prevCue = cues[i]; break; }
  }

  // Next visible (non-section) cue
  let nextCue: LyricCueSummary | null = null;
  let nextChord: string | undefined;
  let nextSection: string | undefined;
  for (let i = activeCueIndex + 1; i < cues.length; i++) {
    if (cues[i].isSection) {
      if (!nextSection) nextSection = cues[i].sectionLabel;
    } else {
      if (!nextCue) {
        nextCue = cues[i];
        nextChord = cues[i].chord;
      }
    }
  }

  // Current section label — walk back from active to find nearest section marker
  let currentSection = "";
  for (let i = activeCueIndex; i >= 0; i--) {
    if (cues[i].isSection && cues[i].sectionLabel) { currentSection = cues[i].sectionLabel!; break; }
    if (cues[i].sectionLabel) { currentSection = cues[i].sectionLabel!; break; }
  }

  // Karaoke fill for current line
  const fill = activeCue ? getKaraokeFill(activeCue, currentTime) : 0;

  // Progress
  const progress = duration && duration > 0 ? Math.min(1, currentTime / duration) : 0;
  const elapsed = formatTime(currentTime);
  const remaining = duration ? formatTime(Math.max(0, duration - currentTime)) : "--:--";

  // Pulse animation ref for current line
  const currentLineRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (currentLineRef.current) {
      currentLineRef.current.classList.remove("karaoke-line-enter");
      void currentLineRef.current.offsetWidth; // reflow
      currentLineRef.current.classList.add("karaoke-line-enter");
    }
  }, [activeCueIndex]);

  const hasCues = cues.filter((c) => !c.isSection).length > 0;

  return (
    <div
      className="flex flex-col h-full select-none"
      style={{ background: "var(--md-black)", color: "var(--md-text)" }}
    >
      {/* ── Song header ── */}
      <div
        className="flex items-center justify-between px-6 py-3 shrink-0"
        style={{ borderBottom: "1px solid var(--md-border)" }}
      >
        <div className="flex flex-col gap-0.5">
          <span
            className="text-base font-bold tracking-wide"
            style={{ color: "var(--md-text)", fontFamily: "var(--md-font-mono)" }}
          >
            {songTitle || "No song loaded"}
          </span>
          {artist && (
            <span className="text-xs" style={{ color: "var(--md-text-muted)" }}>
              {artist}
            </span>
          )}
        </div>
        <div className="flex items-center gap-3">
          {bpm && (
            <div className="flex flex-col items-center">
              <span className="text-lg font-bold tabular-nums" style={{ color: "var(--md-blue)", fontFamily: "var(--md-font-mono)" }}>
                {bpm}
              </span>
              <span className="text-xs tracking-widest uppercase" style={{ color: "var(--md-text-muted)" }}>BPM</span>
            </div>
          )}
          {songKey && (
            <div
              className="flex items-center justify-center w-12 h-12 rounded-lg font-bold text-lg"
              style={{
                background: "rgba(255,45,120,0.1)",
                border: "1px solid rgba(255,45,120,0.3)",
                color: "var(--md-magenta)",
                fontFamily: "var(--md-font-mono)",
              }}
            >
              {songKey}
            </div>
          )}
        </div>
      </div>

      {/* ── Section label ── */}
      {currentSection && (
        <div
          className="px-6 py-1.5 shrink-0"
          style={{ borderBottom: "1px solid var(--md-border)", background: "rgba(255,45,120,0.04)" }}
        >
          <span
            className="text-xs font-bold tracking-widest uppercase px-2 py-0.5 rounded"
            style={{
              background: "rgba(255,45,120,0.12)",
              color: "var(--md-magenta)",
              border: "1px solid rgba(255,45,120,0.25)",
            }}
          >
            {currentSection}
          </span>
        </div>
      )}

      {/* ── Lyric stage ── */}
      <div className="flex-1 flex flex-col items-center justify-center px-8 gap-6 overflow-hidden">
        {!hasCues ? (
          <div className="text-center">
            <p className="text-sm" style={{ color: "var(--md-text-muted)" }}>No lyric cues loaded</p>
            <p className="text-xs mt-1" style={{ color: "var(--md-text-muted)", opacity: 0.5 }}>
              Use the Lyric Cue Editor to add timed lyrics
            </p>
          </div>
        ) : (
          <>
            {/* Previous line */}
            <div
              className="text-center transition-all duration-300"
              style={{
                color: "var(--md-text-muted)",
                opacity: prevCue ? 0.35 : 0,
                fontSize: "clamp(0.9rem, 2vw, 1.1rem)",
                fontFamily: "var(--md-font-mono)",
                maxWidth: "80%",
                lineHeight: 1.4,
              }}
            >
              {prevCue?.text || "\u00A0"}
            </div>

            {/* Current line — karaoke fill */}
            <div
              ref={currentLineRef}
              className="relative text-center karaoke-line-enter"
              style={{
                fontSize: "clamp(1.5rem, 4vw, 2.5rem)",
                fontFamily: "var(--md-font-mono)",
                fontWeight: 700,
                lineHeight: 1.25,
                maxWidth: "90%",
                minHeight: "3rem",
              }}
            >
              {activeCue && !activeCue.isSection ? (
                <>
                  {/* Base text (dim) */}
                  <span style={{ color: "rgba(255,255,255,0.25)", position: "relative", zIndex: 0 }}>
                    {activeCue.text || "\u00A0"}
                  </span>
                  {/* Fill overlay */}
                  {fill > 0 ? (
                    <span
                      className="absolute inset-0 overflow-hidden"
                      style={{
                        width: `${fill * 100}%`,
                        color: "var(--md-blue)",
                        whiteSpace: "nowrap",
                        textShadow: "0 0 20px rgba(0,180,255,0.6)",
                        zIndex: 1,
                      }}
                    >
                      {activeCue.text}
                    </span>
                  ) : (
                    <span
                      className="absolute inset-0"
                      style={{
                        color: "#ffffff",
                        textShadow: "0 0 30px rgba(255,255,255,0.3)",
                        zIndex: 1,
                      }}
                    >
                      {activeCue.text || "\u00A0"}
                    </span>
                  )}
                </>
              ) : (
                <span style={{ color: "var(--md-text-muted)", opacity: 0.3 }}>
                  {isPlaying ? "♩ ♩ ♩" : "Waiting…"}
                </span>
              )}
            </div>

            {/* Chord badge for current line */}
            {activeCue?.chord && (
              <div
                className="text-2xl font-bold tabular-nums"
                style={{
                  color: "var(--md-magenta)",
                  fontFamily: "var(--md-font-mono)",
                  textShadow: "0 0 20px rgba(255,45,120,0.5)",
                  marginTop: "-1rem",
                }}
              >
                {activeCue.chord}
              </div>
            )}

            {/* Next line */}
            <div
              className="text-center transition-all duration-300"
              style={{
                color: "var(--md-text-dim)",
                opacity: nextCue ? 0.45 : 0,
                fontSize: "clamp(0.9rem, 2vw, 1.1rem)",
                fontFamily: "var(--md-font-mono)",
                maxWidth: "80%",
                lineHeight: 1.4,
              }}
            >
              {nextCue?.text || "\u00A0"}
            </div>

            {/* Next chord + section preview */}
            <div className="flex items-center gap-4 mt-2">
              {nextChord && (
                <div
                  className="text-sm font-bold px-3 py-1 rounded"
                  style={{
                    background: "rgba(0,180,255,0.08)",
                    color: "var(--md-blue)",
                    border: "1px solid rgba(0,180,255,0.2)",
                    fontFamily: "var(--md-font-mono)",
                  }}
                >
                  Next: {nextChord}
                </div>
              )}
              {nextSection && (
                <div
                  className="text-xs font-bold px-2 py-0.5 rounded tracking-widest uppercase"
                  style={{
                    background: "rgba(255,45,120,0.06)",
                    color: "rgba(255,45,120,0.6)",
                    border: "1px solid rgba(255,45,120,0.15)",
                  }}
                >
                  ↓ {nextSection}
                </div>
              )}
            </div>
          </>
        )}
      </div>

      {/* ── Progress bar ── */}
      <div
        className="px-6 py-3 shrink-0"
        style={{ borderTop: "1px solid var(--md-border)" }}
      >
        <div className="flex items-center gap-3 mb-2">
          <span className="text-xs tabular-nums w-10" style={{ color: "var(--md-blue)", fontFamily: "var(--md-font-mono)" }}>
            {elapsed}
          </span>
          <div
            className="flex-1 h-1.5 rounded-full overflow-hidden"
            style={{ background: "var(--md-surface-3)" }}
          >
            <div
              className="h-full rounded-full transition-all"
              style={{
                width: `${progress * 100}%`,
                background: isPlaying
                  ? "linear-gradient(90deg, var(--md-blue), var(--md-magenta))"
                  : "var(--md-blue)",
                transition: "width 0.25s linear",
              }}
            />
          </div>
          <span className="text-xs tabular-nums w-10 text-right" style={{ color: "var(--md-text-muted)", fontFamily: "var(--md-font-mono)" }}>
            -{remaining}
          </span>
        </div>

        {/* Next song preview */}
        {nextSongTitle && (
          <div
            className="flex items-center justify-between text-xs px-3 py-1.5 rounded"
            style={{ background: "var(--md-surface-2)", border: "1px solid var(--md-border)" }}
          >
            <span style={{ color: "var(--md-text-muted)" }}>NEXT UP</span>
            <span className="font-bold" style={{ color: "var(--md-text-dim)", fontFamily: "var(--md-font-mono)" }}>
              {nextSongTitle}
            </span>
            <div className="flex items-center gap-2">
              {nextSongKey && (
                <span className="font-bold" style={{ color: "var(--md-magenta)" }}>{nextSongKey}</span>
              )}
              {nextSongBpm && (
                <span style={{ color: "var(--md-text-muted)" }}>{nextSongBpm} BPM</span>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
