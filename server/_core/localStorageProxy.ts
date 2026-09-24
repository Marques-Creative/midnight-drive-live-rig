/**
 * Local storage proxy — serves files from the local MidnightDrive data directory
 * at the /local-storage/* path, replacing the Manus /manus-storage/* proxy.
 *
 * Supports Range requests so the Web Audio API can stream large audio files.
 */

import fs from "fs";
import path from "path";
import type { Express } from "express";
import { storageKeyToPath } from "../storage";

export function registerLocalStorageProxy(app: Express) {
  app.get("/local-storage/*", (req, res) => {
    const rawKey = (req.params as Record<string, string>)[0];
    if (!rawKey) {
      res.status(400).send("Missing storage key");
      return;
    }
    const key = decodeURIComponent(rawKey);
    let filePath: string;
    try {
      filePath = storageKeyToPath(key);   // throws if the key escapes the data dir
    } catch {
      res.status(400).send("Invalid storage key");
      return;
    }

    if (!fs.existsSync(filePath)) {
      res.status(404).send("File not found");
      return;
    }

    const stat = fs.statSync(filePath);
    const fileSize = stat.size;

    // Infer content type from extension
    const ext = path.extname(filePath).toLowerCase();
    const mimeMap: Record<string, string> = {
      ".mp3": "audio/mpeg",
      ".wav": "audio/wav",
      ".ogg": "audio/ogg",
      ".flac": "audio/flac",
      ".aac": "audio/aac",
      ".m4a": "audio/mp4",
      ".mp4": "audio/mp4",
      ".webm": "audio/webm",
    };
    const contentType = mimeMap[ext] || "application/octet-stream";

    // Handle Range requests (required for Web Audio API streaming)
    const rangeHeader = req.headers.range;
    if (rangeHeader) {
      const parts = rangeHeader.replace(/bytes=/, "").split("-");
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
      const chunkSize = end - start + 1;

      res.writeHead(206, {
        "Content-Range": `bytes ${start}-${end}/${fileSize}`,
        "Accept-Ranges": "bytes",
        "Content-Length": chunkSize,
        "Content-Type": contentType,
        "Cache-Control": "private, max-age=3600",
        "Access-Control-Allow-Origin": "*",
      });
      fs.createReadStream(filePath, { start, end }).pipe(res);
    } else {
      res.writeHead(200, {
        "Content-Length": fileSize,
        "Content-Type": contentType,
        "Accept-Ranges": "bytes",
        "Cache-Control": "private, max-age=3600",
        "Access-Control-Allow-Origin": "*",
      });
      fs.createReadStream(filePath).pipe(res);
    }
  });
}
