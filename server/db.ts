import { eq, asc, desc, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import Database from "better-sqlite3";
import path from "path";
import fs from "fs";
import {
  InsertUser, users, songs, stems, setLists, setListSongs,
  InsertSong, InsertStem, InsertSetList, InsertSetListSong,
} from "../drizzle/schema";

// ── Database initialisation ───────────────────────────────────────────────────
// In Electron the userData path is injected via MIDNIGHT_DRIVE_DATA_DIR.
// In plain Node dev mode we fall back to a local .data/ directory.
function getDbPath(): string {
  const dataDir = process.env.MIDNIGHT_DRIVE_DATA_DIR
    || path.join(process.cwd(), ".data");
  fs.mkdirSync(dataDir, { recursive: true });
  return path.join(dataDir, "midnight-drive.db");
}

let _db: ReturnType<typeof drizzle> | null = null;

export function getDb() {
  if (!_db) {
    const dbPath = getDbPath();
    const sqlite = new Database(dbPath);
    // Enable WAL mode for better concurrent read performance
    sqlite.pragma("journal_mode = WAL");
    sqlite.pragma("foreign_keys = ON");
    _db = drizzle(sqlite);
    // Auto-create tables on first run
    initSchema(sqlite);
  }
  return _db;
}

function initSchema(sqlite: InstanceType<typeof Database>) {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      openId TEXT NOT NULL UNIQUE,
      name TEXT,
      email TEXT,
      loginMethod TEXT,
      role TEXT NOT NULL DEFAULT 'user',
      createdAt INTEGER NOT NULL DEFAULT (unixepoch('now') * 1000),
      updatedAt INTEGER NOT NULL DEFAULT (unixepoch('now') * 1000),
      lastSignedIn INTEGER NOT NULL DEFAULT (unixepoch('now') * 1000)
    );

    CREATE TABLE IF NOT EXISTS songs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      artist TEXT DEFAULT 'Midnight Drive',
      bpm INTEGER,
      key TEXT,
      duration INTEGER,
      tags TEXT,
      notes TEXT,
      lyrics TEXT,
      chords TEXT,
      lyricCues TEXT,
      hotCues TEXT,
      audioFileKey TEXT,
      audioFileUrl TEXT,
      audioFileSize INTEGER,
      audioMimeType TEXT,
      playCount INTEGER NOT NULL DEFAULT 0,
      createdAt INTEGER NOT NULL DEFAULT (unixepoch('now') * 1000),
      updatedAt INTEGER NOT NULL DEFAULT (unixepoch('now') * 1000)
    );

CREATE TABLE IF NOT EXISTS stems (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      songId INTEGER NOT NULL,
      name TEXT NOT NULL,
      fileKey TEXT,
      fileUrl TEXT,
      fileSize INTEGER,
      mimeType TEXT,
      volume REAL NOT NULL DEFAULT 1.0,
      muted INTEGER NOT NULL DEFAULT 0,
      pan REAL NOT NULL DEFAULT 0.0,
      outputRoute TEXT NOT NULL DEFAULT 'main',
      sortOrder INTEGER NOT NULL DEFAULT 0,
      createdAt INTEGER NOT NULL DEFAULT (unixepoch('now') * 1000),
      updatedAt INTEGER NOT NULL DEFAULT (unixepoch('now') * 1000)
    );

    CREATE TABLE IF NOT EXISTS set_lists (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      description TEXT,
      createdAt INTEGER NOT NULL DEFAULT (unixepoch('now') * 1000),
      updatedAt INTEGER NOT NULL DEFAULT (unixepoch('now') * 1000)
    );

    CREATE TABLE IF NOT EXISTS set_list_songs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      setListId INTEGER NOT NULL,
      songId INTEGER NOT NULL,
      position INTEGER NOT NULL DEFAULT 0,
      createdAt INTEGER NOT NULL DEFAULT (unixepoch('now') * 1000)
    );
  `);
  // Migration: add hotCues column for existing databases without it
  try { sqlite.exec("ALTER TABLE songs ADD COLUMN hotCues TEXT"); } catch { /* already exists */ }
  try { sqlite.exec("ALTER TABLE songs ADD COLUMN midiPatches TEXT"); } catch { /* already exists */ }
  try { sqlite.exec("ALTER TABLE songs ADD COLUMN markers TEXT"); } catch { /* already exists */ }
}

// ── Users ─────────────────────────────────────────────────────────────────────
export async function upsertUser(user: InsertUser): Promise<void> {
  if (!user.openId) throw new Error("User openId is required for upsert");
  const db = getDb();
  const now = Date.now();
  const existing = await getUserByOpenId(user.openId);
  if (existing) {
    const updateData: Partial<InsertUser> = { updatedAt: new Date(now) };
    if (user.name !== undefined) updateData.name = user.name;
    if (user.email !== undefined) updateData.email = user.email;
    if (user.loginMethod !== undefined) updateData.loginMethod = user.loginMethod;
    if (user.lastSignedIn !== undefined) updateData.lastSignedIn = user.lastSignedIn;
    if (user.role !== undefined) updateData.role = user.role;
    db.update(users).set(updateData).where(eq(users.openId, user.openId)).run();
  } else {
    const insertData: InsertUser = {
      openId: user.openId,
      name: user.name ?? null,
      email: user.email ?? null,
      loginMethod: user.loginMethod ?? null,
      role: user.role ?? "user",
      lastSignedIn: user.lastSignedIn ?? new Date(now),
      createdAt: new Date(now),
      updatedAt: new Date(now),
    };
    db.insert(users).values(insertData).run();
  }
}

export async function getUserByOpenId(openId: string) {
  const db = getDb();
  const result = db.select().from(users).where(eq(users.openId, openId)).limit(1).all();
  return result.length > 0 ? result[0] : undefined;
}

// ── Songs ─────────────────────────────────────────────────────────────────────
export async function getAllSongs() {
  const db = getDb();
  return db.select().from(songs).orderBy(desc(songs.updatedAt)).all();
}

export async function getSongById(id: number) {
  const db = getDb();
  const result = db.select().from(songs).where(eq(songs.id, id)).limit(1).all();
  return result[0];
}

export async function createSong(data: InsertSong) {
  const db = getDb();
  const result = db.insert(songs).values({ ...data, createdAt: new Date(), updatedAt: new Date() }).run();
  return getSongById(Number(result.lastInsertRowid));
}

export async function updateSong(id: number, data: Partial<InsertSong>) {
  const db = getDb();
  db.update(songs).set({ ...data, updatedAt: new Date() }).where(eq(songs.id, id)).run();
}

export async function deleteSong(id: number) {
  const db = getDb();
  db.delete(stems).where(eq(stems.songId, id)).run();
  db.delete(setListSongs).where(eq(setListSongs.songId, id)).run();
  db.delete(songs).where(eq(songs.id, id)).run();
}

export async function incrementSongPlayCount(id: number) {
  const db = getDb();
  db.update(songs).set({ playCount: sql`playCount + 1` }).where(eq(songs.id, id)).run();
}

// ── Stems ─────────────────────────────────────────────────────────────────────
export async function getStemsBySongId(songId: number) {
  const db = getDb();
  return db.select().from(stems).where(eq(stems.songId, songId)).orderBy(asc(stems.sortOrder)).all();
}

export async function createStem(data: InsertStem) {
  const db = getDb();
  const result = db.insert(stems).values({ ...data, createdAt: new Date(), updatedAt: new Date() }).run();
  const rows = db.select().from(stems).where(eq(stems.id, Number(result.lastInsertRowid))).limit(1).all();
  return rows[0];
}

export async function updateStem(id: number, data: Partial<InsertStem>) {
  const db = getDb();
  db.update(stems).set({ ...data, updatedAt: new Date() }).where(eq(stems.id, id)).run();
}

export async function deleteStem(id: number) {
  const db = getDb();
  db.delete(stems).where(eq(stems.id, id)).run();
}

// ── Set Lists ─────────────────────────────────────────────────────────────────
export async function getAllSetLists() {
  const db = getDb();
  return db.select().from(setLists).orderBy(desc(setLists.updatedAt)).all();
}

export async function getSetListById(id: number) {
  const db = getDb();
  const result = db.select().from(setLists).where(eq(setLists.id, id)).limit(1).all();
  return result[0];
}

export async function createSetList(data: InsertSetList) {
  const db = getDb();
  const result = db.insert(setLists).values({ ...data, createdAt: new Date(), updatedAt: new Date() }).run();
  return getSetListById(Number(result.lastInsertRowid));
}

export async function updateSetList(id: number, data: Partial<InsertSetList>) {
  const db = getDb();
  db.update(setLists).set({ ...data, updatedAt: new Date() }).where(eq(setLists.id, id)).run();
}

export async function deleteSetList(id: number) {
  const db = getDb();
  db.delete(setListSongs).where(eq(setListSongs.setListId, id)).run();
  db.delete(setLists).where(eq(setLists.id, id)).run();
}

export async function getSetListSongs(setListId: number) {
  const db = getDb();
  const rows = db
    .select()
    .from(setListSongs)
    .where(eq(setListSongs.setListId, setListId))
    .orderBy(asc(setListSongs.position))
    .all();
  const result = await Promise.all(
    rows.map(async (row) => {
      const song = await getSongById(row.songId);
      return { ...row, song };
    })
  );
  return result.filter((r) => r.song !== undefined) as Array<typeof result[number] & { song: NonNullable<typeof result[number]["song"]> }>;
}

export async function addSongToSetList(data: InsertSetListSong) {
  const db = getDb();
  db.insert(setListSongs).values({ ...data, createdAt: new Date() }).run();
}

export async function removeSongFromSetList(setListId: number, songId: number) {
  const db = getDb();
  db.delete(setListSongs)
    .where(sql`${setListSongs.setListId} = ${setListId} AND ${setListSongs.songId} = ${songId}`)
    .run();
}

export async function reorderSetListSongs(setListId: number, orderedSongIds: number[]) {
  const db = getDb();
  orderedSongIds.forEach((songId, idx) => {
    db.update(setListSongs)
      .set({ position: idx })
      .where(sql`${setListSongs.setListId} = ${setListId} AND ${setListSongs.songId} = ${songId}`)
      .run();
  });
}

export async function reorderSetListSongsByRowId(orderedRowIds: number[]) {
  const db = getDb();
  orderedRowIds.forEach((rowId, idx) => {
    db.update(setListSongs)
      .set({ position: idx })
      .where(eq(setListSongs.id, rowId))
      .run();
  });
}
