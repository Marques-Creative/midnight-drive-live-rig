/**
 * Multipart file upload routes for stems and backing tracks.
 * These bypass tRPC (which uses JSON) so there is no base64 overhead or body-size ceiling.
 *
 * POST /api/upload/stem
 *   fields: songId (number), name (string), outputRoute (string), sortOrder (number)
 *   file:   audio (any audio file)
 *   returns: { stem: StemRow }
 *
 * POST /api/upload/backing
 *   fields: songId (number), fileName (string)
 *   file:   audio (any audio file)
 *   returns: { key, url, fileSize, mimeType }
 */

import { Router, Request, Response } from "express";
import multer from "multer";
import { storagePut } from "./storage";
import { createStem, updateSong, getSongById } from "./db";

const router = Router();

// Store files in memory (buffer). multer v2 uses memoryStorage by default.
// v2 — multipart upload routes active (replaces base64-in-tRPC)
const upload = multer({ storage: multer.memoryStorage() });

// ── POST /api/upload/stem ────────────────────────────────────────────────────
router.post("/stem", upload.single("audio"), async (req: Request, res: Response) => {
  try {
    const file = req.file;
    if (!file) {
      res.status(400).json({ error: "No audio file provided" });
      return;
    }

    const songId = parseInt(req.body.songId, 10);
    if (isNaN(songId)) {
      res.status(400).json({ error: "Invalid songId" });
      return;
    }

    const name: string = req.body.name || file.originalname.replace(/\.[^.]+$/, "");
    const outputRoute: "main" | "click" | "guide" =
      (["main", "click", "guide"].includes(req.body.outputRoute) ? req.body.outputRoute : "main") as "main" | "click" | "guide";
    const sortOrder: number = parseInt(req.body.sortOrder, 10) || 0;

    // Sanitize filename
    const safeName = name.replace(/[^a-zA-Z0-9._-]/g, "_").replace(/_+/g, "_");
    const mimeType = file.mimetype || "audio/wav";
    const ext = mimeType.split("/")[1]?.replace("mpeg", "mp3") || "wav";
    const fileKey = `stems/${songId}/${Date.now()}-${safeName}.${ext}`;

    const { key, url } = await storagePut(fileKey, file.buffer, mimeType);

    const stem = await createStem({
      songId,
      name,
      fileKey: key,
      fileUrl: url,
      fileSize: file.size,
      mimeType,
      outputRoute,
      sortOrder,
    });

    res.json({ stem });
  } catch (err) {
    console.error("[upload/stem] Error:", err);
    res.status(500).json({ error: err instanceof Error ? err.message : "Upload failed" });
  }
});

// ── POST /api/upload/backing ─────────────────────────────────────────────────
router.post("/backing", upload.single("audio"), async (req: Request, res: Response) => {
  try {
    const file = req.file;
    if (!file) {
      res.status(400).json({ error: "No audio file provided" });
      return;
    }

    const songId = parseInt(req.body.songId, 10);
    if (isNaN(songId)) {
      res.status(400).json({ error: "Invalid songId" });
      return;
    }

    const fileName: string = req.body.fileName || file.originalname;
    const mimeType = file.mimetype || "audio/mpeg";
    const safeName = fileName.replace(/[^a-zA-Z0-9._-]/g, "_").replace(/_+/g, "_");
    const ext = mimeType.split("/")[1]?.replace("mpeg", "mp3") || "mp3";
    const fileKey = `songs/${songId}/backing-${Date.now()}-${safeName}.${ext}`;

    const { key, url } = await storagePut(fileKey, file.buffer, mimeType);

    // Update the song row with the new backing track info
    await updateSong(songId, {
      audioFileKey: key,
      audioFileUrl: url,
      audioFileSize: file.size,
      audioMimeType: mimeType,
    });

    res.json({ key, url, fileSize: file.size, mimeType });
  } catch (err) {
    console.error("[upload/backing] Error:", err);
    res.status(500).json({ error: err instanceof Error ? err.message : "Upload failed" });
  }
});

// ── POST /api/upload/deck ─────────────────────────────────────────────────────
// Uploads a DJ track for the deck. Returns a storage key; the client then sends
// { cmd:"loadDeck", fileKey, bpm } and the server resolves the key to a path.
router.post("/deck", upload.single("audio"), async (req: Request, res: Response) => {
  try {
    const file = req.file;
    if (!file) {
      res.status(400).json({ error: "No audio file provided" });
      return;
    }
    const mimeType = file.mimetype || "audio/wav";
    const safeName = (req.body.fileName || file.originalname).replace(/[^a-zA-Z0-9._-]/g, "_").replace(/_+/g, "_");
    const ext = mimeType.split("/")[1]?.replace("mpeg", "mp3") || "wav";
    const fileKey = `deck/${Date.now()}-${safeName}.${ext}`;

    const { key, url } = await storagePut(fileKey, file.buffer, mimeType);
    res.json({ key, url, fileSize: file.size, mimeType });
  } catch (err) {
    console.error("[upload/deck] Error:", err);
    res.status(500).json({ error: err instanceof Error ? err.message : "Upload failed" });
  }
});

export default router;
