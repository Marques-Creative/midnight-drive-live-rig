import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useLocation } from "wouter";
import StemFolderImport from "@/components/StemFolderImport";
import { trpc } from "@/lib/trpc";
import { toast } from "sonner";
import {
  Plus, Search, Music2, Trash2, Edit2, Clock, Gauge,
  GripVertical, ListMusic, CheckCircle2, ArrowRight,
  Upload, Loader2, FileAudio,
} from "lucide-react";

// ── helpers ──────────────────────────────────────────────────────────────────

function formatDuration(seconds: number | null | undefined) {
  if (!seconds) return null;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

/** Derive a human-friendly song title from a raw filename */
function titleFromFilename(name: string): string {
  return name
    .replace(/\.[^.]+$/, "")           // strip extension
    .replace(/[_-]+/g, " ")            // underscores / hyphens → spaces
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (c) => c.toUpperCase()); // title-case
}

const ACCEPTED_AUDIO = ["audio/mpeg", "audio/mp3", "audio/wav", "audio/wave",
  "audio/x-wav", "audio/aiff", "audio/x-aiff", "audio/flac", "audio/ogg",
  "audio/mp4", "audio/m4a", "audio/x-m4a", "audio/aac"];

function isAudioFile(file: File) {
  return ACCEPTED_AUDIO.includes(file.type) || /\.(mp3|wav|aiff|flac|ogg|m4a|aac)$/i.test(file.name);
}

// ── component ─────────────────────────────────────────────────────────────────

export default function SongLibrary() {
  const [, navigate] = useLocation();
  const [search, setSearch] = useState("");

  // song-row → set-list drag state
  const [draggingSongId, setDraggingSongId] = useState<number | null>(null);
  const [dropTargetId, setDropTargetId] = useState<number | null>(null);
  const [justAdded, setJustAdded] = useState<string | null>(null);
  const dragSongRef = useRef<number | null>(null);

  // file-import drag state
  const [fileDragOver, setFileDragOver] = useState(false);
  const [importing, setImporting] = useState(false);
  const [importProgress, setImportProgress] = useState<string | null>(null);
  const fileDragCounter = useRef(0); // track nested drag-enter/leave events
  const fileInputRef = useRef<HTMLInputElement>(null);

  const utils = trpc.useUtils();
  const { data: songs, isLoading } = trpc.songs.list.useQuery();
  const { data: setLists } = trpc.setLists.list.useQuery();

  const createSongMutation = trpc.songs.create.useMutation();

  const deleteMutation = trpc.songs.delete.useMutation({
    onSuccess: () => { utils.songs.list.invalidate(); toast.success("Song deleted"); },
    onError: () => toast.error("Failed to delete song"),
  });

  const addToSetList = trpc.setLists.addSong.useMutation({
    onSuccess: (_data, variables) => {
      utils.setLists.byId.invalidate({ id: variables.setListId });
      const song = songs?.find((s) => s.id === variables.songId);
      const sl = setLists?.find((sl) => sl.id === variables.setListId);
      toast.success(`"${song?.title}" added to "${sl?.name}"`);
      const key = `${variables.songId}-${variables.setListId}`;
      setJustAdded(key);
      setTimeout(() => setJustAdded(null), 1800);
    },
    onError: () => toast.error("Failed to add song to set list"),
  });

  const filtered = (songs ?? []).filter((s) =>
    s.title.toLowerCase().includes(search.toLowerCase()) ||
    (s.artist ?? "").toLowerCase().includes(search.toLowerCase()) ||
    (s.tags ?? "").toLowerCase().includes(search.toLowerCase())
  );

  const hasSongs = (songs ?? []).length > 0;
  const hasSetLists = (setLists ?? []).length > 0;

  // ── file import logic ──────────────────────────────────────────────────────

  const importFiles = useCallback(async (files: File[]) => {
    const audioFiles = files.filter(isAudioFile);
    if (!audioFiles.length) {
      toast.error("Please drop audio files (MP3, WAV, AIFF, FLAC, M4A…)");
      return;
    }

    setImporting(true);

    for (let i = 0; i < audioFiles.length; i++) {
      const file = audioFiles[i];
      const title = titleFromFilename(file.name);

      if (audioFiles.length > 1) {
        setImportProgress(`Importing ${i + 1} / ${audioFiles.length}: ${title}`);
      } else {
        setImportProgress(`Creating "${title}"…`);
      }

      try {
        // 1. Create the song record
        const created: any = await createSongMutation.mutateAsync({ title });
        const songId: number = created?.id ?? created?.insertId;
        if (!songId) throw new Error("No song ID returned");

        // 2. Upload via multipart to local storage
        setImportProgress(`Uploading audio for "${title}"…`);
        const formData = new FormData();
        formData.append("audio", file);
        formData.append("songId", String(songId));
        formData.append("fileName", file.name);
        const putResp = await fetch("/api/upload/backing", { method: "POST", body: formData });
        if (!putResp.ok) throw new Error(`Upload failed (${putResp.status})`);

        await utils.songs.list.invalidate();

        // 3. If only one file, navigate straight to the editor
        if (audioFiles.length === 1) {
          toast.success(`"${title}" added — fill in the details below`);
          navigate(`/songs/${songId}`);
          return;
        }

        toast.success(`"${title}" imported`);
      } catch (err) {
        console.error(err);
        toast.error(`Failed to import "${title}"`);
      }
    }

    // Multiple files: stay on library, refresh list
    await utils.songs.list.invalidate();
    setImporting(false);
    setImportProgress(null);
    toast.success(`${audioFiles.length} songs imported — tap any to edit`);
  }, [createSongMutation, utils, navigate]);

  // ── page-level drag-and-drop for FILES (not song rows) ────────────────────

  useEffect(() => {
    const onDragEnter = (e: DragEvent) => {
      if (!e.dataTransfer?.types.includes("Files")) return;
      fileDragCounter.current += 1;
      setFileDragOver(true);
    };
    const onDragLeave = (e: DragEvent) => {
      if (!e.dataTransfer?.types.includes("Files")) return;
      fileDragCounter.current -= 1;
      if (fileDragCounter.current <= 0) {
        fileDragCounter.current = 0;
        setFileDragOver(false);
      }
    };
    const onDragOver = (e: DragEvent) => {
      if (!e.dataTransfer?.types.includes("Files")) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
    };
    const onDrop = (e: DragEvent) => {
      e.preventDefault();
      fileDragCounter.current = 0;
      setFileDragOver(false);
      const files = Array.from(e.dataTransfer?.files ?? []);
      if (files.length) importFiles(files);
    };

    window.addEventListener("dragenter", onDragEnter);
    window.addEventListener("dragleave", onDragLeave);
    window.addEventListener("dragover", onDragOver);
    window.addEventListener("drop", onDrop);
    return () => {
      window.removeEventListener("dragenter", onDragEnter);
      window.removeEventListener("dragleave", onDragLeave);
      window.removeEventListener("dragover", onDragOver);
      window.removeEventListener("drop", onDrop);
    };
  }, [importFiles]);

  // ── song-row drag (to set list) ───────────────────────────────────────────

  function handleSongDragStart(e: React.DragEvent, songId: number) {
    dragSongRef.current = songId;
    setDraggingSongId(songId);
    e.dataTransfer.effectAllowed = "copy";
    e.dataTransfer.setData("text/plain", String(songId));
  }

  function handleSongDragEnd() {
    dragSongRef.current = null;
    setDraggingSongId(null);
    setDropTargetId(null);
  }

  function handleSetListDragOver(e: React.DragEvent, setListId: number) {
    // Only handle song-row drags (text/plain), not file drags
    if (e.dataTransfer.types.includes("Files")) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
    setDropTargetId(setListId);
  }

  function handleSetListDrop(e: React.DragEvent, setListId: number) {
    if (e.dataTransfer.types.includes("Files")) return;
    e.preventDefault();
    const songId = dragSongRef.current ?? Number(e.dataTransfer.getData("text/plain"));
    if (!songId) return;
    addToSetList.mutate({ setListId, songId, position: 999 });
    setDropTargetId(null);
    setDraggingSongId(null);
  }

  // ── render ─────────────────────────────────────────────────────────────────

  return (
    <div className="h-full flex flex-col relative" style={{ minHeight: 0 }}>
      {/* Folder import: drop a stem folder to create a track in one step */}
      <div className="px-6 pt-4 shrink-0">
        <StemFolderImport />
      </div>

      {/* ── Full-page file drop overlay ─────────────────────────────────────── */}
      {fileDragOver && !importing && (
        <div
          className="absolute inset-0 z-50 flex flex-col items-center justify-center pointer-events-none"
          style={{
            background: "rgba(0,0,0,0.85)",
            border: "3px solid var(--md-blue)",
            borderRadius: "12px",
            boxShadow: "inset 0 0 60px rgba(0,212,255,0.15), 0 0 40px rgba(0,212,255,0.3)",
          }}
        >
          <div
            className="w-24 h-24 rounded-full flex items-center justify-center mb-6"
            style={{ background: "rgba(0,212,255,0.12)", border: "2px solid var(--md-blue)" }}
          >
            <FileAudio size={44} style={{ color: "var(--md-blue)" }} />
          </div>
          <p className="text-2xl font-bold tracking-tight mb-2" style={{ color: "var(--md-blue)", fontFamily: "var(--font-mono)" }}>
            Drop to Import
          </p>
          <p className="text-sm" style={{ color: "var(--md-text-dim)" }}>
            MP3 · WAV · AIFF · FLAC · M4A
          </p>
        </div>
      )}

      {/* ── Import progress overlay ─────────────────────────────────────────── */}
      {importing && (
        <div
          className="absolute inset-0 z-50 flex flex-col items-center justify-center"
          style={{ background: "rgba(0,0,0,0.88)" }}
        >
          <Loader2 size={44} className="animate-spin mb-5" style={{ color: "var(--md-blue)" }} />
          <p className="text-base font-semibold" style={{ color: "var(--md-text)", fontFamily: "var(--font-mono)" }}>
            {importProgress ?? "Importing…"}
          </p>
          <p className="text-xs mt-2" style={{ color: "var(--md-text-muted)" }}>
            You'll be taken to the editor when done
          </p>
        </div>
      )}

      {/* ── Top bar ─────────────────────────────────────────────────────────── */}
      <div
        className="flex items-center justify-between px-8 py-5 shrink-0"
        style={{ borderBottom: "1px solid var(--md-border)" }}
      >
        <div className="flex items-center gap-3">
          <div
            className="w-2 h-8 rounded-full"
            style={{ background: "linear-gradient(180deg, var(--md-blue), var(--md-magenta))" }}
          />
          <div>
            <h1 className="text-2xl font-bold tracking-tight" style={{ color: "var(--md-text)" }}>
              Song Library
            </h1>
            <p className="text-xs tracking-widest uppercase" style={{ color: "var(--md-text-dim)" }}>
              {songs?.length ?? 0} songs
            </p>
          </div>
        </div>

        {/* Action buttons */}
        <div className="flex items-center gap-2">
          {/* Hidden file input for click-to-import */}
          <input
            ref={fileInputRef}
            type="file"
            accept="audio/*"
            multiple
            className="hidden"
            onChange={(e) => {
              const files = Array.from(e.target.files ?? []);
              if (files.length) importFiles(files);
              e.target.value = "";
            }}
          />
          <button
            className="btn-stage flex items-center gap-2 text-sm"
            style={{ border: "1px solid var(--md-border)", color: "var(--md-text-dim)" }}
            onClick={() => fileInputRef.current?.click()}
          >
            <Upload size={14} />
            Import Audio
          </button>
          <Link href="/songs/new">
            <button className="btn-stage btn-primary flex items-center gap-2">
              <Plus size={15} />
              New Song
            </button>
          </Link>
        </div>
      </div>

      {/* ── Split panel body ─────────────────────────────────────────────────── */}
      <div className="flex flex-1 overflow-hidden">

        {/* LEFT — Song list ─────────────────────────────────────────────────── */}
        <div className="flex flex-col flex-1 overflow-hidden" style={{ borderRight: "1px solid var(--md-border)" }}>

          {/* Search + hint */}
          <div className="px-6 py-4 shrink-0" style={{ borderBottom: "1px solid var(--md-border)" }}>
            <div className="relative">
              <Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2" style={{ color: "var(--md-text-muted)" }} />
              <input
                type="text"
                placeholder="Search songs, artists, tags…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="w-full pl-9 pr-4 py-2 text-sm"
                style={{
                  background: "var(--md-surface-2)",
                  border: "1px solid var(--md-border)",
                  borderRadius: "var(--radius)",
                  color: "var(--md-text)",
                }}
              />
            </div>
            {hasSongs && hasSetLists && (
              <p className="text-xs mt-2 flex items-center gap-1" style={{ color: "var(--md-text-muted)" }}>
                <GripVertical size={11} className="opacity-60" />
                Drag a song onto a set list on the right to add it
                <ArrowRight size={11} className="ml-1 opacity-60" />
              </p>
            )}
          </div>

          {/* Song rows */}
          <div className="flex-1 overflow-y-auto px-6 py-4 space-y-2">
            {isLoading ? (
              [1, 2, 3].map((i) => (
                <div key={i} className="h-16 rounded animate-pulse" style={{ background: "var(--md-surface-2)" }} />
              ))
            ) : filtered.length === 0 ? (
              /* ── Empty state: prominent drop zone ─────────────────────────── */
              <div
                className="flex flex-col items-center justify-center py-16 px-8 rounded-xl mt-4 cursor-pointer transition-all duration-200 select-none"
                style={{
                  border: "2px dashed var(--md-border)",
                  background: "var(--md-surface-2)",
                  minHeight: "320px",
                }}
                onClick={() => fileInputRef.current?.click()}
              >
                <div
                  className="w-20 h-20 rounded-full flex items-center justify-center mb-5"
                  style={{ background: "rgba(0,212,255,0.07)", border: "1px solid rgba(0,212,255,0.2)" }}
                >
                  <FileAudio size={36} style={{ color: "var(--md-blue)" }} />
                </div>
                <p className="text-lg font-bold mb-2" style={{ color: "var(--md-text)", fontFamily: "var(--font-mono)" }}>
                  Drop audio files here
                </p>
                <p className="text-sm text-center mb-1" style={{ color: "var(--md-text-dim)" }}>
                  Drag MP3, WAV, AIFF, FLAC or M4A files from Finder
                </p>
                <p className="text-xs mb-6" style={{ color: "var(--md-text-muted)" }}>
                  A song is created instantly — edit the details after
                </p>
                <button
                  className="btn-stage btn-primary flex items-center gap-2 text-sm"
                  onClick={(e) => { e.stopPropagation(); fileInputRef.current?.click(); }}
                >
                  <Upload size={14} />
                  Browse Files
                </button>
                <p className="text-xs mt-5" style={{ color: "var(--md-text-muted)" }}>
                  or{" "}
                  <Link href="/songs/new">
                    <span className="underline cursor-pointer" style={{ color: "var(--md-blue)" }}>
                      create a song manually
                    </span>
                  </Link>
                </p>
              </div>
            ) : (
              <>
                {/* ── Persistent drop hint strip (when songs exist) ────────── */}
                <div
                  className="flex items-center gap-3 px-4 py-3 rounded-lg mb-1 cursor-pointer transition-all duration-150 select-none"
                  style={{
                    border: "1px dashed var(--md-border)",
                    background: "transparent",
                    color: "var(--md-text-muted)",
                  }}
                  onClick={() => fileInputRef.current?.click()}
                  onMouseEnter={(e) => {
                    (e.currentTarget as HTMLElement).style.borderColor = "rgba(0,212,255,0.5)";
                    (e.currentTarget as HTMLElement).style.background = "rgba(0,212,255,0.04)";
                  }}
                  onMouseLeave={(e) => {
                    (e.currentTarget as HTMLElement).style.borderColor = "var(--md-border)";
                    (e.currentTarget as HTMLElement).style.background = "transparent";
                  }}
                >
                  <Upload size={14} className="shrink-0 opacity-50" />
                  <span className="text-xs">Drop audio files here or click to browse — song is created instantly</span>
                </div>

                {/* ── Song rows ─────────────────────────────────────────────── */}
                {filtered.map((song) => {
                  const isDragging = draggingSongId === song.id;
                  return (
                    <div
                      key={song.id}
                      draggable
                      onDragStart={(e) => handleSongDragStart(e, song.id)}
                      onDragEnd={handleSongDragEnd}
                      className="md-card flex items-center gap-3 px-4 py-3 transition-all duration-150 group cursor-grab active:cursor-grabbing"
                      style={{
                        opacity: isDragging ? 0.4 : 1,
                        transform: isDragging ? "scale(0.97)" : "scale(1)",
                        outline: isDragging ? "2px solid var(--md-blue)" : "none",
                      }}
                    >
                      <GripVertical size={15} className="shrink-0 opacity-20 group-hover:opacity-60 transition-opacity" style={{ color: "var(--md-text-muted)" }} />

                      <div
                        className="w-1 h-9 rounded-full shrink-0"
                        style={{ background: "linear-gradient(180deg, var(--md-blue), var(--md-magenta))" }}
                      />

                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="font-semibold text-sm truncate" style={{ color: "var(--md-text)" }}>
                            {song.title}
                          </span>
                          {song.key && (
                            <span className="text-xs px-1.5 py-0.5 rounded shrink-0" style={{ background: "rgba(0,180,255,0.1)", color: "var(--md-blue)", border: "1px solid rgba(0,180,255,0.2)" }}>
                              {song.key}
                            </span>
                          )}
                        </div>
                        <div className="flex items-center gap-3 mt-0.5">
                          {song.artist && <span className="text-xs truncate" style={{ color: "var(--md-text-dim)" }}>{song.artist}</span>}
                          {song.bpm && (
                            <span className="flex items-center gap-1 text-xs shrink-0" style={{ color: "var(--md-text-muted)" }}>
                              <Gauge size={9} />{song.bpm}
                            </span>
                          )}
                          {song.duration && (
                            <span className="flex items-center gap-1 text-xs shrink-0" style={{ color: "var(--md-text-muted)" }}>
                              <Clock size={9} />{formatDuration(song.duration)}
                            </span>
                          )}
                          {/* Badge: audio attached */}
                          {song.audioFileKey && (
                            <span className="flex items-center gap-1 text-xs shrink-0" style={{ color: "rgba(0,212,255,0.5)" }}>
                              <Music2 size={9} /> audio
                            </span>
                          )}
                        </div>
                      </div>

                      {/* Actions */}
                      <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
                        <Link href={`/songs/${song.id}`}>
                          <button className="w-7 h-7 rounded flex items-center justify-center" style={{ background: "var(--md-surface-3)", color: "var(--md-text-dim)" }}>
                            <Edit2 size={12} />
                          </button>
                        </Link>
                        <button
                          className="w-7 h-7 rounded flex items-center justify-center hover:bg-red-900/30"
                          style={{ background: "var(--md-surface-3)", color: "var(--md-text-muted)" }}
                          onClick={() => { if (confirm(`Delete "${song.title}"?`)) deleteMutation.mutate({ id: song.id }); }}
                        >
                          <Trash2 size={12} />
                        </button>
                      </div>
                    </div>
                  );
                })}
              </>
            )}
          </div>
        </div>

        {/* RIGHT — Set list drop targets ────────────────────────────────────── */}
        <div className="flex flex-col shrink-0 overflow-y-auto" style={{ width: "280px" }}>
          <div className="px-5 py-4 shrink-0" style={{ borderBottom: "1px solid var(--md-border)" }}>
            <div className="flex items-center justify-between">
              <span className="text-xs tracking-widest uppercase font-semibold" style={{ color: "var(--md-text-dim)" }}>
                Set Lists
              </span>
              <Link href="/setlists">
                <button className="text-xs" style={{ color: "var(--md-blue)" }}>Manage</button>
              </Link>
            </div>
            {hasSongs && hasSetLists && (
              <p className="text-xs mt-1.5" style={{ color: "var(--md-text-muted)" }}>
                Drop songs here to add them
              </p>
            )}
          </div>

          <div className="flex-1 p-4 space-y-3">
            {!hasSetLists ? (
              <div className="text-center py-12 px-4">
                <ListMusic size={32} className="mx-auto mb-3 opacity-10" />
                <p className="text-xs mb-3" style={{ color: "var(--md-text-muted)" }}>
                  No set lists yet
                </p>
                <Link href="/setlists">
                  <button className="btn-stage text-xs px-3 py-1.5 flex items-center gap-1.5 mx-auto" style={{ border: "1px solid var(--md-border)", color: "var(--md-text-dim)" }}>
                    <Plus size={12} />
                    Create Set List
                  </button>
                </Link>
              </div>
            ) : (
              (setLists ?? []).map((sl) => {
                const isTarget = dropTargetId === sl.id;
                const isDraggingAny = draggingSongId !== null;
                return (
                  <div
                    key={sl.id}
                    onDragOver={(e) => handleSetListDragOver(e, sl.id)}
                    onDragLeave={() => setDropTargetId(null)}
                    onDrop={(e) => handleSetListDrop(e, sl.id)}
                    className="rounded-lg p-4 transition-all duration-150 select-none"
                    style={{
                      background: isTarget
                        ? "rgba(0,180,255,0.15)"
                        : isDraggingAny
                        ? "rgba(0,180,255,0.05)"
                        : "var(--md-surface-2)",
                      border: `2px dashed ${
                        isTarget
                          ? "var(--md-blue)"
                          : isDraggingAny
                          ? "rgba(0,180,255,0.5)"
                          : "var(--md-border)"
                      }`,
                      boxShadow: isTarget ? "0 0 20px rgba(0,180,255,0.3)" : "none",
                      transform: isTarget ? "scale(1.02)" : "scale(1)",
                      cursor: isDraggingAny ? "copy" : "default",
                    }}
                  >
                    <div className="flex items-center gap-2 mb-1">
                      <ListMusic
                        size={14}
                        style={{ color: isTarget ? "var(--md-blue)" : isDraggingAny ? "rgba(0,180,255,0.7)" : "var(--md-text-dim)" }}
                      />
                      <span
                        className="text-sm font-semibold truncate"
                        style={{ color: isTarget ? "var(--md-blue)" : "var(--md-text)" }}
                      >
                        {sl.name}
                      </span>
                    </div>
                    {isTarget ? (
                      <p className="text-xs font-medium" style={{ color: "var(--md-blue)" }}>
                        ↓ Release to add
                      </p>
                    ) : isDraggingAny ? (
                      <p className="text-xs" style={{ color: "rgba(0,180,255,0.6)" }}>
                        Drop song here
                      </p>
                    ) : (
                      <p className="text-xs" style={{ color: "var(--md-text-muted)" }}>
                        {sl.description || "Drag songs here"}
                      </p>
                    )}

                    {/* Quick-add buttons (no drag needed) */}
                    {!isDraggingAny && hasSongs && (
                      <div className="mt-3 pt-3 space-y-1" style={{ borderTop: "1px solid var(--md-border)" }}>
                        {filtered.slice(0, 5).map((song) => {
                          const key = `${song.id}-${sl.id}`;
                          const done = justAdded === key;
                          return (
                            <button
                              key={song.id}
                              onClick={() => addToSetList.mutate({ setListId: sl.id, songId: song.id, position: 999 })}
                              className="w-full flex items-center gap-2 px-2 py-1.5 rounded text-left transition-all duration-150"
                              style={{
                                background: done ? "rgba(0,255,160,0.08)" : "transparent",
                                color: done ? "#00ffa0" : "var(--md-text-dim)",
                              }}
                            >
                              {done ? <CheckCircle2 size={11} className="shrink-0" /> : <Plus size={11} className="shrink-0 opacity-50" />}
                              <span className="text-xs truncate">{song.title}</span>
                            </button>
                          );
                        })}
                        {filtered.length > 5 && (
                          <p className="text-xs pl-2 pt-1" style={{ color: "var(--md-text-muted)" }}>
                            +{filtered.length - 5} more — drag to add
                          </p>
                        )}
                      </div>
                    )}
                  </div>
                );
              })
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
