import {
  integer,
  sqliteTable,
  text,
  real,
} from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";

// ── Users ─────────────────────────────────────────────────────────────────────
export const users = sqliteTable("users", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  openId: text("openId").notNull().unique(),
  name: text("name"),
  email: text("email"),
  loginMethod: text("loginMethod"),
  role: text("role", { enum: ["user", "admin"] }).default("user").notNull(),
  createdAt: integer("createdAt", { mode: "timestamp_ms" }).default(sql`(unixepoch('now') * 1000)`).notNull(),
  updatedAt: integer("updatedAt", { mode: "timestamp_ms" }).default(sql`(unixepoch('now') * 1000)`).notNull(),
  lastSignedIn: integer("lastSignedIn", { mode: "timestamp_ms" }).default(sql`(unixepoch('now') * 1000)`).notNull(),
});

export type User = typeof users.$inferSelect;
export type InsertUser = typeof users.$inferInsert;

// ── Songs ─────────────────────────────────────────────────────────────────────
export const songs = sqliteTable("songs", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  title: text("title").notNull(),
  artist: text("artist").default("Midnight Drive"),
  bpm: integer("bpm"),
  key: text("key"),
  duration: integer("duration"), // seconds
  tags: text("tags"), // comma-separated
  notes: text("notes"),
  lyrics: text("lyrics"), // timestamped text format (legacy / Chart view)
  chords: text("chords"),
  lyricCues: text("lyricCues"), // raw cue string in [MM:SS.s] [Chord] Line format
  hotCues: text("hotCues"),
  midiPatches: text("midiPatches"),
  markers: text("markers"), // JSON: [{id,timeSeconds,label,note,color,type}] // JSON: [{label,channel,type,program,bankMSB,bankLSB,cc,value,delayMs}] // JSON: 8 cue positions in seconds, -1 = empty slot
  audioFileKey: text("audioFileKey"), // local relative path
  audioFileUrl: text("audioFileUrl"), // served URL (/local-storage/...)
  audioFileSize: integer("audioFileSize"),
  audioMimeType: text("audioMimeType"),
  playCount: integer("playCount").default(0).notNull(),
  createdAt: integer("createdAt", { mode: "timestamp_ms" }).default(sql`(unixepoch('now') * 1000)`).notNull(),
  updatedAt: integer("updatedAt", { mode: "timestamp_ms" }).default(sql`(unixepoch('now') * 1000)`).notNull(),
});

export type Song = typeof songs.$inferSelect;
export type InsertSong = typeof songs.$inferInsert;

// ── Stems ─────────────────────────────────────────────────────────────────────
export const stems = sqliteTable("stems", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  songId: integer("songId").notNull(),
  name: text("name").notNull(),
  fileKey: text("fileKey"), // local relative path
  fileUrl: text("fileUrl"), // served URL (/local-storage/...)
  fileSize: integer("fileSize"),
  mimeType: text("mimeType"),
  volume: real("volume").default(1.0).notNull(),
  muted: integer("muted", { mode: "boolean" }).default(false).notNull(),
  pan: real("pan").default(0.0).notNull(),
  outputRoute: text("outputRoute", { enum: ["main", "click", "guide"] }).default("main").notNull(),
  sortOrder: integer("sortOrder").default(0).notNull(),
  createdAt: integer("createdAt", { mode: "timestamp_ms" }).default(sql`(unixepoch('now') * 1000)`).notNull(),
  updatedAt: integer("updatedAt", { mode: "timestamp_ms" }).default(sql`(unixepoch('now') * 1000)`).notNull(),
});

export type Stem = typeof stems.$inferSelect;
export type InsertStem = typeof stems.$inferInsert;

// ── Set Lists ─────────────────────────────────────────────────────────────────
export const setLists = sqliteTable("set_lists", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  description: text("description"),
  createdAt: integer("createdAt", { mode: "timestamp_ms" }).default(sql`(unixepoch('now') * 1000)`).notNull(),
  updatedAt: integer("updatedAt", { mode: "timestamp_ms" }).default(sql`(unixepoch('now') * 1000)`).notNull(),
});

export type SetList = typeof setLists.$inferSelect;
export type InsertSetList = typeof setLists.$inferInsert;

// ── Set List Songs (join table with ordering) ─────────────────────────────────
export const setListSongs = sqliteTable("set_list_songs", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  setListId: integer("setListId").notNull(),
  songId: integer("songId").notNull(),
  position: integer("position").notNull().default(0),
  createdAt: integer("createdAt", { mode: "timestamp_ms" }).default(sql`(unixepoch('now') * 1000)`).notNull(),
});

export type SetListSong = typeof setListSongs.$inferSelect;
export type InsertSetListSong = typeof setListSongs.$inferInsert;
