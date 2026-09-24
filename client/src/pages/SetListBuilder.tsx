import { useState, useRef, useMemo } from "react";
import { useParams, useLocation } from "wouter";
import { trpc } from "@/lib/trpc";
import { toast } from "sonner";
import {
  Plus, Trash2, GripVertical, Clock, Music2,
  ListMusic, Edit2, Check, X, Search, ArrowUpDown, TrendingUp
} from "lucide-react";

function formatDuration(seconds: number | null | undefined) {
  if (!seconds) return null;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function totalDuration(songs: Array<{ song?: { duration?: number | null } | null }>) {
  const total = songs.reduce((acc, s) => acc + (s.song?.duration ?? 0), 0);
  if (!total) return null;
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h > 0
    ? `${h}h ${m}m`
    : `${m}m ${s}s`;
}

export default function SetListBuilder() {
  const params = useParams<{ id: string }>();
  const [, navigate] = useLocation();
  const selectedId = params.id ? parseInt(params.id) : null;

  const utils = trpc.useUtils();
  const { data: setLists } = trpc.setLists.list.useQuery();
  const { data: selectedSetList } = trpc.setLists.byId.useQuery(
    { id: selectedId! },
    { enabled: selectedId !== null }
  );
  const { data: setListSongs } = trpc.setLists.songs.useQuery(
    { setListId: selectedId! },
    { enabled: selectedId !== null }
  );
  const { data: allSongs } = trpc.songs.list.useQuery();

  const createSetList = trpc.setLists.create.useMutation({
    onSuccess: (data: any) => {
      utils.setLists.list.invalidate();
      toast.success("Set list created");
      if (data?.insertId) navigate(`/setlists/${data.insertId}`);
    },
  });

  const updateSetList = trpc.setLists.update.useMutation({
    onSuccess: () => {
      utils.setLists.list.invalidate();
      utils.setLists.byId.invalidate({ id: selectedId! });
      toast.success("Saved");
    },
  });

  const deleteSetList = trpc.setLists.delete.useMutation({
    onSuccess: () => {
      utils.setLists.list.invalidate();
      navigate("/setlists");
      toast.success("Set list deleted");
    },
  });

  const addSong = trpc.setLists.addSong.useMutation({
    onSuccess: () => {
      utils.setLists.songs.invalidate({ setListId: selectedId! });
      toast.success("Song added");
    },
  });

  const removeSong = trpc.setLists.removeSong.useMutation({
    onSuccess: () => {
      utils.setLists.songs.invalidate({ setListId: selectedId! });
    },
  });

  const reorder = trpc.setLists.reorder.useMutation({
    onSuccess: () => utils.setLists.songs.invalidate({ setListId: selectedId! }),
  });

  // New set list form
  const [newName, setNewName] = useState("");
  const [creatingNew, setCreatingNew] = useState(false);

  // Edit name inline
  const [editingName, setEditingName] = useState(false);
  const [editName, setEditName] = useState("");

  // Drag state
  const dragIndex = useRef<number | null>(null);
  const [dragOver, setDragOver] = useState<number | null>(null);
  const [localOrder, setLocalOrder] = useState<NonNullable<typeof setListSongs>>([]);

  // Sync local order with server data
  const songs: NonNullable<typeof setListSongs> = localOrder.length > 0 ? localOrder : (setListSongs ?? []);

  const handleDragStart = (idx: number) => {
    dragIndex.current = idx;
  };

  const handleDragOver = (e: React.DragEvent, idx: number) => {
    e.preventDefault();
    setDragOver(idx);
  };

  const handleDrop = (idx: number) => {
    if (dragIndex.current === null || dragIndex.current === idx) {
      setDragOver(null);
      return;
    }
    const newOrder = [...songs];
    const [moved] = newOrder.splice(dragIndex.current, 1);
    newOrder.splice(idx, 0, moved);
    setLocalOrder(newOrder);
    setDragOver(null);
    dragIndex.current = null;
    reorder.mutate({
      setListId: selectedId!,
      orderedSongIds: newOrder.map((s) => s.songId),
    });
  };

  // Song picker state
  const [songSearch, setSongSearch] = useState("");
  const [songSort, setSongSort] = useState<"added" | "alpha" | "popular">("added");

  const availableSongs = useMemo(() => {
    const inSet = new Set(songs.map((ss) => ss.songId));
    let list = (allSongs ?? []).filter((s) => !inSet.has(s.id));
    // Filter by search
    if (songSearch.trim()) {
      const q = songSearch.toLowerCase();
      list = list.filter(
        (s) => s.title?.toLowerCase().includes(q) || s.artist?.toLowerCase().includes(q)
      );
    }
    // Sort
    if (songSort === "alpha") {
      list = [...list].sort((a, b) => (a.title ?? "").localeCompare(b.title ?? ""));
    } else if (songSort === "popular") {
      list = [...list].sort((a, b) => (b.playCount ?? 0) - (a.playCount ?? 0));
    }
    return list;
  }, [allSongs, songs, songSearch, songSort]);

  return (
    <div className="flex h-full" style={{ background: "var(--md-black)" }}>
      {/* Left panel: set list directory */}
      <div
        className="w-64 shrink-0 border-r flex flex-col"
        style={{ background: "var(--md-surface)", borderColor: "var(--md-border)" }}
      >
        <div className="p-4 border-b" style={{ borderColor: "var(--md-border)" }}>
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-xs font-bold tracking-widest uppercase" style={{ color: "var(--md-text-dim)" }}>
              Set Lists
            </h2>
            <button
              onClick={() => setCreatingNew(true)}
              className="w-6 h-6 rounded flex items-center justify-center transition-colors"
              style={{ background: "rgba(0,180,255,0.15)", color: "var(--md-blue)" }}
            >
              <Plus size={13} />
            </button>
          </div>
          {creatingNew && (
            <div className="flex gap-2">
              <input
                type="text"
                autoFocus
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && newName.trim()) {
                    createSetList.mutate({ name: newName.trim() });
                    setNewName("");
                    setCreatingNew(false);
                  }
                  if (e.key === "Escape") setCreatingNew(false);
                }}
                placeholder="Set list name"
                className="flex-1 px-2 py-1.5 text-xs"
              />
              <button
                onClick={() => {
                  if (newName.trim()) {
                    createSetList.mutate({ name: newName.trim() });
                    setNewName("");
                    setCreatingNew(false);
                  }
                }}
                className="w-7 h-7 rounded flex items-center justify-center"
                style={{ background: "var(--md-blue)", color: "var(--md-black)" }}
              >
                <Check size={12} />
              </button>
            </div>
          )}
        </div>
        <div className="flex-1 overflow-y-auto p-2">
          {(setLists?.length ?? 0) === 0 ? (
            <div className="text-center py-8 text-xs" style={{ color: "var(--md-text-muted)" }}>
              No set lists yet
            </div>
          ) : (
            setLists?.map((sl) => (
              <button
                key={sl.id}
                onClick={() => navigate(`/setlists/${sl.id}`)}
                className="w-full text-left px-3 py-2.5 rounded mb-1 transition-all duration-150"
                style={{
                  background: selectedId === sl.id ? "rgba(0,180,255,0.12)" : "transparent",
                  color: selectedId === sl.id ? "var(--md-blue)" : "var(--md-text-dim)",
                  borderLeft: selectedId === sl.id ? "2px solid var(--md-blue)" : "2px solid transparent",
                }}
              >
                <div className="text-xs font-semibold truncate">{sl.name}</div>
              </button>
            ))
          )}
        </div>
      </div>

      {/* Right panel: set list editor */}
      <div className="flex-1 overflow-y-auto p-8 animate-slide-up">
        {!selectedId ? (
          <div className="flex flex-col items-center justify-center h-full text-center">
            <ListMusic size={48} className="mb-4 opacity-10" />
            <p className="text-base font-semibold mb-2" style={{ color: "var(--md-text-dim)" }}>
              Select or create a set list
            </p>
            <button
              onClick={() => setCreatingNew(true)}
              className="btn-stage btn-primary mt-4"
            >
              <Plus size={14} className="mr-2" />
              New Set List
            </button>
          </div>
        ) : (
          <div className="max-w-2xl">
            {/* Header */}
            <div className="flex items-start justify-between mb-6">
              <div className="flex-1 min-w-0">
                {editingName ? (
                  <div className="flex items-center gap-2">
                    <input
                      autoFocus
                      value={editName}
                      onChange={(e) => setEditName(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          updateSetList.mutate({ id: selectedId, name: editName });
                          setEditingName(false);
                        }
                        if (e.key === "Escape") setEditingName(false);
                      }}
                      className="text-2xl font-bold px-2 py-1 w-full"
                      style={{ background: "var(--md-surface-2)" }}
                    />
                    <button onClick={() => { updateSetList.mutate({ id: selectedId, name: editName }); setEditingName(false); }}>
                      <Check size={16} style={{ color: "var(--md-blue)" }} />
                    </button>
                    <button onClick={() => setEditingName(false)}>
                      <X size={16} style={{ color: "var(--md-text-muted)" }} />
                    </button>
                  </div>
                ) : (
                  <div className="flex items-center gap-3">
                    <h1 className="text-2xl font-bold tracking-tight" style={{ color: "var(--md-text)" }}>
                      {selectedSetList?.name}
                    </h1>
                    <button
                      onClick={() => { setEditName(selectedSetList?.name ?? ""); setEditingName(true); }}
                      className="opacity-40 hover:opacity-100 transition-opacity"
                    >
                      <Edit2 size={14} style={{ color: "var(--md-text-dim)" }} />
                    </button>
                  </div>
                )}
                <div className="flex items-center gap-4 mt-1 text-xs" style={{ color: "var(--md-text-muted)" }}>
                  <span>{songs.length} songs</span>
                  {totalDuration(songs) && <span><Clock size={10} className="inline mr-1" />{totalDuration(songs)}</span>}
                </div>
              </div>
              <button
                onClick={() => {
                  if (confirm("Delete this set list?")) deleteSetList.mutate({ id: selectedId });
                }}
                className="w-8 h-8 rounded flex items-center justify-center transition-colors hover:bg-red-900/30 ml-4"
                style={{ color: "var(--md-text-muted)" }}
              >
                <Trash2 size={14} />
              </button>
            </div>

            {/* Song list */}
            <div className="space-y-2 mb-6">
              {songs.length === 0 ? (
                <div className="text-center py-10">
                  <Music2 size={36} className="mx-auto mb-3 opacity-10" />
                  <p className="text-sm" style={{ color: "var(--md-text-muted)" }}>
                    No songs yet. Add songs below.
                  </p>
                </div>
              ) : (
                songs.map((entry, idx) => (
                  <div
                    key={entry.id}
                    draggable
                    onDragStart={() => handleDragStart(idx)}
                    onDragOver={(e) => handleDragOver(e, idx)}
                    onDrop={() => handleDrop(idx)}
                    onDragEnd={() => setDragOver(null)}
                    className="md-card flex items-center gap-3 px-4 py-3 cursor-grab active:cursor-grabbing transition-all duration-150"
                    style={{
                      borderColor: dragOver === idx ? "var(--md-blue)" : "var(--md-border)",
                      opacity: dragOver === idx ? 0.7 : 1,
                    }}
                  >
                    <GripVertical size={14} style={{ color: "var(--md-text-muted)" }} />
                    <span
                      className="text-xs font-bold w-6 text-center shrink-0"
                      style={{ color: "var(--md-text-muted)" }}
                    >
                      {idx + 1}
                    </span>
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-semibold truncate" style={{ color: "var(--md-text)" }}>
                        {entry.song?.title}
                      </div>
                      <div className="flex items-center gap-3 text-xs mt-0.5" style={{ color: "var(--md-text-muted)" }}>
                        {entry.song?.bpm && <span>{entry.song.bpm} BPM</span>}
                        {entry.song?.key && <span style={{ color: "var(--md-blue)" }}>{entry.song.key}</span>}
                        {entry.song?.duration && <span>{formatDuration(entry.song.duration)}</span>}
                      </div>
                    </div>
                    <button
                      onClick={() => removeSong.mutate({ setListId: selectedId, songId: entry.songId })}
                      className="w-7 h-7 rounded flex items-center justify-center opacity-0 group-hover:opacity-100 transition-all hover:bg-red-900/30"
                      style={{ color: "var(--md-text-muted)" }}
                    >
                      <X size={12} />
                    </button>
                  </div>
                ))
              )}
            </div>

            {/* Add songs */}
            {(availableSongs.length > 0 || songSearch) && (
              <div>
                <h3 className="text-xs font-bold tracking-widest uppercase mb-3" style={{ color: "var(--md-text-dim)" }}>
                  Add Songs
                </h3>

                {/* Search + Sort controls */}
                <div className="flex gap-2 mb-3">
                  <div className="relative flex-1">
                    <Search size={12} className="absolute left-2.5 top-1/2 -translate-y-1/2" style={{ color: "var(--md-text-muted)" }} />
                    <input
                      type="text"
                      value={songSearch}
                      onChange={(e) => setSongSearch(e.target.value)}
                      placeholder="Search songs..."
                      className="w-full pl-7 pr-3 py-1.5 text-xs rounded"
                      style={{ background: "var(--md-surface-2)", border: "1px solid var(--md-border)", color: "var(--md-text)" }}
                    />
                  </div>
                  <div className="flex gap-1">
                    {(["added", "alpha", "popular"] as const).map((s) => (
                      <button
                        key={s}
                        onClick={() => setSongSort(s)}
                        title={s === "added" ? "Recently added" : s === "alpha" ? "A – Z" : "Most played"}
                        className="px-2 py-1.5 rounded text-xs flex items-center gap-1 transition-colors"
                        style={{
                          background: songSort === s ? "rgba(0,180,255,0.18)" : "var(--md-surface-2)",
                          border: `1px solid ${songSort === s ? "var(--md-blue)" : "var(--md-border)"}`,
                          color: songSort === s ? "var(--md-blue)" : "var(--md-text-muted)",
                        }}
                      >
                        {s === "added" && <ArrowUpDown size={10} />}
                        {s === "alpha" && <span className="font-bold">A–Z</span>}
                        {s === "popular" && <TrendingUp size={10} />}
                      </button>
                    ))}
                  </div>
                </div>

                {availableSongs.length === 0 ? (
                  <p className="text-xs text-center py-4" style={{ color: "var(--md-text-muted)" }}>
                    No songs match "{songSearch}"
                  </p>
                ) : (
                <div className="space-y-1">
                  {availableSongs.map((song) => (
                    <button
                      key={song.id}
                      onClick={() =>
                        addSong.mutate({
                          setListId: selectedId,
                          songId: song.id,
                          position: songs.length,
                        })
                      }
                      className="w-full flex items-center gap-3 px-4 py-3 rounded transition-colors text-left"
                      style={{
                        background: "var(--md-surface-2)",
                        border: "1px solid var(--md-border)",
                      }}
                    >
                      <Plus size={13} style={{ color: "var(--md-blue)" }} />
                      <div className="flex-1 min-w-0">
                        <div className="text-sm truncate" style={{ color: "var(--md-text-dim)" }}>
                          {song.title}
                        </div>
                      </div>
                      {song.bpm && (
                        <span className="text-xs shrink-0" style={{ color: "var(--md-text-muted)" }}>
                          {song.bpm} BPM
                        </span>
                      )}
                    </button>
                  ))}
                </div>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
