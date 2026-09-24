import { useEffect, useRef } from "react";

/**
 * Waveform — draws a downsampled peak overview (from the engine) on a canvas,
 * with a playhead line and a "played" vs "unplayed" colour split, DJ-style.
 * Click to seek.
 */
export default function Waveform({
  peaks,
  progress,
  cueRatio,
  loop,
  hotCues,
  color = "#7B2CF9",
  playedColor = "#c9a3ff",
  height = 120,
  onSeek,
}: {
  peaks: number[];
  progress: number; // 0..1
  /** Cue point position as 0..1 of the track. Drawn as an orange marker (DJ convention). */
  cueRatio?: number;
  /** Active loop region as 0..1 ratios; shaded green so the hold is obvious. */
  loop?: { start: number; end: number; active: boolean } | null;
  /** Hot cue positions as 0..1 ratios (nulls for empty slots). */
  hotCues?: (number | null)[];
  color?: string;
  playedColor?: string;
  height?: number;
  onSeek?: (ratio: number) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth;
    const h = height;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, w, h);

    const mid = h / 2;
    const n = peaks.length;
    if (n === 0) {
      // idle: flat baseline
      ctx.strokeStyle = "rgba(255,255,255,0.08)";
      ctx.beginPath();
      ctx.moveTo(0, mid);
      ctx.lineTo(w, mid);
      ctx.stroke();
      return;
    }

    const playedX = progress * w;
    // Aggregate peaks into pixel columns (max per column) so the overview stays
    // crisp no matter how high-resolution the engine's peak array is.
    const cols = Math.max(1, Math.floor(w / 2)); // 2px per bar
    const colW = w / cols;
    for (let cIdx = 0; cIdx < cols; cIdx++) {
      const from = Math.floor((cIdx / cols) * n);
      const to = Math.max(from + 1, Math.floor(((cIdx + 1) / cols) * n));
      let pk = 0;
      for (let i = from; i < to && i < n; i++) pk = Math.max(pk, peaks[i]);
      const x = cIdx * colW;
      const amp = Math.max(0.02, pk / 100); // peaks are 0..100
      const barH = amp * (h * 0.9);
      ctx.fillStyle = x <= playedX ? playedColor : color;
      ctx.globalAlpha = x <= playedX ? 0.95 : 0.55;
      ctx.fillRect(x, mid - barH / 2, Math.max(1, colW - 0.5), barH);
    }
    ctx.globalAlpha = 1;

    // loop region — shaded so an active hold reads instantly from across a stage
    if (loop && loop.start >= 0 && loop.end > loop.start) {
      const x0 = loop.start * w, x1 = loop.end * w;
      ctx.fillStyle = loop.active ? "rgba(56,211,159,0.20)" : "rgba(56,211,159,0.07)";
      ctx.fillRect(x0, 0, x1 - x0, h);
      ctx.strokeStyle = loop.active ? "#38d39f" : "#38d39f66";
      ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(x0, 0); ctx.lineTo(x0, h);
      ctx.moveTo(x1, 0); ctx.lineTo(x1, h); ctx.stroke();
    }

    // hot cues (numbered ticks along the bottom)
    if (hotCues) {
      hotCues.forEach((r, i) => {
        if (r === null || r < 0 || r > 1) return;
        const x = r * w;
        ctx.fillStyle = "#00b4ff";
        ctx.fillRect(x - 1, h - 14, 2, 14);
        ctx.fillStyle = "#00b4ff";
        ctx.font = "bold 8px monospace";
        ctx.fillText(String(i + 1), x + 2, h - 4);
      });
    }

    // cue marker (orange is the DJ convention for the memory/cue point)
    if (cueRatio !== undefined && cueRatio >= 0 && cueRatio <= 1) {
      const cueX = cueRatio * w;
      ctx.strokeStyle = "#ff8c1a";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(cueX, 0);
      ctx.lineTo(cueX, h);
      ctx.stroke();
      // small flag at the top so it reads at a glance
      ctx.fillStyle = "#ff8c1a";
      ctx.beginPath();
      ctx.moveTo(cueX, 0);
      ctx.lineTo(cueX + 8, 0);
      ctx.lineTo(cueX, 9);
      ctx.closePath();
      ctx.fill();
    }

    // playhead
    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(playedX, 0);
    ctx.lineTo(playedX, h);
    ctx.stroke();
  }, [peaks, progress, cueRatio, loop, hotCues, color, playedColor, height]);

  return (
    <canvas
      ref={canvasRef}
      style={{ width: "100%", height, display: "block", cursor: onSeek ? "pointer" : "default", borderRadius: 6 }}
      onClick={(e) => {
        if (!onSeek) return;
        const rect = e.currentTarget.getBoundingClientRect();
        onSeek((e.clientX - rect.left) / rect.width);
      }}
    />
  );
}
