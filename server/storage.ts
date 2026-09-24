/**
 * Local filesystem storage — replaces the Manus S3/Forge storage layer.
 *
 * Files are stored in:
 *   MIDNIGHT_DRIVE_DATA_DIR/files/  (Electron: ~/MidnightDrive/files/)
 *   or .data/files/ in dev mode
 *
 * Files are served via the Express route /local-storage/* registered in
 * server/_core/localStorageProxy.ts.
 *
 * The public API (storagePut / storageGet) is intentionally identical to the
 * old Forge-backed version so all callers work without changes.
 */

import fs from "fs";
import path from "path";
import crypto from "crypto";

function getFilesDir(): string {
  const dataDir = process.env.MIDNIGHT_DRIVE_DATA_DIR
    || path.join(process.cwd(), ".data");
  const filesDir = path.join(dataDir, "files");
  fs.mkdirSync(filesDir, { recursive: true });
  return filesDir;
}

function appendHashSuffix(relKey: string): string {
  const hash = crypto.randomUUID().replace(/-/g, "").slice(0, 8);
  const lastDot = relKey.lastIndexOf(".");
  if (lastDot === -1) return `${relKey}_${hash}`;
  return `${relKey.slice(0, lastDot)}_${hash}${relKey.slice(lastDot)}`;
}

/**
 * Sanitize a storage key. SECURITY: keys come from HTTP requests
 * (GET /local-storage/<key>), so a raw key like "../../../../etc/passwd" must
 * never escape the files directory. We strip leading slashes, resolve the
 * candidate path, and require that it stays INSIDE getFilesDir(); anything
 * else throws.
 */
function normalizeKey(relKey: string): string {
  const cleaned = relKey.replace(/^\/+/, "");
  const filesDir = path.resolve(getFilesDir());
  const resolved = path.resolve(filesDir, cleaned);
  if (resolved !== filesDir && !resolved.startsWith(filesDir + path.sep)) {
    throw new Error(`Invalid storage key: ${relKey}`);
  }
  return path.relative(filesDir, resolved) || ".";
}

export async function storagePut(
  relKey: string,
  data: Buffer | Uint8Array | string,
  _contentType = "application/octet-stream",
): Promise<{ key: string; url: string }> {
  const key = appendHashSuffix(normalizeKey(relKey));
  const filesDir = getFilesDir();
  const fullPath = path.join(filesDir, key);
  // Ensure subdirectory exists
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, data as any);
  return { key, url: `/local-storage/${key}` };
}

export async function storageGet(relKey: string): Promise<{ key: string; url: string }> {
  const key = normalizeKey(relKey);
  return { key, url: `/local-storage/${key}` };
}

/** In local mode, "signed URLs" are just the regular local-storage path. */
export async function storageGetSignedUrl(relKey: string): Promise<string> {
  const key = normalizeKey(relKey);
  return `/local-storage/${key}`;
}

/** Resolve a storage key to its absolute path on disk. */
export function storageKeyToPath(key: string): string {
  return path.join(getFilesDir(), normalizeKey(key));
}
