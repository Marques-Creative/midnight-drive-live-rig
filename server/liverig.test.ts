import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { appRouter } from "./routers";
import type { TrpcContext } from "./_core/context";
import { getDb } from "./db";

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeCtx(): TrpcContext {
  return {
    user: {
      id: 1,
      openId: "test-user",
      email: "test@midnight.drive",
      name: "Test User",
      loginMethod: "manus",
      role: "admin",
      createdAt: new Date(),
      updatedAt: new Date(),
      lastSignedIn: new Date(),
    },
    req: { protocol: "https", headers: {} } as TrpcContext["req"],
    res: { clearCookie: () => {} } as unknown as TrpcContext["res"],
  };
}

// ── Songs ─────────────────────────────────────────────────────────────────────

describe("songs router", () => {
  const ctx = makeCtx();
  const caller = appRouter.createCaller(ctx);
  let createdSongId: number;

  it("creates a song", async () => {
    const result = await caller.songs.create({
      title: "Midnight Neon",
      artist: "Midnight Drive",
      bpm: 128,
      key: "Am",
      duration: 240,
      tags: "synth,opener",
      lyrics: "[00:00] Intro\nAm  F  C  G\n\n[00:20] Verse\nAm\nDriving through the dark",
    });
    expect(result).toBeDefined();
    // MySQL insertId comes back as a number
    createdSongId = (result as any).insertId ?? (result as any).id;
    expect(createdSongId).toBeGreaterThan(0);
  });

  it("lists songs and finds the created one", async () => {
    const songs = await caller.songs.list();
    const found = songs.find((s) => s.title === "Midnight Neon");
    expect(found).toBeDefined();
    expect(found?.bpm).toBe(128);
    expect(found?.key).toBe("Am");
  });

  it("fetches a song by id", async () => {
    const song = await caller.songs.byId({ id: createdSongId });
    expect(song).toBeDefined();
    expect(song?.title).toBe("Midnight Neon");
    expect(song?.lyrics).toContain("[00:00]");
  });

  it("updates a song", async () => {
    await caller.songs.update({
      id: createdSongId,
      data: { bpm: 130, key: "Dm" },
    });
    const updated = await caller.songs.byId({ id: createdSongId });
    expect(updated?.bpm).toBe(130);
    expect(updated?.key).toBe("Dm");
  });

  it("deletes a song", async () => {
    await caller.songs.delete({ id: createdSongId });
    const songs = await caller.songs.list();
    const found = songs.find((s) => s.id === createdSongId);
    expect(found).toBeUndefined();
  });
});

// ── Set Lists ─────────────────────────────────────────────────────────────────

describe("setLists router", () => {
  const ctx = makeCtx();
  const caller = appRouter.createCaller(ctx);
  let setListId: number;
  let songId: number;

  beforeAll(async () => {
    // Create a song to add to the set list
    const result = await caller.songs.create({
      title: "Test Song For SetList",
      bpm: 120,
    });
    songId = (result as any).insertId ?? (result as any).id;
  });

  afterAll(async () => {
    // Clean up
    if (songId) await caller.songs.delete({ id: songId }).catch(() => {});
  });

  it("creates a set list", async () => {
    const result = await caller.setLists.create({ name: "Test Night Set" });
    setListId = (result as any).insertId ?? (result as any).id;
    expect(setListId).toBeGreaterThan(0);
  });

  it("lists set lists", async () => {
    const lists = await caller.setLists.list();
    const found = lists.find((l) => l.name === "Test Night Set");
    expect(found).toBeDefined();
  });

  it("adds a song to the set list", async () => {
    await caller.setLists.addSong({ setListId, songId, position: 0 });
    const songs = await caller.setLists.songs({ setListId });
    expect(songs.length).toBe(1);
    expect(songs[0]?.songId).toBe(songId);
  });

  it("removes a song from the set list", async () => {
    await caller.setLists.removeSong({ setListId, songId });
    const songs = await caller.setLists.songs({ setListId });
    expect(songs.length).toBe(0);
  });

  it("deletes the set list", async () => {
    await caller.setLists.delete({ id: setListId });
    const lists = await caller.setLists.list();
    const found = lists.find((l) => l.id === setListId);
    expect(found).toBeUndefined();
  });
});

// ── Socket state type ─────────────────────────────────────────────────────────

describe("PlaybackState type", () => {
  it("has all required fields", async () => {
    const { getCurrentState } = await import("./socket");
    const state = getCurrentState();
    expect(state).toHaveProperty("songId");
    expect(state).toHaveProperty("isPlaying");
    expect(state).toHaveProperty("currentTime");
    expect(state).toHaveProperty("stems");
    expect(state).toHaveProperty("connectedCompanions");
    expect(Array.isArray(state.stems)).toBe(true);
  });
});

// ── Audio import flow (create song → uploadAudio) ─────────────────────────────

describe("songs.uploadAudio (import flow)", () => {
  const ctx = makeCtx();
  const caller = appRouter.createCaller(ctx);
  let importedSongId: number;

  it("creates a song with just a title (filename-derived)", async () => {
    const result = await caller.songs.create({ title: "Midnight Neon Remix" });
    importedSongId = (result as any).insertId ?? (result as any).id;
    expect(importedSongId).toBeGreaterThan(0);
  });

  it("uploads a backing track to the created song", async () => {
    // Minimal 44-byte WAV header encoded as base64 (valid enough for storagePut)
    const minimalWavBase64 = "UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=";
    const result = await caller.songs.uploadAudio({
      songId: importedSongId,
      fileBase64: minimalWavBase64,
      mimeType: "audio/wav",
      fileSize: 44,
      fileName: "midnight_neon_remix.wav",
    });
    expect(result).toBeDefined();
    expect((result as any)?.audioFileKey).toBeTruthy();
    expect((result as any)?.audioFileUrl).toBeTruthy();
  });

  it("song record reflects the uploaded audio", async () => {
    const song = await caller.songs.byId({ id: importedSongId });
    expect(song?.audioFileKey).toBeTruthy();
    expect(song?.audioMimeType).toBe("audio/wav");
  });

  it("cleans up: deletes the imported song", async () => {
    await caller.songs.delete({ id: importedSongId });
    const songs = await caller.songs.list();
    expect(songs.find((s) => s.id === importedSongId)).toBeUndefined();
  });
});

// ── titleFromFilename utility (pure function, tested inline) ──────────────────

describe("titleFromFilename (filename → song title)", () => {
  // Replicate the same logic used in SongLibrary.tsx
  function titleFromFilename(name: string): string {
    return name
      .replace(/\.[^.]+$/, "")
      .replace(/[_-]+/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .replace(/\b\w/g, (c) => c.toUpperCase());
  }

  it("strips file extension", () => {
    expect(titleFromFilename("song.mp3")).toBe("Song");
  });

  it("converts underscores to spaces and title-cases", () => {
    expect(titleFromFilename("midnight_neon_remix.wav")).toBe("Midnight Neon Remix");
  });

  it("converts hyphens to spaces", () => {
    expect(titleFromFilename("my-song-name.flac")).toBe("My Song Name");
  });

  it("handles mixed separators", () => {
    expect(titleFromFilename("track_01-intro.aiff")).toBe("Track 01 Intro");
  });

  it("handles already-spaced names", () => {
    expect(titleFromFilename("Midnight Drive Live.m4a")).toBe("Midnight Drive Live");
  });
});
