import { useRef, useState } from "react";
import { trpc } from "@/lib/trpc";
import { toast } from "sonner";

/**
 * StemFolderImport — turn a FOLDER OF STEMS into a library track in one go.
 *
 * Drag a folder (or several) onto the drop zone, or click to pick one. Each
 * folder becomes a song named after the folder, and every audio file inside
 * becomes one of its stems. Files named click/cue/iem/count are routed to the
 * in-ears automatically; everything else goes to the room.
 *
 * This is the prep step that makes the live workflow fast: import once here,
 * then it's one tap onto a deck on the DJ page.
 */

const AUDIO_RE = /\.(wav|aiff?|flac|mp3|m4a|ogg)$/i;
const CUE_RE = /click|cue|iem|count/i;

interface Progress {
  folder: string;
  done: number;
  total: number;
}

export default function StemFolderImport({ onImported }: { onImported?: () => void }) {
  const createSong = trpc.songs.create.useMutation();
  const utils = trpc.useUtils();
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);
  const [progress, setProgress] = useState<Progress | null>(null);

  /** Import one folder's worth of audio files as a song + stems. */
  const importFolder = async (folderName: string, files: File[]) => {
    const audio = files.filter((f) => AUDIO_RE.test(f.name));
    if (audio.length === 0) {
      toast.error(`"${folderName}" has no audio files`);
      return;
    }
    audio.sort((a, b) => a.name.localeCompare(b.name));
    setProgress({ folder: folderName, done: 0, total: audio.length });

    try {
      const song = await createSong.mutateAsync({
        title: folderName,
        artist: "London Romantic",
      });

      for (let i = 0; i < audio.length; i++) {
        const f = audio[i];
        const base = f.name.replace(/\.[^.]+$/, "");
        const form = new FormData();
        form.append("audio", f);
        form.append("songId", String(song!.id));
        form.append("name", base);
        form.append("outputRoute", CUE_RE.test(base) ? "click" : "main");
        form.append("sortOrder", String(i));
        await fetch("/api/upload/stem", { method: "POST", body: form });
        setProgress({ folder: folderName, done: i + 1, total: audio.length });
      }

      toast.success(`Imported "${folderName}" — ${audio.length} stems`);
      utils.songs.list.invalidate();
      onImported?.();
    } catch (e) {
      toast.error(`Import failed: ${(e as Error).message}`);
    } finally {
      setProgress(null);
    }
  };

  /** Group a flat FileList (from a directory input) by its top folder. */
  const importFromInput = async (fileList: FileList) => {
    const byFolder = new Map<string, File[]>();
    Array.from(fileList).forEach((f) => {
      // webkitRelativePath looks like "Never Too Much/Vocals.wav"
      const rel = (f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name;
      const folder = rel.includes("/") ? rel.split("/")[0] : "Imported Stems";
      if (!byFolder.has(folder)) byFolder.set(folder, []);
      byFolder.get(folder)!.push(f);
    });
    for (const [folder, files] of Array.from(byFolder.entries())) await importFolder(folder, files);
  };

  /** Read a dropped directory entry recursively. */
  const readEntry = (entry: any): Promise<File[]> =>
    new Promise((resolve) => {
      if (entry.isFile) {
        entry.file((f: File) => resolve([f]), () => resolve([]));
      } else if (entry.isDirectory) {
        const reader = entry.createReader();
        reader.readEntries(async (entries: any[]) => {
          const nested = await Promise.all(entries.map(readEntry));
          resolve(nested.flat());
        }, () => resolve([]));
      } else resolve([]);
    });

  const onDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const items = Array.from(e.dataTransfer.items);
    const looseFiles: File[] = [];

    for (const item of items) {
      const entry = (item as DataTransferItem & { webkitGetAsEntry?: () => any }).webkitGetAsEntry?.();
      if (entry?.isDirectory) {
        const files = await readEntry(entry);
        await importFolder(entry.name, files);
      } else if (entry?.isFile) {
        const f = item.getAsFile();
        if (f) looseFiles.push(f);
      }
    }
    // Loose files dropped together become one track.
    if (looseFiles.length) await importFolder("Imported Stems", looseFiles);
  };

  const busy = progress !== null;

  return (
    <div
      onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
      onDragLeave={() => setDragOver(false)}
      onDrop={onDrop}
      onClick={() => !busy && inputRef.current?.click()}
      className="rounded-lg p-4 mb-4 text-center cursor-pointer transition-colors"
      style={{
        border: `1.5px dashed ${dragOver ? "#7B2CF9" : "var(--md-border)"}`,
        background: dragOver ? "rgba(123,44,207,0.08)" : "transparent",
      }}
    >
      <input
        ref={inputRef}
        type="file"
        multiple
        className="hidden"
        // @ts-expect-error — non-standard but supported: lets the user pick a folder
        webkitdirectory=""
        directory=""
        onChange={(e) => { const fs = e.target.files; if (fs?.length) importFromInput(fs); e.target.value = ""; }}
      />
      {busy ? (
        <div>
          <div className="text-sm font-semibold" style={{ color: "#a06bf0" }}>
            Importing "{progress!.folder}" — {progress!.done} / {progress!.total} stems
          </div>
          <div className="w-full h-1 rounded mt-2" style={{ background: "var(--md-surface-3)" }}>
            <div className="h-1 rounded" style={{ width: `${(progress!.done / progress!.total) * 100}%`, background: "#7B2CF9" }} />
          </div>
        </div>
      ) : (
        <>
          <div className="text-sm font-semibold">Drop a folder of stems here to add a track</div>
          <div className="text-xs mt-1" style={{ color: "var(--md-text-muted)" }}>
            …or click to choose a folder. The folder name becomes the track; each audio file becomes a stem.
            Files named <span style={{ color: "#f0a53a" }}>click / cue / iem</span> route to the in-ears automatically.
          </div>
        </>
      )}
    </div>
  );
}
