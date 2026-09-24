import { useState, useEffect, useRef } from "react";
import { useLocation, useParams } from "wouter";
import { trpc } from "@/lib/trpc";
import { toast } from "sonner";
import {
  Save, ArrowLeft, Plus, Trash2, Upload, Volume2,
  Mic2, Music, FileAudio, ToggleLeft, ToggleRight
} from "lucide-react";

const OUTPUT_ROUTES = [
  { value: "main", label: "Main Out", color: "var(--md-blue)" },
  { value: "click", label: "Click", color: "var(--md-yellow)" },
  { value: "guide", label: "Guide", color: "var(--md-magenta)" },
] as const;

const MUSIC_KEYS = [
  "C", "C#", "Db", "D", "D#", "Eb", "E", "F",
  "F#", "Gb", "G", "G#", "Ab", "A", "A#", "Bb", "B",
  "Cm", "C#m", "Dm", "D#m", "Ebm", "Em", "Fm",
  "F#m", "Gm", "G#m", "Am", "A#m", "Bbm", "Bm",
];

import MidiPatchEditor from "../components/MidiPatchEditor";
import MarkerEditor, { type SongMarker } from "../components/MarkerEditor";

export default function SongEditor() {
  const params = useParams<{ id: string }>();
  const [, navigate] = useLocation();
  const isNew = !params.id || params.id === "new";
  const songId = isNew ? null : parseInt(params.id);

  const utils = trpc.useUtils();
  const { data: song, isLoading: songLoading } = trpc.songs.byId.useQuery(
    { id: songId! },
    { enabled: !isNew && songId !== null }
  );
  const { data: stems, isLoading: stemsLoading } = trpc.stems.bySong.useQuery(
    { songId: songId! },
    { enabled: !isNew && songId !== null }
  );

  const createSong = trpc.songs.create.useMutation({
    onSuccess: (data: any) => {
      toast.success("Song created");
      utils.songs.list.invalidate();
      if (data?.insertId) navigate(`/songs/${data.insertId}`);
      else navigate("/songs");
    },
    onError: () => toast.error("Failed to create song"),
  });

  const updateSong = trpc.songs.update.useMutation({
    onSuccess: () => {
      toast.success("Song saved");
      utils.songs.list.invalidate();
      utils.songs.byId.invalidate({ id: songId! });
      navigate("/songs");
    },
    onError: () => toast.error("Failed to save song"),
  });

  const deleteStem = trpc.stems.delete.useMutation({
    onSuccess: () => {
      utils.stems.bySong.invalidate({ songId: songId! });
      toast.success("Stem removed");
    },
  });

  const updateStem = trpc.stems.update.useMutation({
    onSuccess: () => utils.stems.bySong.invalidate({ songId: songId! }),
  });

  const [replacingId, setReplacingId] = useState<number | null>(null);

  // ── Local multipart upload helpers ──────────────────────────────────────────
  const uploadStemFile = async (
    file: File,
    name: string,
    outputRoute: "main" | "click" | "guide",
    sortOrder: number
  ) => {
    const formData = new FormData();
    formData.append("audio", file);
    formData.append("songId", String(songId!));
    formData.append("name", name);
    formData.append("outputRoute", outputRoute);
    formData.append("sortOrder", String(sortOrder));
    const resp = await fetch("/api/upload/stem", { method: "POST", body: formData });
    if (!resp.ok) throw new Error(`Upload failed (${resp.status})`);
    const { stem } = await resp.json() as { stem: { id: number } };
    return stem;
  };

  const handleReplaceStemFile = async (e: React.ChangeEvent<HTMLInputElement>, stemId: number, stemName: string) => {
    const file = e.target.files?.[0];
    if (!file || !songId) return;
    setReplacingId(stemId);
    try {
      await deleteStem.mutateAsync({ id: stemId });
      await uploadStemFile(file, stemName, "main", 0);
      utils.stems.bySong.invalidate({ songId: songId! });
      toast.success("Stem replaced");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setReplacingId(null);
      if (e.target) e.target.value = "";
    }
  };

  // Form state
  const [title, setTitle] = useState("");
  const [artist, setArtist] = useState("London Romantic");
  const [bpm, setBpm] = useState("");
  const [key, setKey] = useState("");
  const [duration, setDuration] = useState("");
  const [tags, setTags] = useState("");
  const [notes, setNotes] = useState("");
  const [lyrics, setLyrics] = useState("");
  const [chords, setChords] = useState("");
  const [activeTab, setActiveTab] = useState<"info" | "lyrics" | "stems" | "midi" | "markers">("info");
  const fileInputRef = useRef<HTMLInputElement>(null);
  const audioInputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadingAudio, setUploadingAudio] = useState(false);
  const [stemUploadProgress, setStemUploadProgress] = useState<number | null>(null); // 0-100
  const [audioUploadProgress, setAudioUploadProgress] = useState<number | null>(null); // 0-100

  // XHR-based S3 PUT with progress reporting
  const xhrPut = (url: string, file: File, onProgress: (pct: number) => void): Promise<void> =>
    new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open("PUT", url);
      xhr.setRequestHeader("Content-Type", file.type || "audio/wav");
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100));
      };
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) resolve();
        else reject(new Error(`S3 upload failed (${xhr.status})`));
      };
      xhr.onerror = () => reject(new Error("Network error during upload"));
      xhr.send(file);
    });

  useEffect(() => {
    if (song) {
      setTitle(song.title ?? "");
      setArtist(song.artist ?? "London Romantic");
      setBpm(song.bpm?.toString() ?? "");
      setKey(song.key ?? "");
      setDuration(song.duration?.toString() ?? "");
      setTags(song.tags ?? "");
      setNotes(song.notes ?? "");
      setLyrics(song.lyrics ?? "");
      setChords(song.chords ?? "");
    }
  }, [song]);

  const handleSave = () => {
    if (!title.trim()) { toast.error("Song title is required"); return; }
    const data = {
      title: title.trim(),
      artist: artist.trim() || undefined,
      bpm: bpm ? parseInt(bpm) : null,
      key: key || null,
      duration: duration ? parseInt(duration) : null,
      tags: tags || null,
      notes: notes || null,
      lyrics: lyrics || null,
      chords: chords || null,
    };
    if (isNew) createSong.mutate(data);
    else updateSong.mutate({ id: songId!, data });
  };

  const handleAudioUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    if (!songId) { toast.error("Save the song first"); return; }
    const file = e.target.files?.[0];
    if (!file) return;
    setUploadingAudio(true);
    try {
      const formData = new FormData();
      formData.append("audio", file);
      formData.append("songId", String(songId!));
      formData.append("fileName", file.name);
      const resp = await fetch("/api/upload/backing", { method: "POST", body: formData });
      if (!resp.ok) throw new Error(`Upload failed (${resp.status})`);
      utils.songs.byId.invalidate({ id: songId! });
      toast.success("Backing track uploaded");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Audio upload failed");
    } finally {
      setUploadingAudio(false);
      setAudioUploadProgress(null);
      if (audioInputRef.current) audioInputRef.current.value = "";
    }
  };

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    if (!songId) { toast.error("Save the song first before adding stems"); return; }
    const files = Array.from(e.target.files ?? []);
    if (!files.length) return;
    setUploading(true);
    let successCount = 0;
    for (const file of files) {
      try {
        const name = file.name.replace(/\.[^.]+$/, "");
        const route: "main" | "click" | "guide" = name.toLowerCase().includes("click")
          ? "click"
          : name.toLowerCase().includes("guide")
          ? "guide"
          : "main";
        await uploadStemFile(file, name, route, (stems?.length ?? 0) + successCount);
        successCount++;
      } catch (err) {
        toast.error(`Failed to upload "${file.name}": ${err instanceof Error ? err.message : "Unknown error"}`);
      }
    }
    if (successCount > 0) {
      utils.stems.bySong.invalidate({ songId: songId! });
      toast.success(successCount === 1 ? "Stem uploaded" : `${successCount} stems uploaded`);
    }
    setUploading(false);
    setStemUploadProgress(null);
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const isSaving = createSong.isPending || updateSong.isPending;

  return (
    <div className="p-8 max-w-3xl mx-auto animate-slide-up">
      {/* Header */}
      <div className="flex items-center justify-between mb-8">
        <div className="flex items-center gap-4">
          <button
            onClick={() => navigate("/songs")}
            className="w-8 h-8 rounded flex items-center justify-center transition-colors"
            style={{ background: "var(--md-surface-2)", color: "var(--md-text-dim)" }}
          >
            <ArrowLeft size={16} />
          </button>
          <div>
            <h1 className="text-2xl font-bold tracking-tight" style={{ color: "var(--md-text)" }}>
              {isNew ? "New Song" : title || "Edit Song"}
            </h1>
            <p className="text-xs tracking-widest uppercase mt-0.5" style={{ color: "var(--md-text-dim)" }}>
              {isNew ? "Song Library" : "Edit · Song Library"}
            </p>
          </div>
        </div>
        <button
          onClick={handleSave}
          disabled={isSaving}
          className="btn-stage btn-primary"
        >
          <Save size={14} className="mr-2" />
          {isSaving ? "Saving..." : "Save Song"}
        </button>
      </div>

      {/* Tabs */}
      <div
        className="flex gap-1 mb-6 p-1 rounded"
        style={{ background: "var(--md-surface-2)" }}
      >
        {(["info", "lyrics", "stems", "midi", "markers"] as const).map((tab) => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            className="flex-1 py-2 text-xs font-semibold tracking-widest uppercase rounded transition-all duration-150"
            style={{
              background: activeTab === tab ? "var(--md-surface-3)" : "transparent",
              color: activeTab === tab ? "var(--md-text)" : "var(--md-text-muted)",
              border: activeTab === tab ? "1px solid var(--md-border)" : "1px solid transparent",
            }}
          >
            {tab === "info" && "Song Info"}
            {tab === "lyrics" && "Lyrics & Chords"}
            {tab === "stems" && `Stems${stems?.length ? ` (${stems.length})` : ""}`}
            {tab === "midi" && "MIDI Patches"}
            {tab === "markers" && "🎯 Markers"}
          </button>
        ))}
      </div>

      {/* ── Info tab ─────────────────────────────────────────────────────── */}
      {activeTab === "info" && (
        <div className="space-y-5">
          <div className="grid grid-cols-2 gap-4">
            <div className="col-span-2">
              <label className="block text-xs font-semibold tracking-widest uppercase mb-2" style={{ color: "var(--md-text-dim)" }}>
                Title *
              </label>
              <input
                type="text"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="Song title"
                className="w-full px-3 py-2.5 text-sm"
              />
            </div>
            <div>
              <label className="block text-xs font-semibold tracking-widest uppercase mb-2" style={{ color: "var(--md-text-dim)" }}>
                Artist
              </label>
              <input
                type="text"
                value={artist}
                onChange={(e) => setArtist(e.target.value)}
                placeholder="Artist / project"
                className="w-full px-3 py-2.5 text-sm"
              />
            </div>
            <div>
              <label className="block text-xs font-semibold tracking-widest uppercase mb-2" style={{ color: "var(--md-text-dim)" }}>
                Key
              </label>
              <select
                value={key}
                onChange={(e) => setKey(e.target.value)}
                className="w-full px-3 py-2.5 text-sm"
              >
                <option value="">— Select key —</option>
                {MUSIC_KEYS.map((k) => (
                  <option key={k} value={k}>{k}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-xs font-semibold tracking-widest uppercase mb-2" style={{ color: "var(--md-text-dim)" }}>
                BPM
              </label>
              <input
                type="number"
                value={bpm}
                onChange={(e) => setBpm(e.target.value)}
                placeholder="120"
                min="40"
                max="300"
                className="w-full px-3 py-2.5 text-sm"
              />
            </div>
            <div>
              <label className="block text-xs font-semibold tracking-widest uppercase mb-2" style={{ color: "var(--md-text-dim)" }}>
                Duration (seconds)
              </label>
              <input
                type="number"
                value={duration}
                onChange={(e) => setDuration(e.target.value)}
                placeholder="240"
                min="1"
                className="w-full px-3 py-2.5 text-sm"
              />
            </div>
            <div className="col-span-2">
              <label className="block text-xs font-semibold tracking-widest uppercase mb-2" style={{ color: "var(--md-text-dim)" }}>
                Tags (comma-separated)
              </label>
              <input
                type="text"
                value={tags}
                onChange={(e) => setTags(e.target.value)}
                placeholder="synth, pop, opener, closer"
                className="w-full px-3 py-2.5 text-sm"
              />
            </div>
            <div className="col-span-2">
              <label className="block text-xs font-semibold tracking-widest uppercase mb-2" style={{ color: "var(--md-text-dim)" }}>
                Notes
              </label>
              <textarea
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="Performance notes, cues, transitions..."
                rows={4}
                className="w-full px-3 py-2.5 text-sm resize-none"
              />
            </div>
          </div>
        </div>
      )}

      {/* ── Lyrics tab ───────────────────────────────────────────────────── */}
      {activeTab === "lyrics" && (
        <div className="space-y-5">
          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="text-xs font-semibold tracking-widest uppercase" style={{ color: "var(--md-text-dim)" }}>
                Lyrics & Chords
              </label>
              <div className="flex items-center gap-3">
                {!isNew && songId && (
                  <button
                    type="button"
                    onClick={() => navigate(`/songs/${songId}/cues`)}
                    className="text-xs px-3 py-1.5 rounded font-semibold tracking-wide transition-colors"
                    style={{
                      background: "rgba(0,180,255,0.12)",
                      color: "var(--md-blue)",
                      border: "1px solid rgba(0,180,255,0.25)",
                    }}
                  >
                    ✦ Lyric Cue Editor
                  </button>
                )}
                <span className="text-xs" style={{ color: "var(--md-text-muted)" }}>
                  Use [MM:SS] for timestamps
                </span>
              </div>
            </div>
            <textarea
              value={lyrics}
              onChange={(e) => setLyrics(e.target.value)}
              placeholder={`[00:00] Intro\nDm  Bb  F  C\n\n[00:18] Verse 1\nDm\nDriving through the midnight rain\nBb\nCity lights are calling again\n\n[00:52] Chorus\nF\nWe come alive after dark\nC\nNeon burning in our hearts`}
              rows={18}
              className="w-full px-4 py-3 text-sm font-mono resize-none"
              style={{ lineHeight: "1.8" }}
            />
          </div>
          <div
            className="p-4 rounded text-xs"
            style={{
              background: "rgba(0,180,255,0.05)",
              border: "1px solid rgba(0,180,255,0.15)",
              color: "var(--md-text-dim)",
            }}
          >
            <strong style={{ color: "var(--md-blue)" }}>Format guide:</strong> Use{" "}
            <code style={{ color: "var(--md-blue)" }}>[MM:SS]</code> for section timestamps,
            chord names on their own line (e.g. <code style={{ color: "var(--md-blue)" }}>Dm</code>),
            then lyrics below. The live screen will highlight the active section.
          </div>
        </div>
      )}

      {/* ── Stems tab ────────────────────────────────────────────────────── */}
      {activeTab === "stems" && (
        <div className="space-y-4">

          {/* ── Backing track section ─────────────────────────────────────── */}
          {!isNew && (
            <div
              className="p-4 rounded-lg"
              style={{
                background: "var(--md-surface-2)",
                border: "1px solid var(--md-border)",
              }}
            >
              <div className="flex items-center justify-between mb-3">
                <div>
                  <p className="text-xs font-semibold tracking-widest uppercase" style={{ color: "var(--md-text-dim)" }}>
                    Stereo Backing Track
                  </p>
                  <p className="text-xs mt-0.5" style={{ color: "var(--md-text-muted)" }}>
                    Used when no stems are present
                  </p>
                </div>
                <button
                  onClick={() => audioInputRef.current?.click()}
                  disabled={uploadingAudio}
                  className="btn-stage btn-ghost text-xs"
                >
                  <Upload size={13} className="mr-2" />
                  {uploadingAudio
                    ? audioUploadProgress !== null
                      ? `${audioUploadProgress}%`
                      : "Uploading..."
                    : song?.audioFileUrl ? "Replace" : "Upload Audio"}
                </button>
                <input
                  ref={audioInputRef}
                  type="file"
                  accept="audio/*"
                  className="hidden"
                  onChange={handleAudioUpload}
                />
              </div>
              {song?.audioFileUrl ? (
                <div
                  className="flex items-center gap-3 px-3 py-2 rounded"
                  style={{ background: "var(--md-surface-3)", border: "1px solid var(--md-border)" }}
                >
                  <Music size={14} style={{ color: "var(--md-blue)" }} />
                  <span className="text-xs flex-1 truncate" style={{ color: "var(--md-text)" }}>
                    Backing track loaded
                  </span>
                  {song.audioFileSize && (
                    <span className="text-xs" style={{ color: "var(--md-text-muted)" }}>
                      {(song.audioFileSize / 1024 / 1024).toFixed(1)} MB
                    </span>
                  )}
                  <audio
                    controls
                    src={song.audioFileUrl}
                    className="h-7"
                    style={{ filter: "invert(1) hue-rotate(180deg)", maxWidth: "180px" }}
                  />
                </div>
              ) : (
                <p className="text-xs" style={{ color: "var(--md-text-muted)" }}>
                  No backing track uploaded yet.
                </p>
              )}
            </div>
          )}

          <div
            className="flex items-center gap-2 px-3 py-2 rounded text-xs"
            style={{ background: "rgba(0,180,255,0.05)", border: "1px solid rgba(0,180,255,0.12)", color: "var(--md-text-muted)" }}
          >
            <Mic2 size={12} style={{ color: "var(--md-blue)" }} />
            <span>Add individual stems below for multitrack mixing. If stems are present, the backing track above is ignored during playback.</span>
          </div>

          {isNew ? (
            <div
              className="p-6 rounded text-center text-sm"
              style={{
                background: "rgba(255,204,0,0.05)",
                border: "1px solid rgba(255,204,0,0.2)",
                color: "var(--md-yellow)",
              }}
            >
              Save the song first to add stems.
            </div>
          ) : (
            <>
              {/* Upload button */}
              <div className="flex items-center justify-between">
                <p className="text-xs tracking-widest uppercase" style={{ color: "var(--md-text-dim)" }}>
                  {stems?.length ?? 0} stems
                </p>
                <button
                  onClick={() => fileInputRef.current?.click()}
                  disabled={uploading}
                  className="btn-stage btn-ghost text-xs"
                >
                  <Upload size={13} className="mr-2" />
                  {uploading
                    ? stemUploadProgress !== null
                      ? `${stemUploadProgress}%`
                      : "Uploading..."
                    : "Upload Stems"}
                </button>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="audio/*"
                  multiple
                  className="hidden"
                  onChange={handleFileUpload}
                />
              </div>

              {/* Stems list */}
              {stemsLoading ? (
                <div className="space-y-2">
                  {[1, 2].map((i) => (
                    <div key={i} className="h-16 rounded animate-pulse" style={{ background: "var(--md-surface-2)" }} />
                  ))}
                </div>
              ) : (stems?.length ?? 0) === 0 ? (
                <div className="text-center py-12">
                  <FileAudio size={40} className="mx-auto mb-3 opacity-10" />
                  <p className="text-sm" style={{ color: "var(--md-text-muted)" }}>
                    No stems yet. Upload audio files above.
                  </p>
                  <p className="text-xs mt-2" style={{ color: "var(--md-text-muted)" }}>
                    Files named "click" or "guide" are auto-routed to their outputs.
                  </p>
                </div>
              ) : (
                <div className="space-y-2">
                  {stems?.map((stem) => (
                    <div
                      key={stem.id}
                      className="stem-channel"
                      style={{ opacity: stem.muted ? 0.45 : 1 }}
                    >
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-3">
                          <FileAudio size={14} style={{ color: "var(--md-text-muted)" }} />
                          <span className="text-sm font-semibold" style={{ color: "var(--md-text)" }}>
                            {stem.name}
                          </span>
                        </div>
                        <div className="flex items-center gap-2">
                          {/* Output route */}
                          <select
                            value={stem.outputRoute}
                            onChange={(e) =>
                              updateStem.mutate({
                                id: stem.id,
                                data: { outputRoute: e.target.value as any },
                              })
                            }
                            className="text-xs px-2 py-1"
                            style={{
                              background: "var(--md-surface-3)",
                              border: "1px solid var(--md-border)",
                              borderRadius: "4px",
                              color:
                                stem.outputRoute === "main"
                                  ? "var(--md-blue)"
                                  : stem.outputRoute === "click"
                                  ? "var(--md-yellow)"
                                  : "var(--md-magenta)",
                            }}
                          >
                            {OUTPUT_ROUTES.map((r) => (
                              <option key={r.value} value={r.value}>
                                {r.label}
                              </option>
                            ))}
                          </select>
                          {/* Mute */}
                          <button
                            onClick={() =>
                              updateStem.mutate({
                                id: stem.id,
                                data: { muted: !stem.muted },
                              })
                            }
                            className="text-xs px-2 py-1 rounded transition-colors"
                            style={{
                              background: stem.muted ? "rgba(255,51,85,0.2)" : "var(--md-surface-3)",
                              color: stem.muted ? "var(--md-red)" : "var(--md-text-muted)",
                              border: `1px solid ${stem.muted ? "rgba(255,51,85,0.3)" : "var(--md-border)"}`,
                            }}
                          >
                            {stem.muted ? "MUTED" : "MUTE"}
                          </button>
                          {/* Replace file */}
                          <label
                            className="w-7 h-7 rounded flex items-center justify-center transition-colors cursor-pointer hover:bg-blue-900/30"
                            style={{ color: replacingId === stem.id ? "var(--md-blue)" : "var(--md-text-muted)" }}
                            title="Replace audio file"
                          >
                            {replacingId === stem.id ? (
                              <span className="text-xs animate-pulse">…</span>
                            ) : (
                              <Upload size={12} />
                            )}
                            <input
                              type="file"
                              accept="audio/*"
                              className="hidden"
                              onChange={(e) => handleReplaceStemFile(e, stem.id, stem.name)}
                            />
                          </label>
                          {/* Delete */}
                          <button
                            onClick={() => deleteStem.mutate({ id: stem.id })}
                            className="w-7 h-7 rounded flex items-center justify-center transition-colors hover:bg-red-900/30"
                            style={{ color: "var(--md-text-muted)" }}
                          >
                            <Trash2 size={12} />
                          </button>
                        </div>
                      </div>
                      {/* Volume */}
                      <div className="flex items-center gap-3">
                        <Volume2 size={12} style={{ color: "var(--md-text-muted)" }} />
                        <input
                          type="range"
                          min="0"
                          max="2"
                          step="0.01"
                          value={stem.volume}
                          onChange={(e) =>
                            updateStem.mutate({
                              id: stem.id,
                              data: { volume: parseFloat(e.target.value) },
                            })
                          }
                          className="flex-1 h-1 accent-[var(--md-blue)] cursor-pointer"
                          style={{ accentColor: "var(--md-blue)" }}
                        />
                        <span className="text-xs w-8 text-right" style={{ color: "var(--md-text-muted)" }}>
                          {Math.round(stem.volume * 100)}%
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      )}

      {/* ── MIDI Patches tab ── */}
      {activeTab === "midi" && songId && (
        <div className="p-6">
          <MidiPatchEditor
            songId={songId}
            initialPatches={(song as { midiPatches?: string | null } | undefined)?.midiPatches ?? null}
          />
        </div>
      )}
      {activeTab === "midi" && !songId && (
        <div className="p-6 text-sm" style={{ color: "var(--md-text-muted)" }}>Save the song first to configure MIDI patches.</div>
      )}

      {/* ── Markers tab ── */}
      {activeTab === "markers" && songId && (
        <div className="p-6">
          <MarkerEditor
            songId={songId}
            initialMarkers={(song as { markers?: string | null } | undefined)?.markers ?? null}
            duration={(song as { duration?: number | null } | undefined)?.duration ?? undefined}
          />
        </div>
      )}
      {activeTab === "markers" && !songId && (
        <div className="p-6 text-sm" style={{ color: "var(--md-text-muted)" }}>Save the song first to add markers.</div>
      )}
    </div>
  );
}
