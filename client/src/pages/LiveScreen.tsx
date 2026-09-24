import { useState, useEffect, useRef, useCallback } from "react";
import { useLocation } from "wouter";
import OverviewWaveform from "../components/OverviewWaveform";
import { useShowState, setShowState, updateSongIndex } from "../lib/showState";
import { trpc } from "@/lib/trpc";
import { toast } from "sonner";
import {
  Play, Pause, Square, SkipForward, SkipBack, RotateCcw,
  Volume2, VolumeX, Wifi, WifiOff, QrCode, X, Zap,
  Maximize2, Minimize2, Loader2, AlertTriangle, Music2,
  GripVertical, ListPlus, Search, Plus
} from "lucide-react";
import { io, Socket } from "socket.io-client";
import { useMemo } from "react";
import type { PlaybackState, TransportCommand } from "@shared/socketTypes";
import QRCodeCanvas from "../components/QRCodeCanvas";
import type { StemDescriptor } from "../hooks/useAudioEngine";
import { useTransport } from "../hooks/useTransport";
import ClockBar from "../components/ClockBar";
import { KaraokeView } from "../components/KaraokeView";
import { parseLyricCues, getActiveCueIndex } from "@shared/lyricParser";

const CHORD_RE = new RegExp("^[A-G][#b]?(m|maj|min|dim|aug|sus|add)?[0-9]*(\\/[A-G][#b]?)?");

function formatTime(seconds: number) {
  if (!isFinite(seconds) || seconds < 0) return "0:00";
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function parseLyrics(raw: string) {
  const lines = raw.split("\n");
  const sections: Array<{ timestamp: number | null; label: string; lines: string[] }> = [];
  let current: { timestamp: number | null; label: string; lines: string[] } | null = null;

  for (const line of lines) {
    const tsMatch = line.match(/^\[(\d{1,2}):(\d{2})\]\s*(.*)/);
    if (tsMatch) {
      if (current) sections.push(current);
      const mins = parseInt(tsMatch[1]);
      const secs = parseInt(tsMatch[2]);
      current = { timestamp: mins * 60 + secs, label: tsMatch[3] || "", lines: [] };
    } else if (current) {
      current.lines.push(line);
    } else {
      current = { timestamp: null, label: "", lines: [line] };
    }
  }
  if (current) sections.push(current);
  return sections;
}


// Set timer display for Live Screen / Companion
function SetTimerBand({ running, startTime }: { running: boolean; startTime: number }) {
  const [display, setDisplay] = useState("00:00:00");
  useEffect(() => {
    if (!running) { setDisplay("00:00:00"); return; }
    const tick = () => {
      const sec = Math.floor((Date.now() - startTime) / 1000);
      const h = Math.floor(sec / 3600).toString().padStart(2, "0");
      const m = Math.floor((sec % 3600) / 60).toString().padStart(2, "0");
      const s = (sec % 60).toString().padStart(2, "0");
      setDisplay(`${h}:${m}:${s}`);
    };
    tick();
    const id = setInterval(tick, 500);
    return () => clearInterval(id);
  }, [running, startTime]);
  return (
    <div style={{ textAlign: "center" }}>
      <div style={{ fontFamily: "Orbitron, monospace", fontSize: 48, fontWeight: 900,
        fontVariantNumeric: "tabular-nums", letterSpacing: 6,
        color: running ? "#38d39f" : "rgba(56,211,159,0.2)",
        textShadow: running ? "0 0 30px #38d39f66" : "none" }}>
        {display}
      </div>
      <div style={{ fontSize: 10, color: "rgba(255,255,255,0.3)", letterSpacing: 3, marginTop: 2 }}>
        SET TIME
      </div>
    </div>
  );
}

export default function LiveScreen() {
  const [, navigate] = useLocation();
  const { data: setLists } = trpc.setLists.list.useQuery();
  // Show selection (set list + song index) lives in a shared store so it
  // survives navigating to other pages (e.g. DJ Decks) and app restarts.
  const { setListId: selectedSetListId, songIndex: currentIndex, mode: showMode } = useShowState();
  const setSelectedSetListId = useCallback((id: number | null) => setShowState({ setListId: id }), []);
  const setCurrentIndex = useCallback((v: number | ((prev: number) => number)) => {
    if (typeof v === "function") updateSongIndex(v);
    else setShowState({ songIndex: Math.max(0, v) });
  }, []);
  const { data: setListSongs } = trpc.setLists.songs.useQuery(
    { setListId: selectedSetListId! },
    { enabled: selectedSetListId !== null }
  );

  const [fullscreen, setFullscreen] = useState(false);
  const [showQR, setShowQR] = useState(false);
  const [showMixer, setShowMixer] = useState(true);
  const [showSetEdit, setShowSetEdit] = useState(false);
  const [setEditSearch, setSetEditSearch] = useState("");
  const [confirmStop, setConfirmStop] = useState(false);
  const [confirmNext, setConfirmNext] = useState(false);
  const [isFadingOut, setIsFadingOut] = useState(false);
  const [companionCount, setCompanionCount] = useState(0);
  const [socketConnected, setSocketConnected] = useState(false);
  const [companionPin, setCompanionPin] = useState<string | null>(null);
  const [localUrl, setLocalUrl] = useState("");
  const { data: localIpData } = trpc.localIp.useQuery();
  const [audioUnlocked, setAudioUnlocked] = useState(false);
  const [lyricViewMode, setLyricViewMode] = useState<"karaoke" | "chart" | "set">("karaoke");

  // Per-stem UI overrides (volume/mute shown in mixer)
  const [stemOverrides, setStemOverrides] = useState<Record<number, { volume: number; muted: boolean }>>({})

  // Backing track channel state (used when no stems are defined)
  const [btVol, setBtVol] = useState(1);
  const [btMuted, setBtMuted] = useState(false);

  const socketRef = useRef<Socket | null>(null);
  const lyricsRef = useRef<HTMLDivElement>(null);
  const prevSongIdRef = useRef<number | null>(null);
  // Stable ref to the transport command handler so the socket listener
  // (set up once in useEffect) always calls the latest version of the handlers.
  const transportCommandRef = useRef<((cmd: TransportCommand) => void) | null>(null);

  // ── Audio engine ────────────────────────────────────────────────────────────
  const audio = useTransport();
  const timerRunning = (audio as any).timerRunning ?? false;
  const timerStartTime = (audio as any).timerStartTime ?? 0;

  // ── DJ MIRROR ──────────────────────────────────────────────────────────────
  // In "dj" mode the Live Screen follows the DJ: the song on the MASTER deck,
  // its lyrics/chords driven by that deck's playhead, and its stems in the
  // mixer (the Band Master rides the DJ's playing track).
  const djMode = showMode === "dj";
  const { data: allSongsForMarkers } = trpc.songs.list.useQuery(undefined, { enabled: djMode });
  const masterDeckIdx = audio.masterDeck;
  const djSongId = audio.deckSongIds[masterDeckIdx] ?? null;
  const { data: djSong } = trpc.songs.byId.useQuery(
    { id: djSongId! },
    { enabled: djMode && djSongId !== null },
  );

  const currentSong = djMode ? djSong : setListSongs?.[currentIndex]?.song;
  const { data: stems } = trpc.stems.bySong.useQuery(
    { songId: currentSong?.id! },
    { enabled: !!currentSong?.id }
  );
  // All songs for the request search
  const { data: allSongs } = trpc.songs.list.useQuery();

  // Mid-set mutations
  const utils = trpc.useUtils();
  const insertAfterMutation = trpc.setLists.insertAfterPosition.useMutation({
    onSuccess: () => {
      utils.setLists.songs.invalidate({ setListId: selectedSetListId! });
      toast.success("Song added to set");
      setSetEditSearch("");
    },
    onError: () => toast.error("Failed to add song"),
  });
  const reorderMutation = trpc.setLists.reorderByRowId.useMutation({
    onSuccess: () => utils.setLists.songs.invalidate({ setListId: selectedSetListId! }),
    onError: () => toast.error("Failed to reorder"),
  });

  // Local drag state for the set edit panel
  const dragIndexRef = useRef<number | null>(null);
  const [dragOverIdx, setDragOverIdx] = useState<number | null>(null);
  const [localSetOrder, setLocalSetOrder] = useState<NonNullable<typeof setListSongs>>([]);

  // Sync local order when server data changes
  useEffect(() => {
    if (setListSongs) setLocalSetOrder(setListSongs);
  }, [setListSongs]);

  const liveSetOrder = localSetOrder.length > 0 ? localSetOrder : (setListSongs ?? []);

  const handleSetDragStart = (idx: number) => { dragIndexRef.current = idx; };
  const handleSetDragOver = (e: React.DragEvent, idx: number) => {
    e.preventDefault();
    setDragOverIdx(idx);
  };
  const handleSetDrop = (idx: number) => {
    const from = dragIndexRef.current;
    if (from === null || from === idx) { setDragOverIdx(null); return; }
    const newOrder = [...liveSetOrder];
    const [moved] = newOrder.splice(from, 1);
    newOrder.splice(idx, 0, moved);
    setLocalSetOrder(newOrder);
    setDragOverIdx(null);
    dragIndexRef.current = null;
    reorderMutation.mutate({
      orderedRowIds: newOrder.map((s) => s.id),
    });
    // Always update currentIndex to follow the current song after any reorder
    const newCurrentIdx = newOrder.findIndex((s) => s.songId === currentSong?.id);
    if (newCurrentIdx !== -1) setCurrentIndex(newCurrentIdx);
  };

  const incrementPlayCount = trpc.songs.incrementPlayCount.useMutation();

  const updateStemMutation = trpc.stems.update.useMutation({
    onSuccess: () => {
      setMixerSaveStatus("saved");
      // Clear the indicator after 2 seconds
      setTimeout(() => setMixerSaveStatus("idle"), 2000);
    },
    onError: () => setMixerSaveStatus("error"),
  });
  const [mixerSaveStatus, setMixerSaveStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");

  const totalSongs = setListSongs?.length ?? 0;
  const nextSong = setListSongs?.[currentIndex + 1]?.song;
  const lyricsRaw = currentSong?.lyrics ?? "";
  const lyricsSections = parseLyrics(lyricsRaw);
  const lyricCuesRaw = currentSong?.lyricCues ?? "";
  const lyricCues = useMemo(() => parseLyricCues(lyricCuesRaw), [lyricCuesRaw]);

  // Use audio engine duration if available, fall back to song metadata
  const djDeck = audio.decks[masterDeckIdx];
  const duration = djMode
    ? djDeck.duration
    : (audio.duration > 0 ? audio.duration : (currentSong?.duration ?? 0));
  const currentTime = djMode ? djDeck.seconds : audio.currentTime;
  const activeCueIndex = getActiveCueIndex(lyricCues, currentTime);

  // Markers for the current song — shown on waveform + upcoming banner
  const currentSongMarkers: Array<{ id: string; timeSeconds: number; label: string; note?: string; color?: string }> = (() => {
    const src = djMode
      ? (allSongsForMarkers?.find?.((s: { id: number }) => s.id === (audio.deckSongIds?.[masterDeckIdx] ?? -1)) as { markers?: string | null } | undefined)
      : (currentSong as { markers?: string | null } | undefined);
    try { return JSON.parse((src as { markers?: string | null } | undefined)?.markers ?? "[]"); }
    catch { return []; }
  })();

  // Upcoming marker: first marker > currentTime within the next 30 seconds
  const upcomingMarker = currentSongMarkers
    .filter((m) => m.timeSeconds > currentTime && m.timeSeconds - currentTime < 30)
    .sort((a, b) => a.timeSeconds - b.timeSeconds)[0];
  const secondsToMarker = upcomingMarker ? upcomingMarker.timeSeconds - currentTime : null;
  const progress = duration > 0 ? Math.min((currentTime / duration) * 100, 100) : 0;

  // Active lyrics section
  const activeSectionIdx = lyricsSections.reduce((acc, sec, idx) => {
    if (sec.timestamp !== null && sec.timestamp <= currentTime) return idx;
    return acc;
  }, 0);

  // ── Load stems when song changes ────────────────────────────────────────────
  useEffect(() => {
    if (!currentSong) return;
    if (currentSong.id === prevSongIdRef.current) return;
    prevSongIdRef.current = currentSong.id;

    // Stop current playback before loading new song
    audio.stop();
    // Reset overrides — they will be re-seeded from DB values once stems load
    setStemOverrides({});
    setIsFadingOut(false);
    setConfirmStop(false);
    setConfirmNext(false);
  }, [currentSong?.id]);

  // ── Seed stemOverrides from DB when stems arrive for a new song ─────────────
  // This ensures the mixer UI immediately shows the persisted fader/mute values
  // rather than waiting for the user to interact with a control.
  useEffect(() => {
    if (!stems || stems.length === 0) return;
    setStemOverrides((prev) => {
      // Only seed stems that don't already have an override (i.e. fresh song load)
      const hasAny = Object.keys(prev).length > 0;
      if (hasAny) return prev;
      const seeded: Record<number, { volume: number; muted: boolean }> = {};
      stems.forEach((s) => {
        seeded[s.id] = { volume: s.volume, muted: s.muted };
      });
      return seeded;
    });
  }, [stems]);

  // Signature of the loaded stem SET (identities + files). Changes only when the
  // song's stems are added/removed/replaced — not when route/volume/mute change.
  const stemLoadSig = useMemo(
    () => (stems ?? []).map((s) => `${s.id}:${s.fileUrl ?? ""}`).join("|"),
    [stems],
  );

  useEffect(() => {
    if (!stems) return;
    if (!currentSong) return;

    // Use local-storage URLs directly — the streaming engine (HTMLAudioElement)
    // starts playback as soon as enough data has buffered.
    const descriptors: StemDescriptor[] = stems.map((s) => ({
      id: s.id,
      name: s.name,
      fileUrl: s.fileUrl,
      volume: stemOverrides[s.id]?.volume ?? s.volume,
      muted: stemOverrides[s.id]?.muted ?? s.muted,
      outputRoute: s.outputRoute,
    }));

    const backingUrl = currentSong?.audioFileUrl ?? null;
    audio.loadStems(descriptors, backingUrl, currentSong.id);
    // Reload only when the SET of stem files changes (song change, add/remove),
    // NOT when a property like route/volume/mute changes — those are applied live
    // so they don't interrupt playback or reset the playhead. `stemLoadSig`
    // captures just stem identities + files. nativeActive is included so a
    // late-connecting engine still gets the song loaded.
  }, [stemLoadSig, currentSong?.id, currentSong?.audioFileUrl, audio.nativeActive]);

  // ── Socket.IO ───────────────────────────────────────────────────────────────
  useEffect(() => {
    const socket = io(window.location.origin, {
      path: "/socket.io",
      query: { role: "host" },
    });
    socketRef.current = socket;
    socket.on("connect", () => setSocketConnected(true));
    socket.on("disconnect", () => setSocketConnected(false));
    socket.on("state", (state: PlaybackState) => {
      setCompanionCount(state.connectedCompanions ?? 0);
    });
    // Remote transport commands from companion devices
    socket.on("transportCommand", (cmd: TransportCommand) => {
      transportCommandRef.current?.(cmd);
    });
    // Use the Mac's local network IP so iPads on the same Wi-Fi can connect.
    // Falls back to window.location.origin (localhost) if IP is unavailable.
    const ip = localIpData?.ip;
    const port = window.location.port;
    const base = ip
      ? `http://${ip}${port ? `:${port}` : ""}/companion`
      : window.location.origin + "/companion";
    // Embed the companion PIN in the QR so the band's flow stays scan → play.
    // The endpoint is loopback-only; if unreachable, show the URL without it.
    fetch("/api/companion-pin")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        setCompanionPin(d?.pin ?? null);
        setLocalUrl(d?.pin ? `${base}?pin=${d.pin}` : base);
      })
      .catch(() => setLocalUrl(base));
    return () => { socket.disconnect(); };
  }, [localIpData]);

  // ── Broadcast state ─────────────────────────────────────────────────────────
  const broadcastState = useCallback(() => {
    if (!socketRef.current) return;
    const state: Partial<PlaybackState> = {
      songId: currentSong?.id ?? null,
      songTitle: currentSong?.title ?? "No song loaded",
      artist: currentSong?.artist ?? "",
      bpm: currentSong?.bpm ?? null,
      key: currentSong?.key ?? null,
      duration: duration || null,
      // In DJ mode the companions mirror the DJ: play state and set label come
      // from the master deck, so the iPad shows what the DJ is actually doing.
      isPlaying: djMode ? djDeck.playing : audio.isPlaying,
      isPaused: djMode ? false : audio.isPaused,
      currentTime,
      setListId: selectedSetListId,
      setListName: djMode
        ? `DJ DECKS · DECK ${masterDeckIdx + 1}`
        : (setLists?.find((s) => s.id === selectedSetListId)?.name ?? ""),
      currentIndex,
      totalSongs,
      // In DJ mode, "next song" = what's on the non-master deck (the incoming track)
      // In set-list mode, it's the next song in the set list as before
      nextSongTitle: djMode
        ? (() => {
            const otherIdx = masterDeckIdx === 0 ? 1 : 0;
            const otherId = audio.deckSongIds?.[otherIdx];
            const otherSong = allSongsForMarkers?.find((s: { id: number }) => s.id === otherId) as { title?: string } | undefined;
            return (otherSong?.title ?? "");
          })()
        : (nextSong?.title ?? ""),
      nextSongArtist: djMode
        ? (() => {
            const otherIdx = masterDeckIdx === 0 ? 1 : 0;
            const otherId = audio.deckSongIds?.[otherIdx];
            const otherSong = allSongsForMarkers?.find((s: { id: number }) => s.id === otherId) as { artist?: string } | undefined;
            return (otherSong?.artist ?? "");
          })()
        : (nextSong?.artist ?? ""),
      nextSongBpm: djMode
        ? (() => {
            const otherIdx = masterDeckIdx === 0 ? 1 : 0;
            const otherDeck = audio.decks[otherIdx];
            return otherDeck.loaded ? (otherDeck.bpm ?? null) : null;
          })()
        : (nextSong?.bpm ?? null),
      nextSongKey: djMode ? null : (nextSong?.key ?? null),
      lyrics: lyricsRaw,
      lyricsScrollPosition: duration > 0 ? currentTime / duration : 0,
      lyricCues,
      activeCueIndex,
      lyricViewMode,
      stems: (stems ?? []).map((s) => ({
        id: s.id,
        name: s.name,
        volume: stemOverrides[s.id]?.volume ?? s.volume,
        muted: stemOverrides[s.id]?.muted ?? s.muted,
        outputRoute: s.outputRoute,
      })),
    };
    socketRef.current.emit("updateState", state);
  }, [currentSong, audio.isPlaying, audio.isPaused, currentTime, selectedSetListId, djMode, djDeck.playing, masterDeckIdx,
      currentIndex, totalSongs, nextSong, lyricsRaw, duration, stems, stemOverrides, setLists,
      lyricCues, activeCueIndex, lyricViewMode]);

  useEffect(() => { broadcastState(); }, [broadcastState]);

  // ── Lyrics scroll ───────────────────────────────────────────────────────────
  useEffect(() => {
    if (!lyricsRef.current) return;
    const activeEl = lyricsRef.current.querySelector(`[data-section="${activeSectionIdx}"]`);
    activeEl?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [activeSectionIdx]);

  // ── Transport handlers ──────────────────────────────────────────────────────

  /** Unlock AudioContext on first user gesture — required by browser autoplay policy */
  const ensureAudioUnlocked = useCallback(async () => {
    if (!audioUnlocked) {
      await audio.resumeContext();
      setAudioUnlocked(true);
    }
  }, [audioUnlocked, audio]);

  const handlePlay = useCallback(async () => {
    if (!currentSong) { toast.error("Select a set list and song first"); return; }
    if (audio.status === "loading") { toast.info("Loading audio…"); return; }
    if (audio.status === "error") { toast.error(audio.error ?? "Audio load failed"); return; }
    await ensureAudioUnlocked();
    setIsFadingOut(false);
    const wasAlreadyPlaying = audio.isPlaying || audio.isPaused;
    audio.play();
    // Increment play count only when starting a new playback (not resuming)
    if (!wasAlreadyPlaying && currentSong.id) {
      incrementPlayCount.mutate({ id: currentSong.id });
    }
  }, [currentSong, audio, ensureAudioUnlocked, incrementPlayCount]);

  const handlePause = useCallback(() => {
    if (audio.isPlaying) audio.pause();
    else handlePlay();
  }, [audio, handlePlay]);

  const handleStop = useCallback(() => {
    if (audio.isPlaying && !confirmStop) { setConfirmStop(true); return; }
    audio.stop();
    setIsFadingOut(false);
    setConfirmStop(false);
  }, [audio, confirmStop]);

  const handleNext = useCallback(() => {
    if (audio.isPlaying && !confirmNext) { setConfirmNext(true); return; }
    if (currentIndex < totalSongs - 1) {
      audio.stop();
      setCurrentIndex((i) => i + 1);
      setIsFadingOut(false);
    }
    setConfirmNext(false);
  }, [audio, confirmNext, currentIndex, totalSongs]);

  const handlePrev = useCallback(() => {
    if (currentIndex > 0) {
      audio.stop();
      setCurrentIndex((i) => i - 1);
      setIsFadingOut(false);
    }
  }, [audio, currentIndex]);

  // Keep transportCommandRef in sync with latest handler closures
  useEffect(() => {
    transportCommandRef.current = (cmd: TransportCommand) => {
      switch (cmd.type) {
        case "play":  handlePlay(); break;
        case "pause": handlePause(); break;
        case "stop":  audio.stop(); setConfirmStop(false); setIsFadingOut(false); break;
        case "next":  audio.stop(); setCurrentIndex((i) => Math.min(i + 1, totalSongs - 1)); setIsFadingOut(false); break;
        case "prev":  audio.stop(); setCurrentIndex((i) => Math.max(i - 1, 0)); setIsFadingOut(false); break;
        case "seek":  audio.seek(cmd.time); break;
      }
    };
  }, [handlePlay, handlePause, audio, totalSongs]);

  const handleRestart = useCallback(async () => {
    await ensureAudioUnlocked();
    audio.stop();
    setTimeout(() => audio.play(), 50);
  }, [audio, ensureAudioUnlocked]);

  const handleEmergencyFade = useCallback(() => {
    setIsFadingOut(true);
    audio.fadeOut(3);
    setTimeout(() => setIsFadingOut(false), 3200);
  }, [audio]);

  const handleProgressClick = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (!duration) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const ratio = (e.clientX - rect.left) / rect.width;
    audio.seek(ratio * duration);
  }, [audio, duration]);

  // ── Mixer handlers ──────────────────────────────────────────────────────────

  const handleStemVolume = useCallback((stemId: number, volume: number) => {
    setStemOverrides((prev) => ({
      ...prev,
      [stemId]: { volume, muted: prev[stemId]?.muted ?? false },
    }));
    const idx = (stems ?? []).findIndex((s) => s.id === stemId);
    if (djMode) {
      // Ride the stem of the DJ's PLAYING TRACK on the master deck.
      audio.setDeckStem(masterDeckIdx, idx, { gain: volume });
      return;
    }
    audio.setStemVolume(stemId, volume);
    // Native engine addresses stems by index (position in the song's stem list).
    audio.setStemNative(idx, { gain: volume });
  }, [audio, stems, djMode, masterDeckIdx]);

  const handleStemVolumeCommit = useCallback((stemId: number, volume: number) => {
    setMixerSaveStatus("saving");
    updateStemMutation.mutate({ id: stemId, data: { volume } });
  }, [updateStemMutation]);

  const handleStemMute = useCallback((stemId: number) => {
    setMixerSaveStatus("saving");
    setStemOverrides((prev) => {
      const current = prev[stemId];
      const currentMuted = current?.muted ?? stems?.find(s => s.id === stemId)?.muted ?? false;
      const newMuted = !currentMuted;
      const vol = current?.volume ?? stems?.find(s => s.id === stemId)?.volume ?? 1;
      const idx = (stems ?? []).findIndex((s) => s.id === stemId);
      if (djMode) {
        // Mute/unmute a stem of the DJ's playing track — this is the moment the
        // live singer takes the vocal, or the guitarist takes the guitar part.
        audio.setDeckStem(masterDeckIdx, idx, { muted: newMuted, ...(newMuted ? {} : { gain: vol }) });
        return { ...prev, [stemId]: { volume: vol, muted: newMuted } };
      }
      audio.setStemMuted(stemId, newMuted);
      if (!newMuted) audio.setStemVolume(stemId, vol);
      // Native engine: address by index; send mute (and restore gain on unmute).
      audio.setStemNative(idx, { muted: newMuted, ...(newMuted ? {} : { gain: vol }) });
      updateStemMutation.mutate({ id: stemId, data: { muted: newMuted } });
      return { ...prev, [stemId]: { volume: vol, muted: newMuted } };
    });
  }, [audio, stems, updateStemMutation, djMode, masterDeckIdx]);

  // Cycle a stem's output route: MAIN (FOH 1-2) → CLICK (IEM 3-4) → GUIDE (IEM 3-4).
  // Applied LIVE to the native engine (no reload / no playhead reset), persisted
  // to the DB, and reflected in the badge via an optimistic cache update.
  const handleStemRouteCycle = useCallback((stemId: number, currentRoute: "main" | "click" | "guide") => {
    const order: Array<"main" | "click" | "guide"> = ["main", "click", "guide"];
    const next = order[(order.indexOf(currentRoute) + 1) % order.length];

    // Live to the engine (main → FOH, click/guide → IEM).
    const idx = (stems ?? []).findIndex((s) => s.id === stemId);
    audio.setStemNative(idx, { route: next === "main" ? "foh" : "iem" });

    // Update the badge immediately without triggering a reload.
    if (currentSong?.id) {
      utils.stems.bySong.setData({ songId: currentSong.id }, (old) =>
        old?.map((s) => (s.id === stemId ? { ...s, outputRoute: next } : s)),
      );
    }

    setMixerSaveStatus("saving");
    updateStemMutation.mutate({ id: stemId, data: { outputRoute: next } });
  }, [updateStemMutation, utils, currentSong?.id, stems, audio]);

  const getStemVolume = (stemId: number, defaultVol: number) =>
    stemOverrides[stemId]?.volume ?? defaultVol;
  const getStemMuted = (stemId: number, defaultMuted: boolean) =>
    stemOverrides[stemId]?.muted ?? defaultMuted;

  // ── Render ──────────────────────────────────────────────────────────────────

  const isActive = audio.isPlaying || audio.isPaused;

  return (
    <div
      className={`flex flex-col ${fullscreen ? "fixed inset-0 z-50" : "h-full"}`}
      style={{ background: "var(--md-black)" }}
    >
      {/* ── Top bar ── */}
      <div
        className="flex items-center justify-between px-6 py-3 border-b shrink-0"
        style={{ background: "var(--md-surface)", borderColor: "var(--md-border)" }}
      >
        <div className="flex items-center gap-4">
          {/* ← Back button — always visible so the operator can exit */}
          <button
            onClick={() => navigate("/")}
            style={{
              display: "flex", alignItems: "center", gap: 6,
              padding: "5px 12px", borderRadius: 6, cursor: "pointer",
              background: "var(--md-surface-2)", border: "1px solid var(--md-border)",
              color: "var(--md-text)", fontSize: 12, fontWeight: 700,
              letterSpacing: "0.05em",
            }}
          >
            ← BACK
          </button>
          <div className="flex items-center gap-2">
            <Zap size={14} style={{ color: "var(--md-magenta)" }} />
            <span className="text-xs font-bold tracking-widest uppercase" style={{ color: "var(--md-text-dim)" }}>
              Live Screen
            </span>
          </div>

          {/* Set list selector */}
          <select
            value={showMode === "dj" ? "dj" : (selectedSetListId ?? "")}
            onChange={(e) => {
              const v = e.target.value;
              audio.stop();
              setStemOverrides({});
              if (v === "dj") {
                // Follow the DJ: mirror whatever is on the master deck.
                setShowState({ mode: "dj" });
                return;
              }
              setShowState({ mode: "setlist" });
              setSelectedSetListId(v ? parseInt(v) : null);
              setCurrentIndex(0);
            }}
            className="text-xs px-3 py-1.5"
            style={{
              background: "var(--md-surface-2)",
              border: "1px solid var(--md-border)",
              borderRadius: "var(--radius)",
              color: selectedSetListId ? "var(--md-text)" : "var(--md-text-muted)",
            }}
          >
            <option value="">— Select Set List —</option>
            <option value="dj">🎛 DJ DECKS — follow the DJ</option>
            {setLists?.map((sl) => (
              <option key={sl.id} value={sl.id}>{sl.name}</option>
            ))}
          </select>
        </div>

        <div className="flex items-center gap-3">
          {/* Audio status badge */}
          {audio.status === "loading" && (
            <div className="flex items-center gap-1.5 text-xs" style={{ color: "var(--md-yellow)" }}>
              <Loader2 size={11} className="animate-spin" />
              <span className="tracking-wide uppercase">Loading Audio</span>
            </div>
          )}
          {audio.status === "error" && (
            <div className="flex items-center gap-1.5 text-xs" style={{ color: "var(--md-red)" }}>
              <AlertTriangle size={11} />
              <span className="tracking-wide uppercase">Audio Error</span>
            </div>
          )}
          {audio.status === "ready" && !audio.isPlaying && !audio.isPaused && (
            <div className="flex items-center gap-1.5 text-xs" style={{ color: "var(--md-green, #00e676)" }}>
              <Music2 size={11} />
              <span className="tracking-wide uppercase">Ready</span>
            </div>
          )}

          {/* Companion status */}
          <div className={`connection-badge ${socketConnected ? "connected" : "disconnected"}`}>
            {socketConnected ? <Wifi size={10} /> : <WifiOff size={10} />}
            {companionCount > 0 ? `${companionCount} iPad` : socketConnected ? "Ready" : "Offline"}
          </div>

          {/* QR code */}
          <button
            onClick={() => setShowQR(!showQR)}
            className="w-8 h-8 rounded flex items-center justify-center transition-colors"
            style={{ background: "var(--md-surface-2)", color: "var(--md-text-dim)" }}
          >
            <QrCode size={14} />
          </button>

          {/* View mode switcher */}
          <div
            className="flex items-center rounded overflow-hidden"
            style={{ border: "1px solid var(--md-border)", background: "var(--md-surface-2)" }}
          >
            {(["karaoke", "chart", "set"] as const).map((mode) => (
              <button
                key={mode}
                onClick={() => setLyricViewMode(mode)}
                className="text-xs px-3 py-1.5 tracking-widest uppercase transition-colors"
                style={{
                  background: lyricViewMode === mode ? "rgba(0,180,255,0.18)" : "transparent",
                  color: lyricViewMode === mode ? "var(--md-blue)" : "var(--md-text-muted)",
                  borderRight: mode !== "set" ? "1px solid var(--md-border)" : "none",
                }}
              >
                {mode === "karaoke" ? "lyrics" : mode}
              </button>
            ))}
          </div>

          {/* Set Edit button — only when a set list is active */}
          {selectedSetListId && (
            <button
              onClick={() => setShowSetEdit(!showSetEdit)}
              className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded transition-colors"
              style={{
                background: showSetEdit ? "rgba(255,0,200,0.15)" : "var(--md-surface-2)",
                color: showSetEdit ? "var(--md-magenta)" : "var(--md-text-dim)",
                border: `1px solid ${showSetEdit ? "rgba(255,0,200,0.3)" : "var(--md-border)"}`,
              }}
              title="Edit set list order / add requests"
            >
              <ListPlus size={12} />
              SET
            </button>
          )}

          {/* Mixer toggle */}
          <button
            onClick={() => setShowMixer(!showMixer)}
            className="text-xs px-3 py-1.5 rounded transition-colors"
            style={{
              background: showMixer ? "rgba(0,180,255,0.15)" : "var(--md-surface-2)",
              color: showMixer ? "var(--md-blue)" : "var(--md-text-dim)",
              border: `1px solid ${showMixer ? "rgba(0,180,255,0.3)" : "var(--md-border)"}`,
            }}
          >
            MIXER
          </button>

          {/* Fullscreen */}
          <button
            onClick={() => setFullscreen(!fullscreen)}
            className="w-8 h-8 rounded flex items-center justify-center transition-colors"
            style={{ background: "var(--md-surface-2)", color: "var(--md-text-dim)" }}
          >
            {fullscreen ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
          </button>
        </div>
      </div>

      {/* ── QR overlay ── */}
      {showQR && (
        <div
          className="absolute top-16 right-4 z-50 p-5 rounded-lg shadow-2xl"
          style={{ background: "var(--md-surface-2)", border: "1px solid var(--md-border)" }}
        >
          <div className="flex items-center justify-between mb-3">
            <span className="text-xs font-bold tracking-widest uppercase" style={{ color: "var(--md-text-dim)" }}>
              iPad Companion
            </span>
            <button onClick={() => setShowQR(false)}>
              <X size={14} style={{ color: "var(--md-text-muted)" }} />
            </button>
          </div>
          <QRCodeCanvas value={localUrl} size={180} />
          <p className="text-xs text-center mt-3 font-mono" style={{ color: "var(--md-blue)" }}>
            {localUrl}
          </p>
          {companionPin && (
            <p className="text-sm text-center mt-2 font-mono font-bold tracking-[0.4em]"
              style={{ color: "var(--md-text)" }}>
              PIN {companionPin}
            </p>
          )}
          <p className="text-xs text-center mt-1" style={{ color: "var(--md-text-muted)" }}>
            Scan with iPad on same network
          </p>
        </div>
      )}

      {/* ── Set Edit slide-over panel ── */}
      {showSetEdit && selectedSetListId && (
        <div
          className="absolute top-0 right-0 bottom-0 z-40 flex flex-col shadow-2xl"
          style={{
            width: "340px",
            background: "var(--md-surface)",
            borderLeft: "1px solid var(--md-border)",
          }}
        >
          {/* Panel header */}
          <div
            className="flex items-center justify-between px-4 py-3 border-b shrink-0"
            style={{ borderColor: "var(--md-border)" }}
          >
            <div className="flex items-center gap-2">
              <ListPlus size={14} style={{ color: "var(--md-magenta)" }} />
              <span className="text-xs font-bold tracking-widest uppercase" style={{ color: "var(--md-text-dim)" }}>
                Set Edit
              </span>
            </div>
            <button
              onClick={() => setShowSetEdit(false)}
              className="w-6 h-6 flex items-center justify-center rounded opacity-50 hover:opacity-100 transition-opacity"
              style={{ color: "var(--md-text-muted)" }}
            >
              <X size={12} />
            </button>
          </div>

          {/* Current set order */}
          <div className="flex-1 overflow-y-auto px-3 py-2">
            <p className="text-xs tracking-widest uppercase mb-2 px-1" style={{ color: "var(--md-text-muted)" }}>
              Set Order
            </p>
            {liveSetOrder.map((entry, idx) => {
              const isPlaying = idx === currentIndex;
              const isPast = idx < currentIndex;
              return (
                <div
                  key={entry.id}
                  draggable={true}
                  onDragStart={() => handleSetDragStart(idx)}
                  onDragOver={(e) => handleSetDragOver(e, idx)}
                  onDrop={() => handleSetDrop(idx)}
                  onDragLeave={() => setDragOverIdx(null)}
                  className="flex items-center gap-2 px-2 py-2 rounded mb-1 transition-colors"
                  style={{
                    background: isPlaying
                      ? "rgba(255,0,200,0.12)"
                      : dragOverIdx === idx
                      ? "rgba(0,180,255,0.1)"
                      : "transparent",
                    border: isPlaying
                      ? "1px solid rgba(255,0,200,0.3)"
                      : dragOverIdx === idx
                      ? "1px solid rgba(0,180,255,0.3)"
                      : "1px solid transparent",
                    opacity: isPast ? 0.4 : 1,
                    cursor: "grab",
                  }}
                >
                  <GripVertical size={11} style={{ color: isPlaying ? "var(--md-magenta)" : "var(--md-text-muted)", flexShrink: 0 }} />
                  <span
                    className="text-xs flex-1 truncate"
                    style={{ color: isPlaying ? "var(--md-magenta)" : isPast ? "var(--md-text-muted)" : "var(--md-text)" }}
                  >
                    {idx + 1}. {entry.song?.title ?? "Unknown"}
                  </span>
                  {isPlaying && (
                    <span className="text-xs px-1.5 py-0.5 rounded" style={{ background: "rgba(255,0,200,0.2)", color: "var(--md-magenta)", fontSize: "0.55rem", letterSpacing: "0.08em" }}>
                      NOW
                    </span>
                  )}
                </div>
              );
            })}
          </div>

          {/* Quick-add / request section */}
          <div
            className="shrink-0 border-t px-3 py-3"
            style={{ borderColor: "var(--md-border)", background: "var(--md-surface-2)" }}
          >
            <p className="text-xs tracking-widest uppercase mb-2" style={{ color: "var(--md-text-muted)" }}>
              Add Request
            </p>
            <div
              className="flex items-center gap-2 px-3 py-2 rounded mb-2"
              style={{ background: "var(--md-surface-3)", border: "1px solid var(--md-border)" }}
            >
              <Search size={11} style={{ color: "var(--md-text-muted)", flexShrink: 0 }} />
              <input
                type="text"
                placeholder="Search songs…"
                value={setEditSearch}
                onChange={(e) => setSetEditSearch(e.target.value)}
                className="flex-1 bg-transparent text-xs outline-none"
                style={{ color: "var(--md-text)", caretColor: "var(--md-blue)" }}
              />
              {setEditSearch && (
                <button onClick={() => setSetEditSearch("")}>
                  <X size={10} style={{ color: "var(--md-text-muted)" }} />
                </button>
              )}
            </div>
            <div className="max-h-40 overflow-y-auto">
              {(allSongs ?? [])
                .filter((s) =>
                  setEditSearch.length > 0 &&
                  // Exclude songs already in the set to avoid unintended duplicates
                  !liveSetOrder.some((e) => e.songId === s.id) &&
                  (s.title.toLowerCase().includes(setEditSearch.toLowerCase()) ||
                   (s.artist ?? "").toLowerCase().includes(setEditSearch.toLowerCase()))
                )
                .map((song) => (
                  <button
                    key={song.id}
                    onClick={() => {
                      insertAfterMutation.mutate({
                        setListId: selectedSetListId,
                        songId: song.id,
                        afterPosition: currentIndex,
                      });
                    }}
                    disabled={insertAfterMutation.isPending}
                    className="w-full flex items-center gap-2 px-2 py-2 rounded text-left transition-colors hover:bg-white/5 mb-0.5"
                    style={{ color: "var(--md-text)" }}
                  >
                    <Plus size={10} style={{ color: "var(--md-blue)", flexShrink: 0 }} />
                    <span className="text-xs flex-1 truncate">{song.title}</span>
                    {song.artist && (
                      <span className="text-xs shrink-0" style={{ color: "var(--md-text-muted)" }}>{song.artist}</span>
                    )}
                  </button>
                ))}
              {setEditSearch.length > 0 && (allSongs ?? []).filter((s) =>
                !liveSetOrder.some((e) => e.songId === s.id) &&
                (s.title.toLowerCase().includes(setEditSearch.toLowerCase()) ||
                (s.artist ?? "").toLowerCase().includes(setEditSearch.toLowerCase()))
              ).length === 0 && (
                <p className="text-xs text-center py-3" style={{ color: "var(--md-text-muted)" }}>No songs found</p>
              )}
              {setEditSearch.length === 0 && (
                <p className="text-xs text-center py-3" style={{ color: "var(--md-text-muted)" }}>Type to search your library</p>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ── Main content ── */}
      <div className="flex flex-col flex-1 overflow-hidden" style={{ minHeight: 0 }}>
        {/* Center: song display + controls */}
        <div className="flex-1 flex flex-col p-3 pb-1 overflow-hidden">
          {!currentSong ? (
            <div className="flex-1 flex flex-col items-center justify-center text-center">
              <Zap size={32} className="mb-3 opacity-10" />
              <p className="text-base font-bold mb-1" style={{ color: "var(--md-text-dim)" }}>
                Select a set list to begin
              </p>
              <p className="text-sm" style={{ color: "var(--md-text-muted)" }}>
                Choose a set list from the dropdown above
              </p>
            </div>
          ) : (
            <>
              {/* Song info */}
              <div className="mb-6">
                <div className="flex items-start justify-between">
                  <div>
                    <div
                      className="live-title mb-1"
                      style={{
                        color: isFadingOut ? "var(--md-text-muted)" : "var(--md-text)",
                        transition: isFadingOut ? "color 3s ease" : "color 0.2s ease",
                      }}
                    >
                      {currentSong.title}
                    </div>
                    <div className="live-meta flex items-center gap-4">
                      {currentSong.artist && <span>{currentSong.artist}</span>}
                      {currentSong.bpm && (
                        <span style={{ color: "var(--md-blue)" }}>{currentSong.bpm} BPM</span>
                      )}
                      {currentSong.key && (
                        <span
                          className="px-2 py-0.5 rounded text-xs"
                          style={{
                            background: "rgba(0,180,255,0.1)",
                            color: "var(--md-blue)",
                            border: "1px solid rgba(0,180,255,0.2)",
                          }}
                        >
                          {currentSong.key}
                        </span>
                      )}
                      <span style={{ color: "var(--md-text-muted)" }}>
                        {currentIndex + 1} / {totalSongs}
                      </span>
                    </div>
                  </div>

                  {/* Next song cue */}
                  {nextSong && (
                    <div
                      className="text-right p-3 rounded"
                      style={{ background: "var(--md-surface-2)", border: "1px solid var(--md-border)" }}
                    >
                      <div className="text-xs tracking-widest uppercase mb-1" style={{ color: "var(--md-text-muted)" }}>
                        Next
                      </div>
                      <div className="text-sm font-semibold" style={{ color: "var(--md-text-dim)" }}>
                        {nextSong.title}
                      </div>
                      {nextSong.bpm && (
                        <div className="text-xs mt-0.5" style={{ color: "var(--md-text-muted)" }}>
                          {nextSong.bpm} BPM
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </div>

              {djMode ? (
                <>
                <div className="mb-2 p-2 rounded-lg flex items-center justify-between"
                  style={{ border: "1px solid rgba(123,44,207,0.5)", background: "rgba(123,44,207,0.06)" }}>
                  <span className="text-sm font-bold tracking-wide" style={{ color: "#a06bf0" }}>
                    FOLLOWING DJ — DECK {masterDeckIdx + 1}
                  </span>
                  <span className="text-xs" style={{ color: "var(--md-text-muted)" }}>
                    {djDeck.playing ? "PLAYING" : djDeck.loaded ? "cued" : "no track on the master deck"}
                    {djDeck.bpm ? ` · ${djDeck.bpm.toFixed(1)} BPM` : ""}
                  </span>
                </div>
                {/* Other deck — incoming/ready track */}
                {(() => {
                  const otherIdx = masterDeckIdx === 0 ? 1 : 0;
                  const otherDeck = audio.decks[otherIdx];
                  if (!otherDeck.loaded) return null;
                  const otherSongId = audio.deckSongIds?.[otherIdx];
                  const otherSong = allSongsForMarkers?.find((s: { id: number }) => s.id === otherSongId) as { title?: string; artist?: string } | undefined;
                  return (
                    <div className="mb-2 p-2 rounded-lg flex items-center justify-between"
                      style={{ border: "1px solid rgba(0,180,255,0.25)", background: "rgba(0,180,255,0.04)" }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                        <span style={{ fontSize: 9, fontWeight: 700, color: "#00b4ff", letterSpacing: "0.1em" }}>
                          DECK {otherIdx + 1} READY
                        </span>
                        <span style={{ fontSize: 12, fontWeight: 700, color: "rgba(255,255,255,0.85)" }}>
                          {otherSong?.title ?? "Track loaded"}
                        </span>
                        {otherSong?.artist && (
                          <span style={{ fontSize: 10, color: "rgba(255,255,255,0.4)" }}>— {otherSong.artist}</span>
                        )}
                      </div>
                      <span style={{ fontSize: 10, color: "rgba(0,180,255,0.6)" }}>
                        {otherDeck.playing ? "▶ PLAYING" : "⏸ CUED"}
                        {otherDeck.bpm ? ` · ${otherDeck.bpm.toFixed(1)} BPM` : ""}
                      </span>
                    </div>
                  );
                })()}
                </>
              ) : (
                /* Clock authority + band launch (deck controls are on the DJ Decks page) */
                <ClockBar audio={audio} />
              )}

              {/* Upcoming section marker banner */}
              {upcomingMarker && secondsToMarker !== null && (
                <div style={{
                  display: "flex", alignItems: "center", gap: 8, padding: "6px 12px",
                  borderRadius: 6, marginBottom: 6,
                  background: `${upcomingMarker.color ?? "#7B2CF9"}22`,
                  border: `1px solid ${upcomingMarker.color ?? "#7B2CF9"}55`,
                  animation: secondsToMarker < 8 ? "pulse 1s ease-in-out infinite" : "none",
                }}>
                  <div style={{ width: 10, height: 10, borderRadius: "50%", flexShrink: 0,
                    background: upcomingMarker.color ?? "#7B2CF9" }} />
                  <span style={{ fontWeight: 800, color: upcomingMarker.color ?? "#7B2CF9", fontSize: 13 }}>
                    {upcomingMarker.label}
                  </span>
                  {upcomingMarker.note && (
                    <span style={{ flex: 1, fontSize: 11, color: "rgba(255,255,255,0.6)" }}>
                      {upcomingMarker.note}
                    </span>
                  )}
                  <span style={{ fontSize: 11, color: "rgba(255,255,255,0.45)",
                    fontVariantNumeric: "tabular-nums", flexShrink: 0 }}>
                    in {secondsToMarker < 60 ? `${Math.round(secondsToMarker)}s` : formatTime(secondsToMarker)}
                  </span>
                </div>
              )}

              {/* Full waveform overview — band can see breakdowns, drops, outro length */}
              <div className="mb-4">
                {(() => {
                  // Pick the waveform for the relevant deck:
                  // DJ-follow mode → master deck peaks; set-list mode → deck playing the song
                  const peaks = djMode
                    ? (audio.deckWaveforms?.[masterDeckIdx] ?? [])
                    : (audio.deckWaveforms?.[0] ?? audio.deckWaveforms?.[1] ?? []);
                  const hasPeaks = peaks.length > 0;

                  return hasPeaks ? (
                    /* Full waveform — shows structure at a glance */
                    <div className="mb-2">
                      <OverviewWaveform
                        peaks={peaks}
                        duration={duration}
                        seconds={currentTime}
                        playing={djMode ? djDeck.playing : audio.isPlaying}
                        color={djMode ? (masterDeckIdx === 0 ? "#7B2CF9" : "#00b4ff") : "#7B2CF9"}
                        height={56}
                        markers={currentSongMarkers}
                        onSeek={duration > 0 ? (t: number) => {
                          if (djMode) {
                            audio.deckSeek(masterDeckIdx, t);
                          } else {
                            handleProgressClick({ clientX: (t / duration) } as unknown as React.MouseEvent<HTMLDivElement>);
                          }
                        } : undefined}
                      />
                    </div>
                  ) : (
                    /* Fallback slim progress bar when no waveform data yet */
                    <div
                      className="progress-track mb-2 cursor-pointer"
                      onClick={handleProgressClick}
                      title="Click to seek"
                    >
                      <div
                        className="progress-fill"
                        style={{
                          width: `${progress}%`,
                          transition: audio.isPlaying ? "none" : "width 0.2s ease",
                        }}
                      />
                    </div>
                  );
                })()}

                {/* Time display */}
                <div className="flex justify-between">
                  <span className="live-time">{formatTime(currentTime)}</span>
                  <span className="live-time" style={{ color: "var(--md-text-muted)" }}>
                    -{formatTime(Math.max(0, duration - currentTime))}
                  </span>
                </div>
              </div>

              {/* Transport controls */}
              <div className="flex items-center justify-center gap-3 mb-2">
                {/* Prev */}
                <button
                  onClick={handlePrev}
                  disabled={currentIndex === 0}
                  className="w-12 h-12 rounded-full flex items-center justify-center transition-all duration-150 active:scale-95"
                  style={{
                    background: "var(--md-surface-2)",
                    color: currentIndex === 0 ? "var(--md-text-muted)" : "var(--md-text-dim)",
                    border: "1px solid var(--md-border)",
                  }}
                >
                  <SkipBack size={18} />
                </button>

                {/* Restart */}
                <button
                  onClick={handleRestart}
                  className="w-10 h-10 rounded-full flex items-center justify-center transition-all duration-150 active:scale-95"
                  style={{ background: "var(--md-surface-2)", color: "var(--md-text-dim)", border: "1px solid var(--md-border)" }}
                >
                  <RotateCcw size={15} />
                </button>

                {/* Stop */}
                {confirmStop ? (
                  <div className="flex items-center gap-2">
                    <span className="text-xs" style={{ color: "var(--md-yellow)" }}>Confirm stop?</span>
                    <button
                      onClick={handleStop}
                      className="px-3 py-2 rounded text-xs font-bold"
                      style={{ background: "var(--md-red)", color: "#fff" }}
                    >
                      STOP
                    </button>
                    <button
                      onClick={() => setConfirmStop(false)}
                      className="px-3 py-2 rounded text-xs"
                      style={{ background: "var(--md-surface-2)", color: "var(--md-text-dim)" }}
                    >
                      Cancel
                    </button>
                  </div>
                ) : (
                  <button
                    onClick={handleStop}
                    className="w-14 h-14 rounded-full flex items-center justify-center transition-all duration-150 active:scale-95"
                    style={{
                      background: isActive ? "rgba(255,51,85,0.15)" : "var(--md-surface-2)",
                      color: isActive ? "var(--md-red)" : "var(--md-text-muted)",
                      border: `1px solid ${isActive ? "rgba(255,51,85,0.3)" : "var(--md-border)"}`,
                    }}
                  >
                    <Square size={20} />
                  </button>
                )}

                {/* Play / Pause */}
                <button
                  onClick={audio.isPlaying ? handlePause : handlePlay}
                  disabled={audio.status === "loading"}
                  className="w-20 h-20 rounded-full flex items-center justify-center transition-all duration-150 active:scale-95"
                  style={{
                    background: audio.status === "loading"
                      ? "var(--md-surface-2)"
                      : "linear-gradient(135deg, var(--md-blue), #0077cc)",
                    color: audio.status === "loading" ? "var(--md-text-muted)" : "var(--md-black)",
                    boxShadow: audio.isPlaying ? "0 0 30px rgba(0,180,255,0.4)" : "none",
                  }}
                >
                  {audio.status === "loading" ? (
                    <Loader2 size={28} className="animate-spin" style={{ color: "var(--md-blue)" }} />
                  ) : audio.isPlaying && !audio.isPaused ? (
                    <Pause size={32} />
                  ) : (
                    <Play size={32} />
                  )}
                </button>

                {/* Next */}
                {confirmNext ? (
                  <div className="flex items-center gap-2">
                    <span className="text-xs" style={{ color: "var(--md-yellow)" }}>Skip song?</span>
                    <button
                      onClick={handleNext}
                      className="px-3 py-2 rounded text-xs font-bold"
                      style={{ background: "var(--md-blue)", color: "var(--md-black)" }}
                    >
                      SKIP
                    </button>
                    <button
                      onClick={() => setConfirmNext(false)}
                      className="px-3 py-2 rounded text-xs"
                      style={{ background: "var(--md-surface-2)", color: "var(--md-text-dim)" }}
                    >
                      Cancel
                    </button>
                  </div>
                ) : (
                  <button
                    onClick={handleNext}
                    disabled={currentIndex >= totalSongs - 1}
                    className="w-14 h-14 rounded-full flex items-center justify-center transition-all duration-150 active:scale-95"
                    style={{
                      background: "var(--md-surface-2)",
                      color: currentIndex >= totalSongs - 1 ? "var(--md-text-muted)" : "var(--md-text-dim)",
                      border: "1px solid var(--md-border)",
                    }}
                  >
                    <SkipForward size={20} />
                  </button>
                )}

                {/* Emergency fade */}
                <button
                  onClick={handleEmergencyFade}
                  disabled={isFadingOut}
                  className="px-4 py-2 rounded text-xs font-bold tracking-widest uppercase transition-all duration-150 active:scale-95"
                  style={{
                    background: isFadingOut ? "rgba(255,204,0,0.2)" : "rgba(255,51,85,0.1)",
                    color: isFadingOut ? "var(--md-yellow)" : "var(--md-red)",
                    border: `1px solid ${isFadingOut ? "rgba(255,204,0,0.4)" : "rgba(255,51,85,0.3)"}`,
                  }}
                >
                  {isFadingOut ? "Fading…" : "Fade Out"}
                </button>
              </div>

              {/* Audio error message */}
              {audio.status === "error" && audio.error && (
                <div
                  className="flex items-center gap-2 px-4 py-3 rounded mb-4 text-sm"
                  style={{
                    background: "rgba(255,51,85,0.08)",
                    border: "1px solid rgba(255,51,85,0.25)",
                    color: "var(--md-red)",
                  }}
                >
                  <AlertTriangle size={14} />
                  {audio.error}
                </div>
              )}

              {/* Stems with no audio files notice */}
              {audio.status === "idle" && stems && stems.length > 0 && stems.every(s => !s.fileUrl) && (
                <div
                  className="flex items-center gap-2 px-4 py-3 rounded mb-4 text-sm"
                  style={{
                    background: "rgba(255,204,0,0.06)",
                    border: "1px solid rgba(255,204,0,0.2)",
                    color: "var(--md-yellow)",
                  }}
                >
                  <AlertTriangle size={14} />
                  Stems are defined but no audio files have been uploaded yet. Upload files in the Song Editor.
                </div>
              )}


              {/* Lyric panel — view mode switcher */}
              <div className="overflow-hidden rounded flex-1 flex flex-col" style={{ border: "1px solid var(--md-border)" }}>
                {lyricViewMode === "karaoke" && (
                  <KaraokeView
                    cues={lyricCues}
                    currentTime={currentTime}
                    duration={duration || null}
                    songTitle={currentSong.title}
                    artist={currentSong.artist ?? undefined}
                    bpm={currentSong.bpm}
                    songKey={currentSong.key}
                    nextSongTitle={nextSong?.title}
                    nextSongBpm={nextSong?.bpm}
                    nextSongKey={nextSong?.key}
                    isPlaying={audio.isPlaying}
                  />
                )}
                {lyricViewMode === "chart" && (
                  <div
                    className="flex-1 overflow-y-auto p-4"
                    ref={lyricsRef}
                    style={{ background: "var(--md-surface)" }}
                  >
                    {lyricsRaw ? (
                      <div className="lyrics-panel">
                        {lyricsSections.map((section, sIdx) => (
                          <div key={sIdx} data-section={sIdx} className="mb-4">
                            {section.label && <div className="section-header">{section.label}</div>}
                            {section.lines.map((line, lIdx) => {
                              const trimmed = line.trim();
                              const isChord = CHORD_RE.test(trimmed) && trimmed.length < 20;
                              return (
                                <div key={lIdx} className={isChord ? "chord" : sIdx === activeSectionIdx ? "active-line" : ""}>
                                  {line || "\u00A0"}
                                </div>
                              );
                            })}
                          </div>
                        ))}
                      </div>
                    ) : (
                      <div className="flex items-center justify-center h-full text-xs" style={{ color: "var(--md-text-muted)" }}>
                        No chart lyrics for this song
                      </div>
                    )}
                  </div>
                )}
                {lyricViewMode === "set" && (
                  <div className="h-full flex flex-col p-6 gap-6" style={{ background: "var(--md-surface)" }}>
                    {/* Current song block */}
                    <div className="flex-1 flex flex-col items-center justify-center text-center gap-3">
                      <div className="text-xs tracking-widest uppercase" style={{ color: "var(--md-text-muted)" }}>NOW PLAYING</div>
                      <div className="text-3xl font-bold" style={{ color: "var(--md-text)", fontFamily: "var(--md-font-mono)" }}>{currentSong.title}</div>
                      <div className="flex items-center gap-4">
                        {currentSong.key && <span className="text-xl font-bold" style={{ color: "var(--md-magenta)" }}>{currentSong.key}</span>}
                        {currentSong.bpm && <span className="text-xl" style={{ color: "var(--md-blue)" }}>{currentSong.bpm} BPM</span>}
                      </div>
                      {/* Active lyric line */}
                      {activeCueIndex >= 0 && lyricCues[activeCueIndex] && !lyricCues[activeCueIndex].isSection && (
                        <div className="text-lg mt-2" style={{ color: "var(--md-text-dim)", fontFamily: "var(--md-font-mono)" }}>
                          {lyricCues[activeCueIndex].text}
                        </div>
                      )}
                    </div>
                    {/* Next song block */}
                    {nextSong && (
                      <div
                        className="flex items-center justify-between px-5 py-4 rounded"
                        style={{ background: "var(--md-surface-2)", border: "1px solid var(--md-border)" }}
                      >
                        <div className="text-xs tracking-widest uppercase" style={{ color: "var(--md-text-muted)" }}>NEXT</div>
                        <div className="text-lg font-bold" style={{ color: "var(--md-text-dim)", fontFamily: "var(--md-font-mono)" }}>{nextSong.title}</div>
                        <div className="flex items-center gap-3">
                          {nextSong.key && <span className="font-bold" style={{ color: "var(--md-magenta)" }}>{nextSong.key}</span>}
                          {nextSong.bpm && <span style={{ color: "var(--md-text-muted)" }}>{nextSong.bpm} BPM</span>}
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            </>
          )}
        </div>

        {/* ── Bottom: Horizontal Mixer strip ── */}
        {showMixer && (
          <div
            className="shrink-0 border-t"
            style={{
              background: "var(--md-surface)",
              borderColor: "var(--md-border)",
              overflow: "hidden",
            }}
          >
            {/* Mixer header bar */}
            <div
              className="flex items-center justify-between px-4 py-2 border-b"
              style={{ borderColor: "var(--md-border)" }}
            >
              <div className="flex items-center gap-3">
                <h3 className="text-xs font-bold tracking-widest uppercase" style={{ color: "var(--md-text-dim)" }}>
                  {(!stems || stems.length === 0) && currentSong?.audioFileUrl ? "Mixer" : "Stem Mixer"}
                </h3>
                {audio.status === "loading" && (
                  <div className="flex items-center gap-1.5 text-xs" style={{ color: "var(--md-yellow)" }}>
                    <Loader2 size={10} className="animate-spin" />
                    Decoding audio…
                  </div>
                )}
                {audio.status === "ready" && stems && stems.length > 0 && (
                  <span className="text-xs" style={{ color: "var(--md-text-muted)" }}>
                    {stems.filter(s => s.fileUrl).length} / {stems.length} stems loaded
                  </span>
                )}
                {audio.status === "ready" && (!stems || stems.length === 0) && currentSong?.audioFileUrl && (
                  <span className="text-xs" style={{ color: "var(--md-text-muted)" }}>
                    Stereo backing track
                  </span>
                )}
                {/* Mixer save status indicator */}
                {mixerSaveStatus === "saving" && (
                  <span className="flex items-center gap-1 text-xs" style={{ color: "var(--md-text-muted)", fontFamily: "var(--md-font-mono)" }}>
                    <Loader2 size={9} className="animate-spin" /> saving…
                  </span>
                )}
                {mixerSaveStatus === "saved" && (
                  <span className="text-xs" style={{ color: "#00e676", fontFamily: "var(--md-font-mono)" }}>
                    ✓ saved
                  </span>
                )}
                {mixerSaveStatus === "error" && (
                  <span className="text-xs" style={{ color: "var(--md-red)", fontFamily: "var(--md-font-mono)" }}>
                    ⚠ save failed
                  </span>
                )}
              </div>
              <button
                onClick={() => setShowMixer(false)}
                className="w-6 h-6 flex items-center justify-center rounded opacity-50 hover:opacity-100 transition-opacity"
                style={{ color: "var(--md-text-muted)" }}
              >
                <X size={12} />
              </button>
            </div>

            {/* Channel strips — vertical layout, horizontally scrollable */}
            <div className="flex overflow-x-auto px-3 py-3 gap-2" style={{ minHeight: "180px" }}>
              {!stems || stems.length === 0 ? (
                currentSong?.audioFileUrl ? (
                  // Backing track mode — single master channel
                  <div className="stem-channel shrink-0" style={{ width: "80px" }}>
                    {/* Channel name */}
                    <span className="text-xs font-semibold text-center w-full truncate" style={{ color: "var(--md-text)" }} title="Backing Track">
                      Backing
                    </span>
                    {/* Route badge */}
                    <span className="text-xs px-1 py-0.5 rounded" style={{ background: "rgba(0,180,255,0.1)", color: "var(--md-blue)", fontSize: "0.55rem", letterSpacing: "0.05em" }}>
                      MAIN
                    </span>
                    {/* Peak meter */}
                    <div className="w-full h-1.5 rounded-full overflow-hidden" style={{ background: "var(--md-surface-3)" }}>
                      <div className="h-full rounded-full" style={{ width: audio.isPlaying && !btMuted ? "70%" : "0%", background: "var(--md-blue)", transition: "width 0.15s ease" }} />
                    </div>
                    {/* Vertical fader */}
                    <div className="flex flex-col items-center" style={{ height: "60px" }}>
                      <input
                        type="range" min="0" max="2" step="0.01"
                        value={btVol}
                        className="fader-vertical"
                        style={{ height: "80px", accentColor: "var(--md-blue)" }}
                        onChange={(e) => { const v = parseFloat(e.target.value); setBtVol(v); audio.setStemVolume(-1, v); }}
                      />
                    </div>
                    {/* Volume value */}
                    <span className="text-xs tabular-nums" style={{ color: "var(--md-text-muted)" }}>{Math.round(btVol * 100)}%</span>
                    {/* Mute button */}
                    <button
                      className={`mute-btn ${btMuted ? "active" : "inactive"}`}
                      onClick={() => { const m = !btMuted; setBtMuted(m); audio.setStemVolume(-1, m ? 0 : btVol); }}
                      title="Mute backing track"
                    >
                      M
                    </button>
                  </div>
                ) : (
                  <div className="flex items-center justify-center w-full text-xs" style={{ color: "var(--md-text-muted)" }}>
                    No audio loaded for this song
                  </div>
                )
              ) : (
                stems.map((stem) => {
                  const vol = getStemVolume(stem.id, stem.volume);
                  const muted = getStemMuted(stem.id, stem.muted);
                  const hasFile = !!stem.fileUrl;
                  const routeColor =
                    stem.outputRoute === "main" ? "var(--md-blue)"
                    : stem.outputRoute === "click" ? "var(--md-yellow)"
                    : "var(--md-magenta)";
                  const routeBg =
                    stem.outputRoute === "main" ? "rgba(0,180,255,0.1)"
                    : stem.outputRoute === "click" ? "rgba(255,204,0,0.1)"
                    : "rgba(255,45,120,0.1)";

                  return (
                    <div
                      key={stem.id}
                      className={`stem-channel shrink-0 ${muted ? "muted" : ""}`}
                      style={{
                        width: "80px",
                        border: `1px solid ${muted ? "rgba(255,51,85,0.3)" : "var(--md-border)"}`,
                      }}
                    >
                      {/* Channel name */}
                      <span
                        className="text-xs font-semibold text-center w-full truncate"
                        style={{ color: "var(--md-text)" }}
                        title={stem.name}
                      >
                        {stem.name}
                      </span>

                      {/* Route badge — click to cycle MAIN → CLICK → GUIDE */}
                      <button
                        type="button"
                        onClick={() => handleStemRouteCycle(stem.id, stem.outputRoute)}
                        className="text-xs px-1 py-0.5 rounded cursor-pointer transition-opacity hover:opacity-80"
                        style={{ background: routeBg, color: routeColor, fontSize: "0.55rem", letterSpacing: "0.05em", border: "none" }}
                        title="Click to change output: MAIN = front of house (1-2), CLICK/GUIDE = in-ears (3-4)"
                      >
                        {stem.outputRoute.toUpperCase()}
                      </button>

                      {/* Peak meter — thin vertical bar */}
                      <div className="w-full h-1.5 rounded-full overflow-hidden" style={{ background: "var(--md-surface-3)" }}>
                        <div
                          className="h-full rounded-full"
                          style={{
                            width: muted || !audio.isPlaying ? "0%" : `${Math.min(vol * 50, 100)}%`,
                            background: vol > 1.5 ? "var(--md-red)" : vol > 1.0 ? "var(--md-yellow)" : routeColor,
                            transition: audio.isPlaying ? "width 0.08s ease" : "width 0.3s ease",
                          }}
                        />
                      </div>

                      {/* Vertical fader */}
                      <div className="flex flex-col items-center" style={{ height: "60px" }}>
                        <input
                          type="range"
                          min="0"
                          max="2"
                          step="0.01"
                          value={vol}
                          className="fader-vertical"
                          style={{ height: "60px", accentColor: routeColor, opacity: hasFile ? 1 : 0.3 }}
                          disabled={!hasFile}
                          title={`${stem.name}: ${Math.round(vol * 100)}%`}
                          onChange={(e) => handleStemVolume(stem.id, parseFloat(e.target.value))}
                          onMouseUp={(e) => handleStemVolumeCommit(stem.id, parseFloat((e.target as HTMLInputElement).value))}
                          onTouchEnd={(e) => handleStemVolumeCommit(stem.id, parseFloat((e.target as HTMLInputElement).value))}
                        />
                      </div>

                      {/* Volume value */}
                      <span className="text-xs tabular-nums" style={{ color: "var(--md-text-muted)" }}>
                        {Math.round(vol * 100)}%
                      </span>

                      {/* Mute button — red M */}
                      <button
                        className={`mute-btn ${muted ? "active" : "inactive"}`}
                        onClick={() => handleStemMute(stem.id)}
                        title={muted ? `Unmute ${stem.name}` : `Mute ${stem.name}`}
                      >
                        M
                      </button>
                    </div>
                  );
                })
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
