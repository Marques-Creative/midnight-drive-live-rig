import { useEffect, useRef } from "react";

/**
 * ZoomWaveform — the scrolling DJ view. The playhead is FIXED at the centre and
 * the waveform slides underneath it, with the engine's detected beatgrid drawn
 * on top: a tick on every beat, a full-height line on every bar (beat 1 of 4),
 * anchored to the auto-detected downbeat. The visible window is measured in
 * BEATS (not seconds), so one bar is always the same width on screen at any
 * tempo — that's what makes two decks visually beat-matchable side by side.
 *
 * Rendering runs on requestAnimationFrame and extrapolates the playhead between
 * the engine's 30 Hz position updates, so the scroll is smooth at display rate.
 */

// Snap t to the nearest beat grid anchored at downbeatSeconds.
function snapToBeat(t: number, bpm: number, downbeatSec: number, duration: number): number {
  if (bpm <= 0) return t;
  const beatSec = 60 / bpm;
  const offset = t - downbeatSec;
  const nearestBeat = Math.round(offset / beatSec) * beatSec + downbeatSec;
  return Math.max(0, Math.min(duration, nearestBeat));
}

export default function ZoomWaveform({
  peaks,
  duration,
  seconds,
  playing,
  bpm,
  downbeatSeconds,
  cueSeconds,
  windowBeats = 16,
  color = "#7B2CF9",
  height = 110,
  onSeek,
  quantise = false,
}: {
  peaks: number[];
  duration: number;
  seconds: number;          // engine playhead (30 Hz)
  playing: boolean;
  bpm: number;
  downbeatSeconds: number;  // beat-1 anchor of the detected grid
  cueSeconds?: number;
  windowBeats?: number;     // how many beats are visible across the strip
  color?: string;
  height?: number;
  onSeek?: (seconds: number) => void;
  quantise?: boolean;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const snapTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Latest props live in a ref so the rAF loop always draws fresh state
  // without re-subscribing every frame.
  const state = useRef({ peaks, duration, seconds, playing, bpm, downbeatSeconds, cueSeconds, windowBeats, color, height, lastUpdate: performance.now() });
  useEffect(() => {
    // A new engine position arrived: re-anchor the extrapolation clock.
    state.current = { peaks, duration, seconds, playing, bpm, downbeatSeconds, cueSeconds, windowBeats, color, height, lastUpdate: performance.now() };
  }, [peaks, duration, seconds, playing, bpm, downbeatSeconds, cueSeconds, windowBeats, color, height]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    let lastFrame = 0;
    let raf = 0;

    const draw = () => {
      raf = requestAnimationFrame(draw);
      const s = state.current;
      const dpr = window.devicePixelRatio || 1;
      const w = canvas.clientWidth;
      const h = s.height;
      if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
        canvas.width = w * dpr;
        canvas.height = h * dpr;
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);

      // ── Position: extrapolate between engine updates while playing ──
      let pos = s.seconds;
      if (s.playing) pos += (performance.now() - s.lastUpdate) / 1000;
      if (s.duration > 0) pos = Math.min(pos, s.duration);

      // Window in seconds, derived from beats (fallback: 8s when no grid).
      const secPerBeat = s.bpm > 0 ? 60 / s.bpm : 0;
      const winSec = secPerBeat > 0 ? s.windowBeats * secPerBeat : 8;
      const t0 = pos - winSec / 2;
      const pxPerSec = w / winSec;
      const mid = h / 2;

      // ── Waveform slice ──
      const n = s.peaks.length;
      if (n > 0 && s.duration > 0) {
        const secPerBucket = s.duration / n;
        const firstB = Math.max(0, Math.floor(t0 / secPerBucket));
        const lastB = Math.min(n - 1, Math.ceil((t0 + winSec) / secPerBucket));
        const bucketPx = Math.max(1, secPerBucket * pxPerSec);
        for (let b = firstB; b <= lastB; b++) {
          const x = (b * secPerBucket - t0) * pxPerSec;
          const amp = Math.max(0.02, s.peaks[b] / 100);
          const barH = amp * (h * 0.88);
          const past = b * secPerBucket <= pos;
          ctx.fillStyle = past ? "#ffffff" : s.color;
          ctx.globalAlpha = past ? 0.85 : 0.5;
          ctx.fillRect(x, mid - barH / 2, Math.max(1, bucketPx - 0.4), barH);
        }
        ctx.globalAlpha = 1;
      } else {
        ctx.strokeStyle = "rgba(255,255,255,0.08)";
        ctx.beginPath(); ctx.moveTo(0, mid); ctx.lineTo(w, mid); ctx.stroke();
      }

      // ── Beat grid: ticks on beats, full lines on bars (4/4) ──
      // Only when a track is loaded — no phantom grid on an empty deck.
      if (secPerBeat > 0 && s.duration > 0) {
        const firstBeat = Math.ceil((t0 - s.downbeatSeconds) / secPerBeat);
        const lastBeat = Math.floor((t0 + winSec - s.downbeatSeconds) / secPerBeat);
        for (let k = firstBeat; k <= lastBeat; k++) {
          const t = s.downbeatSeconds + k * secPerBeat;
          if (t < 0 || (s.duration > 0 && t > s.duration)) continue;
          const x = (t - t0) * pxPerSec;
          const isBar = ((k % 4) + 4) % 4 === 0;
          if (isBar) {
            ctx.strokeStyle = "rgba(255,255,255,0.55)";
            ctx.lineWidth = 1.5;
            ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke();
          } else {
            ctx.strokeStyle = "rgba(255,255,255,0.22)";
            ctx.lineWidth = 1;
            ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, 7); ctx.stroke();
            ctx.beginPath(); ctx.moveTo(x, h - 7); ctx.lineTo(x, h); ctx.stroke();
          }
        }
      }

      // ── Cue marker (orange, DJ convention) ──
      if (s.cueSeconds !== undefined) {
        const x = (s.cueSeconds - t0) * pxPerSec;
        if (x >= -1 && x <= w + 1) {
          ctx.strokeStyle = "#ff8c1a";
          ctx.lineWidth = 2;
          ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke();
          ctx.fillStyle = "#ff8c1a";
          ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x + 8, 0); ctx.lineTo(x, 9); ctx.closePath(); ctx.fill();
        }
      }

      // ── Fixed centre playhead ──
      ctx.strokeStyle = "#ff3b3b";
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(w / 2, 0); ctx.lineTo(w / 2, h); ctx.stroke();
    };

    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, []);

  return (
    <canvas
      ref={canvasRef}
      style={{
        width: "100%",
        height,
        display: "block",
        cursor: onSeek ? "pointer" : "default",
        borderRadius: 6,
        background: "rgba(0,0,0,0.35)",
      }}
      onClick={(e) => {
        if (!onSeek) return;
        const st = state.current;
        const rect = e.currentTarget.getBoundingClientRect();
        const secPerBeat = st.bpm > 0 ? 60 / st.bpm : 0;
        const winSec = secPerBeat > 0 ? st.windowBeats * secPerBeat : 8;
        let pos = st.seconds;
        if (st.playing) pos += (performance.now() - st.lastUpdate) / 1000;
        let t = pos - winSec / 2 + ((e.clientX - rect.left) / rect.width) * winSec;
        t = Math.max(0, Math.min(st.duration, t));
        if (quantise) t = snapToBeat(t, st.bpm, st.downbeatSeconds, st.duration);
        onSeek(t);
      }}
      onWheel={(e) => {
        // Two-finger trackpad scroll seeks through the track.
        // Horizontal scroll (deltaX) = fine scrub; vertical (deltaY) = coarse.
        // Hold shift for fine mode in either direction.
        if (!onSeek) return;
        e.preventDefault();
        const st = state.current;
        if (st.duration <= 0) return;
        let pos = st.seconds;
        if (st.playing) pos += (performance.now() - st.lastUpdate) / 1000;
        // Pixels → seconds: 1px ≈ 0.05s at normal zoom, 0.01s with shift held
        const sensitivity = e.shiftKey ? 0.01 : 0.05;
        const delta = (Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY);
        const newPos = Math.max(0, Math.min(st.duration, pos + delta * sensitivity));
        onSeek(newPos);
        // If quantise is on, snap to nearest beat after scroll stops
        if (quantise) {
          if (snapTimer.current) clearTimeout(snapTimer.current);
          snapTimer.current = setTimeout(() => {
            const snapped = snapToBeat(newPos, st.bpm, st.downbeatSeconds, st.duration);
            if (Math.abs(snapped - newPos) > 0.01) onSeek(snapped);
          }, 300);
        }
      }}
    />
  );
}
