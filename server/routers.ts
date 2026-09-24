import { z } from "zod";
import { COOKIE_NAME } from "@shared/const";
import { getSessionCookieOptions } from "./_core/cookies";
import { systemRouter } from "./_core/systemRouter";
import { publicProcedure, router } from "./_core/trpc";
import os from "os";
import { getAllSongs, getSongById, createSong, updateSong, deleteSong, incrementSongPlayCount,
  getStemsBySongId, createStem, updateStem, deleteStem,
  getAllSetLists, getSetListById, createSetList, updateSetList, deleteSetList,
  getSetListSongs, addSongToSetList, removeSongFromSetList, reorderSetListSongs, reorderSetListSongsByRowId,
} from "./db";
import { storagePut, storageGetSignedUrl } from "./storage";

// ── Song input schemas ────────────────────────────────────────────────────────
const SongInput = z.object({
  title: z.string().min(1),
  artist: z.string().optional(),
  bpm: z.number().int().positive().optional().nullable(),
  key: z.string().optional().nullable(),
  duration: z.number().int().positive().optional().nullable(),
  tags: z.string().optional().nullable(),
  notes: z.string().optional().nullable(),
  lyrics: z.string().optional().nullable(),
  chords: z.string().optional().nullable(),
});

const StemInput = z.object({
  songId: z.number().int(),
  name: z.string().min(1),
  fileKey: z.string().optional().nullable(),
  fileUrl: z.string().optional().nullable(),
  fileSize: z.number().int().optional().nullable(),
  mimeType: z.string().optional().nullable(),
  volume: z.number().min(0).max(2).default(1.0),
  muted: z.boolean().default(false),
  pan: z.number().min(-1).max(1).default(0),
  outputRoute: z.enum(["main", "click", "guide"]).default("main"),
  sortOrder: z.number().int().default(0),
});

export const appRouter = router({
  system: systemRouter,

  // Returns the Mac's local network IP so the iPad companion QR code works
  localIp: publicProcedure.query(() => {
    const nets = os.networkInterfaces();

    // Only accept RFC-1918 private addresses:
    //   10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16
    function isPrivateIPv4(addr: string): boolean {
      if (addr.startsWith("10.")) return true;
      if (addr.startsWith("192.168.")) return true;
      const parts = addr.split(".");
      if (parts[0] === "172") {
        const second = parseInt(parts[1], 10);
        if (second >= 16 && second <= 31) return true;
      }
      return false;
    }

    // First pass: prefer known Wi-Fi/Ethernet interface names (en0, en1, eth0, wlan0)
    for (const name of ["en0", "en1", "eth0", "wlan0"]) {
      const iface = nets[name];
      if (!iface) continue;
      for (const addr of iface) {
        if (addr.family === "IPv4" && !addr.internal && isPrivateIPv4(addr.address)) {
          return { ip: addr.address };
        }
      }
    }
    // Second pass: any private IPv4 from any interface
    for (const iface of Object.values(nets)) {
      for (const addr of iface ?? []) {
        if (addr.family === "IPv4" && !addr.internal && isPrivateIPv4(addr.address)) {
          return { ip: addr.address };
        }
      }
    }
    return { ip: null };
  }),

  auth: router({
    me: publicProcedure.query(opts => opts.ctx.user),
    logout: publicProcedure.mutation(({ ctx }) => {
      const cookieOptions = getSessionCookieOptions(ctx.req);
      ctx.res.clearCookie(COOKIE_NAME, { ...cookieOptions, maxAge: -1 });
      return { success: true } as const;
    }),
  }),

  // ── Songs ──────────────────────────────────────────────────────────────────
  songs: router({
    list: publicProcedure.query(async () => {
      return getAllSongs();
    }),

    byId: publicProcedure
      .input(z.object({ id: z.number().int() }))
      .query(async ({ input }) => {
        return getSongById(input.id);
      }),

    create: publicProcedure
      .input(SongInput)
      .mutation(async ({ input }) => {
        return createSong(input);
      }),

    update: publicProcedure
      .input(z.object({ id: z.number().int(), data: SongInput.partial() }))
      .mutation(async ({ input }) => {
        await updateSong(input.id, input.data);
        return getSongById(input.id);
      }),

    delete: publicProcedure
      .input(z.object({ id: z.number().int() }))
      .mutation(async ({ input }) => {
        await deleteSong(input.id);
        return { success: true };
      }),

    incrementPlayCount: publicProcedure
      .input(z.object({ id: z.number().int() }))
      .mutation(async ({ input }) => {
        await incrementSongPlayCount(input.id);
        return { success: true };
      }),

    updateLyricCues: publicProcedure
      .input(z.object({ id: z.number().int(), lyricCues: z.string() }))
      .mutation(async ({ input }) => {
        await updateSong(input.id, { lyricCues: input.lyricCues });
        return getSongById(input.id);
      }),

    // Upload a stereo backing track for the song
    uploadAudio: publicProcedure
      .input(z.object({
        songId: z.number().int(),
        fileBase64: z.string(),
        mimeType: z.string(),
        fileSize: z.number().int(),
        fileName: z.string().optional(),
      }))
      .mutation(async ({ input }) => {
        const buffer = Buffer.from(input.fileBase64, "base64");
        const ext = input.mimeType.split("/")[1]?.replace("mpeg", "mp3") || "mp3";
        const fileKey = `audio/${input.songId}/${Date.now()}-backing.${ext}`;
        const { key, url } = await storagePut(fileKey, buffer, input.mimeType);
        await updateSong(input.songId, {
          audioFileKey: key,
          audioFileUrl: url,
          audioFileSize: input.fileSize,
          audioMimeType: input.mimeType,
        });
        return getSongById(input.songId);
      }),

    // Upload a stem file and create a stem record
    uploadStem: publicProcedure
      .input(z.object({
        songId: z.number().int(),
        name: z.string(),
        fileBase64: z.string(),
        mimeType: z.string(),
        fileSize: z.number().int(),
        outputRoute: z.enum(["main", "click", "guide"]).default("main"),
        sortOrder: z.number().int().default(0),
      }))
      .mutation(async ({ input }) => {
        const buffer = Buffer.from(input.fileBase64, "base64");
        // Sanitize the filename: replace spaces and unsafe URL characters with underscores
        const safeName = input.name.replace(/[^a-zA-Z0-9._-]/g, "_").replace(/_+/g, "_");
        const ext = input.mimeType.split("/")[1]?.replace("mpeg", "mp3") || "wav";
        const fileKey = `stems/${input.songId}/${Date.now()}-${safeName}.${ext}`;
        const { key, url } = await storagePut(fileKey, buffer, input.mimeType);
        return createStem({
          songId: input.songId,
          name: input.name,
          fileKey: key,
          fileUrl: url,
          fileSize: input.fileSize,
          mimeType: input.mimeType,
          outputRoute: input.outputRoute,
          sortOrder: input.sortOrder,
        });
      }),

    // Hot cue persistence — saves/clears per-song cue points in the DB
    saveHotCue: publicProcedure
      .input(z.object({
        songId:  z.number().int(),
        slot:    z.number().int().min(0).max(7),
        seconds: z.number(),
      }))
      .mutation(async ({ input }) => {
        const song = await getSongById(input.songId);
        if (!song) throw new Error("Song not found");
        const cues: number[] = JSON.parse(song.hotCues ?? "null") ?? Array(8).fill(-1);
        while (cues.length < 8) cues.push(-1);
        cues[input.slot] = input.seconds;
        await updateSong(input.songId, { hotCues: JSON.stringify(cues) });
        return { ok: true };
      }),

    clearHotCue: publicProcedure
      .input(z.object({
        songId: z.number().int(),
        slot:   z.number().int().min(0).max(7),
      }))
      .mutation(async ({ input }) => {
        const song = await getSongById(input.songId);
        if (!song) return { ok: true };
        const cues: number[] = JSON.parse(song.hotCues ?? "null") ?? Array(8).fill(-1);
        while (cues.length < 8) cues.push(-1);
        cues[input.slot] = -1;
        await updateSong(input.songId, { hotCues: JSON.stringify(cues) });
        return { ok: true };
      }),

    // Song marker storage — section labels + band notes on the waveform
    saveMarkers: publicProcedure
      .input(z.object({
        songId:  z.number().int(),
        markers: z.string(), // JSON array of SongMarker
      }))
      .mutation(async ({ input }) => {
        await updateSong(input.songId, { markers: input.markers });
        return { ok: true };
      }),

    // MIDI patch storage — auto-fired when a song loads onto a deck
    saveMidiPatches: publicProcedure
      .input(z.object({
        songId:  z.number().int(),
        patches: z.string(), // JSON array of patch objects
      }))
      .mutation(async ({ input }) => {
        await updateSong(input.songId, { midiPatches: input.patches });
        return { ok: true };
      }),
  }),
  stems: router({
    bySong: publicProcedure
      .input(z.object({ songId: z.number().int() }))
      .query(async ({ input }) => {
        return getStemsBySongId(input.songId);
      }),

    create: publicProcedure
      .input(StemInput)
      .mutation(async ({ input }) => {
        return createStem(input);
      }),

    update: publicProcedure
      .input(z.object({ id: z.number().int(), data: StemInput.partial() }))
      .mutation(async ({ input }) => {
        await updateStem(input.id, input.data);
        return { success: true };
      }),

    delete: publicProcedure
      .input(z.object({ id: z.number().int() }))
      .mutation(async ({ input }) => {
        await deleteStem(input.id);
        return { success: true };
      }),

    // Returns direct S3 presigned URLs for all stems of a song.
    // The audio engine uses these instead of /manus-storage/ proxy paths
    // to avoid CORS issues and sandbox memory pressure from large files.
    presignedUrls: publicProcedure
      .input(z.object({ songId: z.number().int() }))
      .query(async ({ input }) => {
        const stems = await getStemsBySongId(input.songId);
        const results = await Promise.all(
          stems.map(async (stem) => {
            if (!stem.fileKey) return { id: stem.id, url: null };
            try {
              const url = await storageGetSignedUrl(stem.fileKey);
              return { id: stem.id, url };
            } catch {
              return { id: stem.id, url: null };
            }
          })
        );
        return results;
      }),

    // Returns a local upload token — the browser POSTs to /api/upload/stem with this key hint.
    // (In local mode there is no S3; the multipart upload route writes directly to disk.)
    presignPutStem: publicProcedure
      .input(z.object({
        songId: z.number().int(),
        fileName: z.string(),
        mimeType: z.string(),
      }))
      .mutation(async ({ input }) => {
        const safeName = input.fileName.replace(/[^a-zA-Z0-9._-]/g, "_").replace(/_+/g, "_");
        const ext = input.mimeType.split("/")[1]?.replace("mpeg", "mp3") || "wav";
        const hash = crypto.randomUUID().replace(/-/g, "").slice(0, 8);
        const key = `stems/${input.songId}/${Date.now()}-${safeName}_${hash}.${ext}`;
        // In local mode, upload goes to /api/upload/stem (multipart)
        return { key, s3PutUrl: null, storageUrl: `/local-storage/${key}`, uploadUrl: "/api/upload/stem" };
      }),

    // Called after the browser finishes the S3 PUT to register the stem in the DB.
    confirmStemUpload: publicProcedure
      .input(z.object({
        songId: z.number().int(),
        name: z.string(),
        fileKey: z.string(),
        fileUrl: z.string(),
        fileSize: z.number().int().optional().nullable(),
        mimeType: z.string().optional().nullable(),
        outputRoute: z.enum(["main", "click", "guide"]).default("main"),
        sortOrder: z.number().int().default(0),
      }))
      .mutation(async ({ input }) => {
        return createStem(input);
      }),

    // Returns a local upload token — browser POSTs to /api/upload/backing (multipart).
    presignPutBacking: publicProcedure
      .input(z.object({
        songId: z.number().int(),
        fileName: z.string(),
        mimeType: z.string(),
        fileSize: z.number().int().optional().nullable(),
      }))
      .mutation(async ({ input }) => {
        const safeName = input.fileName.replace(/[^a-zA-Z0-9._-]/g, "_").replace(/_+/g, "_");
        const ext = input.mimeType.split("/")[1]?.replace("mpeg", "mp3") || "mp3";
        const hash = crypto.randomUUID().replace(/-/g, "").slice(0, 8);
        const key = `songs/${input.songId}/backing-${Date.now()}-${safeName}_${hash}.${ext}`;
        return { key, s3PutUrl: null, storageUrl: `/local-storage/${key}`, uploadUrl: "/api/upload/backing" };
      }),

    // Called after the browser finishes the S3 PUT to register the backing track in the DB.
    confirmBackingUpload: publicProcedure
      .input(z.object({
        songId: z.number().int(),
        fileKey: z.string(),
        fileUrl: z.string(),
        fileSize: z.number().int().optional().nullable(),
        mimeType: z.string().optional().nullable(),
      }))
      .mutation(async ({ input }) => {
        await updateSong(input.songId, {
          audioFileKey: input.fileKey,
          audioFileUrl: input.fileUrl,
          audioFileSize: input.fileSize,
          audioMimeType: input.mimeType,
        });
        return { success: true };
      }),

    // Returns a direct S3 presigned URL for the song's backing track.
    presignedBackingUrl: publicProcedure
      .input(z.object({ songId: z.number().int() }))
      .query(async ({ input }) => {
        const song = await getSongById(input.songId);
        if (!song?.audioFileKey) return { url: null };
        try {
          const url = await storageGetSignedUrl(song.audioFileKey);
          return { url };
        } catch {
          return { url: null };
        }
      }),
  }),

  // ── Set Lists ──────────────────────────────────────────────────────────────
  setLists: router({
    list: publicProcedure.query(async () => {
      return getAllSetLists();
    }),

    byId: publicProcedure
      .input(z.object({ id: z.number().int() }))
      .query(async ({ input }) => {
        return getSetListById(input.id);
      }),

    songs: publicProcedure
      .input(z.object({ setListId: z.number().int() }))
      .query(async ({ input }) => {
        return getSetListSongs(input.setListId);
      }),

    create: publicProcedure
      .input(z.object({ name: z.string().min(1), description: z.string().optional().nullable() }))
      .mutation(async ({ input }) => {
        return createSetList(input);
      }),

    update: publicProcedure
      .input(z.object({ id: z.number().int(), name: z.string().optional(), description: z.string().optional().nullable() }))
      .mutation(async ({ input }) => {
        const { id, ...data } = input;
        await updateSetList(id, data);
        return getSetListById(id);
      }),

    delete: publicProcedure
      .input(z.object({ id: z.number().int() }))
      .mutation(async ({ input }) => {
        await deleteSetList(input.id);
        return { success: true };
      }),

    addSong: publicProcedure
      .input(z.object({ setListId: z.number().int(), songId: z.number().int(), position: z.number().int().default(0) }))
      .mutation(async ({ input }) => {
        await addSongToSetList(input);
        return { success: true };
      }),

    removeSong: publicProcedure
      .input(z.object({ setListId: z.number().int(), songId: z.number().int() }))
      .mutation(async ({ input }) => {
        await removeSongFromSetList(input.setListId, input.songId);
        return { success: true };
      }),

    reorder: publicProcedure
      .input(z.object({ setListId: z.number().int(), orderedSongIds: z.array(z.number().int()) }))
      .mutation(async ({ input }) => {
        await reorderSetListSongs(input.setListId, input.orderedSongIds);
        return { success: true };
      }),

    // Insert a song immediately after a given position index (for live requests)
    // Duplicate-safe: uses row IDs not songIds for reordering
    insertAfterPosition: publicProcedure
      .input(z.object({
        setListId: z.number().int(),
        songId: z.number().int(),
        afterPosition: z.number().int(), // 0-based index of the song to insert after
      }))
      .mutation(async ({ input }) => {
        const existing = await getSetListSongs(input.setListId);
        // Add the new song at the end first to get its row ID
        await addSongToSetList({ setListId: input.setListId, songId: input.songId, position: existing.length });
        // Re-fetch to get the new row (including its auto-increment id)
        const updated = await getSetListSongs(input.setListId);
        // Build ordered row IDs with the new entry spliced after afterPosition
        const newRow = updated[updated.length - 1]; // just appended, so it's last
        const rowIds = existing.map((s) => s.id);
        rowIds.splice(input.afterPosition + 1, 0, newRow.id);
        await reorderSetListSongsByRowId(rowIds);
        return { success: true };
      }),

    // Duplicate-safe reorder by set_list_songs row IDs
    reorderByRowId: publicProcedure
      .input(z.object({ orderedRowIds: z.array(z.number().int()) }))
      .mutation(async ({ input }) => {
        await reorderSetListSongsByRowId(input.orderedRowIds);
        return { success: true };
      }),
  }),
});

export type AppRouter = typeof appRouter;
