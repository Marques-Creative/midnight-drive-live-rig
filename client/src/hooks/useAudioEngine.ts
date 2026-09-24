/**
 * useAudioEngine — Web Audio API multitrack playback engine (streaming)
 *
 * Architecture:
 *   HTMLAudioElement (streams from S3)
 *     └─ MediaElementAudioSourceNode  →  GainNode (volume)  →  masterGain  →  destination
 *
 * Using HTMLAudioElement + createMediaElementSource instead of fetch+decodeAudioData means:
 *  - Playback starts as soon as enough data has buffered (~1-2s) rather than after the
 *    entire file is downloaded and decoded (which was 30-120s for large WAVs).
 *  - Memory usage is dramatically lower — no full AudioBuffer in RAM per stem.
 *  - All mixer controls (gain, mute, seek, fade) still work through the Web Audio graph.
 *
 * Limitation: All stems must be seeked individually; we keep them in sync by setting
 * currentTime on all elements together and restarting playback.
 */

import { useRef, useState, useCallback, useEffect } from "react";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface StemDescriptor {
  id: number;
  name: string;
  fileUrl: string | null;
  volume: number;   // 0–2 linear gain
  muted: boolean;
  outputRoute: string;
}

export type LoadingStatus = "idle" | "loading" | "ready" | "error";

interface StemNode {
  el: HTMLAudioElement;
  gainNode: GainNode;
  source: MediaElementAudioSourceNode;
  blobUrl?: string; // revoke on teardown
}

export interface AudioEngineAPI {
  /** Current playback status */
  status: LoadingStatus;
  /** True while audio is running (not paused, not stopped) */
  isPlaying: boolean;
  /** True when paused mid-song */
  isPaused: boolean;
  /** Current playback position in seconds */
  currentTime: number;
  /** Total duration of the longest stem, in seconds */
  duration: number;
  /** Human-readable error message, if any */
  error: string | null;

  /** Load a new set of stems. Stops any current playback first. */
  loadStems: (stems: StemDescriptor[], backingTrackUrl?: string | null) => Promise<void>;
  /** Start or resume playback */
  play: () => void;
  /** Pause playback (preserves position) */
  pause: () => void;
  /** Stop and reset to 0 */
  stop: () => void;
  /** Seek to a specific time in seconds */
  seek: (time: number) => void;
  /** Set volume for a specific stem (0–2) */
  setStemVolume: (stemId: number, volume: number) => void;
  /** Mute or unmute a specific stem */
  setStemMuted: (stemId: number, muted: boolean) => void;
  /** Fade master output to 0 over `durationSec` seconds, then stop */
  fadeOut: (durationSec?: number) => void;
  /** Resume AudioContext if suspended (call from a user-gesture handler) */
  resumeContext: () => Promise<void>;
}

// ── Hook ──────────────────────────────────────────────────────────────────────

export function useAudioEngine(): AudioEngineAPI {
  const ctxRef = useRef<AudioContext | null>(null);
  const masterGainRef = useRef<GainNode | null>(null);
  const stemNodesRef = useRef<Map<number, StemNode>>(new Map());
  const rafRef = useRef<number | null>(null);
  const fadeTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const durationRef = useRef<number>(0);

  const [status, setStatus] = useState<LoadingStatus>("idle");
  const [isPlaying, setIsPlaying] = useState(false);
  const [isPaused, setIsPaused] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [error, setError] = useState<string | null>(null);

  // ── Internal helpers ────────────────────────────────────────────────────────

  function getCtx(): AudioContext {
    if (!ctxRef.current || ctxRef.current.state === "closed") {
      const ctx = new AudioContext();
      const master = ctx.createGain();
      master.gain.value = 1;
      master.connect(ctx.destination);
      ctxRef.current = ctx;
      masterGainRef.current = master;
    }
    return ctxRef.current;
  }

  function stopRaf() {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
  }

  function startRaf() {
    stopRaf();
    function tick() {
      // Use the first stem element as the clock
      const first = stemNodesRef.current.values().next().value as StemNode | undefined;
      if (!first) return;
      const t = first.el.currentTime;
      const dur = durationRef.current;
      setCurrentTime(t);
      if (!first.el.paused && t < dur) {
        rafRef.current = requestAnimationFrame(tick);
      } else if (t >= dur && dur > 0) {
        // Natural end
        setIsPlaying(false);
        setIsPaused(false);
        setCurrentTime(dur);
      }
    }
    rafRef.current = requestAnimationFrame(tick);
  }

  function teardownStems() {
    stopRaf();
    stemNodesRef.current.forEach((node) => {
      try { node.el.pause(); } catch (_) {}
      node.el.src = "";
      node.el.load();
      try { node.source.disconnect(); } catch (_) {}
      try { node.gainNode.disconnect(); } catch (_) {}
      // Revoke blob URL to free memory
      if (node.blobUrl) URL.revokeObjectURL(node.blobUrl);
    });
    stemNodesRef.current.clear();
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  const resumeContext = useCallback(async () => {
    const ctx = ctxRef.current;
    if (ctx && ctx.state === "suspended") await ctx.resume();
  }, []);

  const loadStems = useCallback(async (stems: StemDescriptor[], backingTrackUrl?: string | null) => {
    teardownStems();
    setIsPlaying(false);
    setIsPaused(false);
    setCurrentTime(0);
    setError(null);

    const stemsWithUrl = stems.filter((s) => s.fileUrl);

    // Backing track fallback
    if (stemsWithUrl.length === 0 && backingTrackUrl) {
      return loadStems([{
        id: -1,
        name: "Backing Track",
        fileUrl: backingTrackUrl,
        volume: 1,
        muted: false,
        outputRoute: "main",
      }]);
    }

    if (stemsWithUrl.length === 0) {
      setStatus("idle");
      setDuration(0);
      durationRef.current = 0;
      return;
    }

    setStatus("loading");

    try {
      const ctx = getCtx();
      if (ctx.state === "suspended") {
        try { await ctx.resume(); } catch (_) {}
      }

      const master = masterGainRef.current!;
      master.gain.cancelScheduledValues(ctx.currentTime);
      master.gain.setValueAtTime(1, ctx.currentTime);

      let maxDuration = 0;
      const loadPromises: Promise<void>[] = [];

      for (const stem of stemsWithUrl) {
        const rawUrl = stem.fileUrl!;
        // Encode path segments so filenames with spaces/special chars work
        const safeUrl = rawUrl.startsWith("/manus-storage/")
          ? "/manus-storage/" + rawUrl.slice("/manus-storage/".length).split("/").map(encodeURIComponent).join("/")
          : rawUrl.startsWith("/local-storage/")
          ? "/local-storage/" + rawUrl.slice("/local-storage/".length).split("/").map(encodeURIComponent).join("/")
          : rawUrl;

        // Fetch via session-authenticated proxy, then create a local blob URL.
        // This avoids the CORS issue that arises when setting crossOrigin="anonymous"
        // on an HTMLAudioElement pointing at a same-origin proxy URL — the proxy
        // doesn't send CORS headers, so the browser rejects the request.
        const p = (async () => {
          try {
            const resp = await fetch(safeUrl);
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            const blob = await resp.blob();
            const blobUrl = URL.createObjectURL(blob);

            const el = new Audio();
            // No crossOrigin needed — blob URLs are same-origin by definition
            el.preload = "auto";
            el.src = blobUrl;

            const gainNode = ctx.createGain();
            (gainNode as any)._lastVolume = stem.volume;
            (gainNode as any)._muted = stem.muted;
            gainNode.gain.value = stem.muted ? 0 : stem.volume;
            gainNode.connect(master);

            const source = ctx.createMediaElementSource(el);
            source.connect(gainNode);

            stemNodesRef.current.set(stem.id, { el, gainNode, source, blobUrl });

            await new Promise<void>((resolve) => {
              if (el.readyState >= 1) {
                if (el.duration && el.duration > maxDuration) maxDuration = el.duration;
                resolve();
              } else {
                const onMeta = () => {
                  el.removeEventListener("loadedmetadata", onMeta);
                  el.removeEventListener("error", onErr);
                  if (el.duration && el.duration > maxDuration) maxDuration = el.duration;
                  resolve();
                };
                const onErr = () => {
                  el.removeEventListener("loadedmetadata", onMeta);
                  el.removeEventListener("error", onErr);
                  resolve();
                };
                el.addEventListener("loadedmetadata", onMeta);
                el.addEventListener("error", onErr);
              }
            });
          } catch (err) {
            console.error(`[AudioEngine] Failed to load stem "${stem.name}":`, err);
            setError(`Failed to load "${stem.name}". Check the file was uploaded correctly.`);
            // non-fatal: continue loading other stems
          }
        })();
        loadPromises.push(p);
      }

      await Promise.all(loadPromises);

      durationRef.current = maxDuration;
      setDuration(maxDuration);
      setStatus(stemNodesRef.current.size > 0 ? "ready" : "error");
      if (stemNodesRef.current.size === 0) {
        setError("No stems could be loaded. Check that audio files are uploaded.");
      }
    } catch (err) {
      console.error("[AudioEngine] loadStems failed:", err);
      setStatus("error");
      setError("Failed to load audio. Check your connection and try again.");
    }
  }, []);

  const play = useCallback(() => {
    const ctx = ctxRef.current;
    if (!ctx || stemNodesRef.current.size === 0) return;

    if (ctx.state === "suspended") {
      ctx.resume().then(() => play());
      return;
    }

    // Play all elements simultaneously
    const plays: Promise<void>[] = [];
    stemNodesRef.current.forEach((node) => {
      plays.push(node.el.play().catch((e) => {
        console.warn("[AudioEngine] play() rejected:", e);
      }));
    });

    Promise.all(plays).then(() => {
      setIsPlaying(true);
      setIsPaused(false);
      startRaf();
    });
  }, []);

  const pause = useCallback(() => {
    stemNodesRef.current.forEach((node) => node.el.pause());
    stopRaf();
    setIsPlaying(false);
    setIsPaused(true);
    // Capture current time from first element
    const first = stemNodesRef.current.values().next().value as StemNode | undefined;
    if (first) setCurrentTime(first.el.currentTime);
  }, []);

  const stop = useCallback(() => {
    stemNodesRef.current.forEach((node) => {
      node.el.pause();
      node.el.currentTime = 0;
    });
    stopRaf();
    setIsPlaying(false);
    setIsPaused(false);
    setCurrentTime(0);

    const ctx = ctxRef.current;
    const master = masterGainRef.current;
    if (ctx && master) {
      master.gain.cancelScheduledValues(ctx.currentTime);
      master.gain.setValueAtTime(1, ctx.currentTime);
    }
  }, []);

  const seek = useCallback((time: number) => {
    const t = Math.max(0, Math.min(time, durationRef.current));
    const wasPlaying = isPlaying && !isPaused;

    stemNodesRef.current.forEach((node) => {
      node.el.pause();
      node.el.currentTime = t;
    });
    stopRaf();
    setCurrentTime(t);
    setIsPlaying(false);

    if (wasPlaying) {
      // Small delay to let browser seek before resuming
      setTimeout(() => {
        const plays: Promise<void>[] = [];
        stemNodesRef.current.forEach((node) => {
          plays.push(node.el.play().catch(() => {}));
        });
        Promise.all(plays).then(() => {
          setIsPlaying(true);
          setIsPaused(false);
          startRaf();
        });
      }, 50);
    }
  }, [isPlaying, isPaused]);

  const setStemVolume = useCallback((stemId: number, volume: number) => {
    const node = stemNodesRef.current.get(stemId);
    if (!node) return;
    const ctx = ctxRef.current;
    if (!ctx) return;
    (node.gainNode as any)._lastVolume = volume;
    const isMuted = (node.gainNode as any)._muted === true;
    if (!isMuted) {
      node.gainNode.gain.setValueAtTime(volume, ctx.currentTime);
    }
  }, []);

  const setStemMuted = useCallback((stemId: number, muted: boolean) => {
    const node = stemNodesRef.current.get(stemId);
    if (!node) return;
    const ctx = ctxRef.current;
    if (!ctx) return;
    if (muted) {
      if (node.gainNode.gain.value > 0) {
        (node.gainNode as any)._lastVolume = node.gainNode.gain.value;
      }
      (node.gainNode as any)._muted = true;
      node.gainNode.gain.setValueAtTime(0, ctx.currentTime);
    } else {
      (node.gainNode as any)._muted = false;
      const lastVol = (node.gainNode as any)._lastVolume ?? 1;
      node.gainNode.gain.setValueAtTime(lastVol, ctx.currentTime);
    }
  }, []);

  const fadeOut = useCallback((durationSec = 3) => {
    const ctx = ctxRef.current;
    const master = masterGainRef.current;
    if (!ctx || !master) return;

    master.gain.cancelScheduledValues(ctx.currentTime);
    master.gain.setValueAtTime(master.gain.value, ctx.currentTime);
    master.gain.linearRampToValueAtTime(0, ctx.currentTime + durationSec);

    if (fadeTimeoutRef.current) clearTimeout(fadeTimeoutRef.current);
    fadeTimeoutRef.current = setTimeout(() => {
      stop();
      if (masterGainRef.current && ctxRef.current) {
        masterGainRef.current.gain.cancelScheduledValues(ctxRef.current.currentTime);
        masterGainRef.current.gain.setValueAtTime(1, ctxRef.current.currentTime);
      }
    }, durationSec * 1000 + 100);
  }, [stop]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      teardownStems();
      if (fadeTimeoutRef.current) clearTimeout(fadeTimeoutRef.current);
      ctxRef.current?.close().catch(() => {});
    };
  }, []);

  return {
    status,
    isPlaying,
    isPaused,
    currentTime,
    duration,
    error,
    loadStems,
    play,
    pause,
    stop,
    seek,
    setStemVolume,
    setStemMuted,
    fadeOut,
    resumeContext,
  };
}
