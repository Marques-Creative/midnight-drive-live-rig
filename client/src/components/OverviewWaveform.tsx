import { useEffect, useRef } from "react";

/**
 * OverviewWaveform — full-track bird's-eye strip.
 *
 * KEY INSIGHT: the engine sends ~50 peaks/second, so a 3-min track has 9000
 * peaks. At 680px canvas that's 0.075px/bar — invisible.  We downsample to
 * one bar per 2px and normalize within the track's own dynamic range so quiet
 * sections (breakdowns, intros) are visually distinct from loud ones (chorus).
 */

function buildDisplay(peaks: number[], canvasW: number) {
  if (!peaks.length || canvasW < 1) return { bars: [], min: 0, max: 1 };
  const targetBars = Math.max(1, Math.floor(canvasW / 2));
  const step = Math.max(1, Math.ceil(peaks.length / targetBars));

  // Downsample: take the max in each window
  const bars: number[] = [];
  for (let i = 0; i < peaks.length; i += step) {
    let m = 0;
    for (let j = i; j < Math.min(i + step, peaks.length); j++)
      m = Math.max(m, peaks[j]);
    bars.push(m);
  }

  // Normalise within the track's own range so quiet ≠ loud is always visible
  const min = Math.min(...bars);
  const max = Math.max(...bars);
  return { bars, min, max };
}

export default function OverviewWaveform({
  peaks, duration, seconds, playing,
  color = "#7B2CF9",
  cueSeconds, loopStart = -1, loopEnd = -1, looping = false,
  hotCues = [], height = 36, onSeek, markers = [], onMarkerClick, onWaveformClick,
}: {
  peaks: number[]; duration: number; seconds: number; playing: boolean;
  color?: string; cueSeconds?: number; loopStart?: number; loopEnd?: number;
  looping?: boolean; hotCues?: number[]; height?: number;
  onSeek?: (t: number) => void;
  markers?: Array<{ id: string; timeSeconds: number; label: string; note?: string; color?: string }>;
  onMarkerClick?: (id: string) => void;
  onWaveformClick?: (timeSeconds: number) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const bgRef        = useRef<HTMLCanvasElement>(null);
  const fgRef        = useRef<HTMLCanvasElement>(null);
  const animRef      = useRef<number>(0);
  const stRef        = useRef({ seconds, playing, lastUpdate: performance.now() });

  useEffect(() => {
    stRef.current = { seconds, playing, lastUpdate: performance.now() };
  }, [seconds, playing]);

  // ── Static layer ─────────────────────────────────────────────────────────
  useEffect(() => {
    const canvas = bgRef.current;
    const cont   = containerRef.current;
    if (!canvas || !cont) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const paint = () => {
      const dpr = window.devicePixelRatio || 1;
      const w   = cont.clientWidth;
      const h   = cont.clientHeight || height;
      if (w < 10) return;

      canvas.width  = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      // Background
      ctx.fillStyle = "#0a0a12";
      ctx.fillRect(0, 0, w, h);

      if (!peaks.length || duration <= 0) return;

      // Build normalised display bars
      const { bars, min, max } = buildDisplay(peaks, w);
      const range = Math.max(0.01, max - min);
      const n     = bars.length;
      const barW  = w / n;

      for (let i = 0; i < n; i++) {
        // Normalised 0→1 within the track's own dynamic range
        const norm = (bars[i] - min) / range;
        // Bar height: at least 2px so silences are visible as a thin line
        const ph   = 2 + norm * (h - 2);
        // Opacity: dim (quiet) to bright (loud)
        const alpha = Math.round(40 + norm * 215);
        ctx.fillStyle = color + alpha.toString(16).padStart(2, "0");
        ctx.fillRect(i * barW, (h - ph) / 2, barW - 0.3, ph);
      }

      // Loop region
      if (looping && loopStart >= 0 && loopEnd > loopStart) {
        const lx = (loopStart / duration) * w;
        const lw = ((loopEnd - loopStart) / duration) * w;
        ctx.fillStyle = "#38d39f22"; ctx.fillRect(lx, 0, lw, h);
        ctx.strokeStyle = "#38d39f88"; ctx.lineWidth = 1;
        ctx.strokeRect(lx, 0, lw, h);
      }

      // Hot cues
      hotCues.forEach((t) => {
        if (t < 0 || duration <= 0) return;
        const x = (t / duration) * w;
        ctx.fillStyle = "#00b4ffcc"; ctx.fillRect(x, 0, 1.5, h);
        ctx.beginPath(); ctx.moveTo(x,0); ctx.lineTo(x+6,0); ctx.lineTo(x,7);
        ctx.fill();
      });

      // CUE
      if (cueSeconds !== undefined && cueSeconds >= 0) {
        ctx.fillStyle = "#ff8c1a";
        ctx.fillRect((cueSeconds / duration) * w, 0, 2, h);
      }
    };

    // Defer one frame so the container has its layout size
    const raf = requestAnimationFrame(paint);
    return () => cancelAnimationFrame(raf);
  }, [peaks, duration, color, cueSeconds, loopStart, loopEnd, looping, hotCues, markers, height]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Playhead needle at 15 fps ─────────────────────────────────────────────
  useEffect(() => {
    const canvas = fgRef.current;
    const cont   = containerRef.current;
    if (!canvas || !cont) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    let last = 0;

    const tick = (now: number) => {
      animRef.current = requestAnimationFrame(tick);
      if (now - last < 66) return;
      last = now;

      const dpr = window.devicePixelRatio || 1;
      const w   = cont.clientWidth;
      const h   = cont.clientHeight || height;
      if (w < 10) return;

      canvas.width  = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      if (duration <= 0) return;

      const st  = stRef.current;
      let pos   = st.seconds;
      if (st.playing) pos += (now - st.lastUpdate) / 1000;
      pos = Math.max(0, Math.min(duration, pos));
      const nx = (pos / duration) * w;

      ctx.fillStyle = "rgba(255,255,255,0.07)";
      ctx.fillRect(0, 0, nx, h);
      ctx.strokeStyle = "#ffffffdd"; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(nx, 0); ctx.lineTo(nx, h); ctx.stroke();

      const rem = Math.max(0, duration - pos);
      ctx.fillStyle = "rgba(255,255,255,0.65)";
      ctx.font = `${Math.max(9, h * 0.38)}px monospace`;
      ctx.fillText(`-${Math.floor(rem/60)}:${String(Math.floor(rem%60)).padStart(2,"0")}`, 4, h - 3);
    };

    animRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(animRef.current);
  }, [duration, height]);

  return (
    <div ref={containerRef}
      style={{ position:"relative", width:"100%", height, flexShrink:0,
               borderRadius:4, overflow:"hidden", cursor: onSeek?"crosshair":"default" }}
      onClick={(e) => {
        if (duration <= 0) return;
        const r   = e.currentTarget.getBoundingClientRect();
        const t   = ((e.clientX - r.left) / r.width) * duration;
        // Check if click is near a marker (within 6px)
        if (onMarkerClick && markers.length) {
          const px = e.clientX - r.left;
          const hit = markers.find((m) => Math.abs((m.timeSeconds / duration) * r.width - px) < 6);
          if (hit) { onMarkerClick(hit.id); return; }
        }
        if (onWaveformClick) { onWaveformClick(t); return; }
        if (onSeek) onSeek(t);
      }}>
      <canvas ref={bgRef} style={{ position:"absolute", inset:0, width:"100%", height:"100%" }} />
      <canvas ref={fgRef} style={{ position:"absolute", inset:0, width:"100%", height:"100%" }} />
    </div>
  );
}
