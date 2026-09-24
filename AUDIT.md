# Midnight Drive Live Rig — Developer Audit Notes

This document is intended for a developer auditing the codebase or using it as a foundation for a new project (e.g., ROCKDJ).

---

## Architecture Summary

The app is a monorepo with three runtime contexts:

| Context | Entry point | Runtime |
|---|---|---|
| Electron main process | `electron/main.ts` → compiled to `dist-electron/main.js` | Electron's Node (ABI 146) |
| Express server | `server/_core/index.ts` → bundled to `dist-server/index.js` | Electron `utilityProcess` (same ABI) |
| React frontend | `client/src/main.tsx` → bundled by Vite | Electron Chromium renderer |

The Electron main process spawns the Express server as a `utilityProcess` (Electron's sandboxed child process). The renderer loads the frontend from the Express server at `http://localhost:47291`. All data access goes through tRPC procedures over HTTP.

---

## Data Flow

```
iPad/iPhone (Companion)
        │
        │ Socket.IO (Wi-Fi)
        ▼
Express server (port 47291)
  ├── tRPC procedures (songs, setlists, stems, system)
  ├── Socket.IO server (state broadcast, transport commands)
  ├── /local-storage/:filename (audio file serving)
  └── /api/upload (multipart file upload)
        │
        │ better-sqlite3 (synchronous)
        ▼
SQLite database (~/.midnight-drive/midnight-drive.db)

React frontend (Electron renderer)
  ├── useAudioEngine.ts (Web Audio API — multitrack playback)
  ├── tRPC hooks (data fetching/mutation)
  └── Socket.IO client (real-time state sync)
```

---

## Key Files for ROCKDJ Adaptation

### Audio Engine
`client/src/hooks/useAudioEngine.ts`

The entire multitrack engine. Uses Web Audio API directly — no third-party audio library. Key exported interface:

```typescript
interface AudioEngine {
  loadSong(songId: number, stems: Stem[]): Promise<void>;
  play(): void;
  pause(): void;
  stop(): void;
  seek(time: number): void;
  setVolume(stemId: number, volume: number): void;
  setMute(stemId: number, muted: boolean): void;
  setPan(stemId: number, pan: number): void;
  currentTime: number;
  isPlaying: boolean;
  duration: number;
}
```

Audio files are fetched from `/local-storage/<fileKey>` (served by Express from `MIDNIGHT_DRIVE_DATA_DIR/uploads/`).

### Database Schema
`drizzle/schema.ts`

Four tables:

- **`songs`** — title, artist, bpm, key, duration, tags, notes, lyrics, chords, lyricCues, audioFileKey, audioFileUrl, audioFileSize, audioMimeType, playCount
- **`stems`** — songId, name, fileKey, fileUrl, fileSize, mimeType, volume, muted, pan, outputRoute (main/click/guide), sortOrder
- **`set_lists`** — name, description
- **`set_list_songs`** — setListId, songId, position (join table with ordering)

### tRPC Procedures
`server/routers.ts`

All procedures are `publicProcedure` (no auth in Electron build). Namespaces:

- `songs.*` — CRUD + list
- `stems.*` — CRUD per song
- `setLists.*` — CRUD + song ordering
- `localIp` — returns Mac's LAN IP for QR code
- `system.*` — platform notifications (inert in Electron)

### Socket.IO State
`server/socket.ts` + `shared/socketTypes.ts`

The `PlaybackState` object is the single source of truth for the companion screen. The host LiveScreen pushes state patches via `socket.emit('updateState', patch)`. The companion receives the full state on connect and patches thereafter.

### Lyric Parser
`shared/lyricParser.ts`

Parses the custom `[MM:SS.s] [Chord] Text` format into `LyricCue[]`. Used by both the editor and the karaoke view. Fully unit-tested in `server/lyricParser.test.ts`.

### File Upload
`server/uploadRoutes.ts`

Uses `multer` for multipart uploads. Files are saved to `MIDNIGHT_DRIVE_DATA_DIR/uploads/` with a UUID filename. Returns `{ fileKey, fileUrl }` — `fileKey` is the relative path, `fileUrl` is the `/local-storage/` served URL.

---

## What to Keep for ROCKDJ

| Component | Keep as-is | Adapt | Replace |
|---|---|---|---|
| Electron main process (`electron/main.ts`) | ✓ | Rename app, change port | |
| Build script (`scripts/build-electron.sh`) | ✓ | Update app name/version | |
| Audio engine (`useAudioEngine.ts`) | ✓ | Add DJ features (crossfade, EQ) | |
| Socket.IO server + types | ✓ | Extend `PlaybackState` | |
| SQLite schema | | Extend for DJ data model | |
| tRPC procedures | | Add DJ-specific procedures | |
| Lyric parser | ✓ | | |
| Companion screen | | Redesign for DJ use case | |
| `server/_core/` | ✓ | | |

---

## Platform Code in `server/_core/`

The `server/_core/` directory contains scaffolding from the Manus web platform. In the Electron build, most of it is inert:

| File | Used in Electron? | Notes |
|---|---|---|
| `index.ts` | ✓ | Express app entry — keep |
| `trpc.ts` | ✓ | tRPC setup — keep |
| `context.ts` | ✓ | Request context — keep (user is always null) |
| `env.ts` | ✓ | Env var declarations — keep |
| `vite.ts` | Dev only | Vite middleware for dev server |
| `oauth.ts` | ✗ | Manus OAuth — inert, no redirect in Electron |
| `cookies.ts` | ✗ | Session cookies — inert |
| `llm.ts` | ✗ | Manus LLM API — inert |
| `notification.ts` | ✗ | Manus notifications — inert |
| `storageProxy.ts` | ✗ | Manus S3 storage — inert |
| `imageGeneration.ts` | ✗ | Manus image gen — inert |
| `voiceTranscription.ts` | ✗ | Manus Whisper — inert |
| `heartbeat.ts` | ✗ | Manus scheduled tasks — inert |

For a clean ROCKDJ project, you can safely delete the inert files and remove their imports from `index.ts` and `routers.ts`.

---

## Build Gotchas

1. **`better-sqlite3` ABI** — The native `.node` binary must be compiled for Electron's Node ABI (currently 146 for Electron 42). The build script handles this with `@electron/rebuild`. If you change the Electron version, the rebuild step will recompile automatically.

2. **`npmRebuild: false`** in `electron-builder.json5` — electron-builder's built-in rebuild only touches the project root `node_modules`, not `dist-server/node_modules` (which is in `extraResources`). We disable it and handle the rebuild manually in the build script.

3. **`utilityProcess` vs `child_process.spawn`** — The server runs inside Electron's `utilityProcess`, not a spawned system node binary. This is critical: it ensures `better-sqlite3` always runs with the correct ABI. Do not revert to `child_process.spawn`.

4. **Vite offline build** — The build script clears all Manus OAuth env vars (`VITE_OAUTH_PORTAL_URL=""` etc.) during `vite build`. Without this, the frontend tries to redirect to the Manus login portal on startup.

5. **`extraResources` split** — `electron-builder` silently ignores `node_modules` inside `extraResources` when using a single entry with `filter: ['**/*']`. The config splits it into two separate entries (one for server files, one for `node_modules`) to work around this.

---

## Test Coverage

Tests live in `server/*.test.ts` and run with Vitest:

```bash
pnpm test
```

| Test file | Coverage |
|---|---|
| `server/auth.logout.test.ts` | Auth logout procedure |
| `server/liverig.test.ts` | Song CRUD, set list CRUD, stem CRUD, localIp |
| `server/lyricParser.test.ts` | Lyric cue parser edge cases |

48 tests pass as of v1.1.0.

---

## No Code Exists Only in the Manus Workspace

All source code is in the GitHub repository and in this ZIP. The Manus workspace is a development environment — it does not hold any logic that is not present in the source files. The only things that exist only in the Manus environment are:

- The live SQLite database (`.data/midnight-drive.db`) — this is gitignored and contains only dev/test data
- Uploaded audio files in `.data/uploads/` — also gitignored
- Build artifacts (`dist/`, `dist-server/`, `dist-electron/`, `dist-app/`) — gitignored

None of these are needed to build and run the project from source.
