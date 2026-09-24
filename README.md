# Midnight Drive Live Rig — Source Code Export

**Version:** 1.1.0  
**Platform:** macOS arm64 (Apple Silicon — M1/M2/M3/M4)  
**Export Date:** July 2026

---

## Overview

Midnight Drive Live Rig is a macOS Electron desktop application for live music performance. It bundles a React 19 frontend, an Express 4 + tRPC 11 backend, and a SQLite database (via better-sqlite3) into a single self-contained `.app`. An iPad/iPhone companion screen connects over local Wi-Fi (Socket.IO) to display lyrics, chords, and set list progress in real time.

The app is **fully offline** — no internet connection is required during a performance.

---

## Framework & Technology Stack

| Layer | Technology |
|---|---|
| Desktop shell | Electron 42.4.1 |
| Frontend | React 19 + Vite 6 + Tailwind CSS 4 |
| Backend (in-process) | Express 4 + tRPC 11 |
| Database | SQLite via better-sqlite3 + Drizzle ORM |
| Real-time sync | Socket.IO 4 |
| Language | TypeScript throughout |
| Package manager | pnpm 9 |
| Build tool | esbuild (server) + Vite (frontend) + electron-builder |

---

## Required Versions

| Tool | Required Version | Notes |
|---|---|---|
| Node.js | 20.x or 24.x | Must be installed at `/opt/homebrew/bin/node` (arm64) or `/usr/local/bin/node` (Intel) |
| pnpm | 9.x | `npm install -g pnpm` |
| Electron | 42.4.1 | Installed as a dev dependency — no separate install needed |
| macOS | 13+ (Ventura) | arm64 (Apple Silicon) target |
| Xcode CLI tools | Any recent | Required for native module compilation: `xcode-select --install` |

> **Important:** The app server runs inside Electron's `utilityProcess` (Electron's own Node runtime, ABI 146). The `better-sqlite3` native module is compiled for this ABI during the build. Do not substitute a different Electron version without re-running `@electron/rebuild`.

---

## Project Structure

```
midnight-drive-live-rig/
├── client/                    # React frontend (Vite)
│   ├── index.html
│   └── src/
│       ├── pages/             # Page-level components
│       │   ├── Dashboard.tsx      — Home dashboard
│       │   ├── SongLibrary.tsx    — Song list + import
│       │   ├── SongEditor.tsx     — Song metadata + stem management
│       │   ├── SetListBuilder.tsx — Set list creation + ordering
│       │   ├── LiveScreen.tsx     — Live performance view + QR code
│       │   ├── LyricCueEditor.tsx — Timestamped lyric/chord editor
│       │   └── Companion.tsx      — iPad/iPhone companion screen
│       ├── hooks/
│       │   └── useAudioEngine.ts  — Web Audio API multitrack engine
│       ├── components/
│       │   ├── KaraokeView.tsx    — Karaoke-style lyric display
│       │   └── QRCodeCanvas.tsx   — QR code generator
│       └── lib/trpc.ts            — tRPC client binding
├── server/
│   ├── routers.ts             — All tRPC procedures (songs, setlists, stems, system)
│   ├── db.ts                  — SQLite query helpers (Drizzle ORM)
│   ├── socket.ts              — Socket.IO server + state broadcast
│   ├── uploadRoutes.ts        — Multipart file upload endpoints
│   ├── storage.ts             — Local file storage helpers
│   └── _core/                 — Framework plumbing (do not edit)
│       ├── index.ts               — Express app + server entry point
│       ├── trpc.ts                — tRPC router setup
│       ├── context.ts             — Request context
│       └── env.ts                 — Environment variable declarations
├── shared/
│   ├── lyricParser.ts         — Timestamped lyric/chord cue parser
│   ├── socketTypes.ts         — Shared Socket.IO payload types
│   ├── types.ts               — Re-exports from schema + errors
│   └── const.ts               — Shared constants
├── drizzle/
│   ├── schema.ts              — SQLite table definitions (songs, stems, setLists, setListSongs)
│   ├── relations.ts           — Drizzle relation definitions
│   ├── 0000_mean_mojo.sql     — Initial migration
│   ├── 0001_*.sql … 0004_*.sql — Subsequent migrations
│   └── meta/                  — Drizzle migration metadata
├── electron/
│   ├── main.ts                — Electron main process
│   ├── server-package.json    — Runtime deps for dist-server npm install
│   ├── tsconfig.json          — TypeScript config for Electron main
│   └── assets/
│       └── midnight-drive-logo.webp
├── scripts/
│   └── build-electron.sh      — Full macOS build script
├── electron-builder.json5     — electron-builder packaging config
├── vite.config.ts             — Vite frontend build config
├── drizzle.config.ts          — Drizzle Kit config
├── tsconfig.json              — Root TypeScript config
├── vitest.config.ts           — Vitest test config
├── package.json
└── pnpm-lock.yaml
```

---

## Setup & Run Instructions (Development)

### 1. Clone and install

```bash
git clone <your-repo-url>
cd midnight-drive-live-rig
pnpm install
```

### 2. Set up environment variables

```bash
cp .env.example .env
# Edit .env — for local dev, the defaults work without changes
```

### 3. Run database migrations

The SQLite database is auto-created on first run. To apply migrations manually:

```bash
pnpm drizzle-kit migrate
```

### 4. Start the development server

```bash
pnpm dev
```

This starts the Express/tRPC server with hot reload via `tsx watch`. Open `http://localhost:3000` in a browser to use the web preview. The Electron shell is not used in dev mode.

### 5. Run tests

```bash
pnpm test
```

---

## Build Instructions (macOS Desktop App)

```bash
# Make the script executable (first time only)
chmod +x scripts/build-electron.sh

# Full build — produces dist-app/Midnight Drive Live Rig-1.1.0-arm64.dmg
./scripts/build-electron.sh
```

The build script performs these steps in order:

1. `pnpm install` — install all dependencies
2. `vite build` — compile the React frontend (with all Manus OAuth env vars cleared for offline mode)
3. `esbuild` — bundle the Express server to `dist-server/index.js` (CJS, all packages external)
4. Copy `dist/public` → `dist-server/public`
5. `npm install --omit=dev` inside `dist-server/` using `electron/server-package.json` (resolves full dep tree, no symlinks)
6. `tsc` — compile `electron/main.ts` → `dist-electron/main.js`
7. `@electron/rebuild` — rebuild `better-sqlite3` in `dist-server/` for Electron's Node ABI
8. `electron-builder` — package everything into a `.dmg` and `.zip`

Output: `dist-app/Midnight Drive Live Rig-1.1.0-arm64.dmg`

---

## Data Storage

| Data type | Location |
|---|---|
| SQLite database | `~/.midnight-drive/midnight-drive.db` (macOS) or `MIDNIGHT_DRIVE_DATA_DIR` env var |
| Audio files (main mix) | `~/.midnight-drive/uploads/` |
| Stem audio files | `~/.midnight-drive/uploads/` |
| Lyrics / chord cues | Stored as text in the SQLite `songs` table (`lyricCues` column) |

Audio files are served by the Express server at `/local-storage/<filename>`. The database stores the relative path (`audioFileKey`) and the served URL (`audioFileUrl`).

**There is no cloud storage.** All data is local to the Mac running the app.

---

## Multitrack Audio Engine

The multitrack player is **browser-based**, implemented entirely in `client/src/hooks/useAudioEngine.ts` using the **Web Audio API**. It runs inside the Electron Chromium renderer process.

Key capabilities:

- Loads multiple audio stems simultaneously via `AudioContext` + `AudioBufferSourceNode`
- Per-stem volume control (`GainNode`), mute, and pan (`StereoPannerNode`)
- Synchronized playback — all stems start at the same `AudioContext.currentTime` offset
- Seek support — stops all sources, re-fetches from server, restarts at target time
- Output routing: `main`, `click`, `guide` (routed to separate gain nodes for future multi-output support)
- Broadcasts playback state to Socket.IO so the iPad companion stays in sync

---

## Lyric & Chord Format

Lyrics and chords are stored in a custom timestamped cue format in the `lyricCues` column of the `songs` table. The parser lives in `shared/lyricParser.ts`.

**Format:**

```
[MM:SS.s] [Chord] Lyric line text
[MM:SS.s - MM:SS.s] [Chord] Line with karaoke fill end time
[Section Label]
```

**Example:**

```
[Verse 1]
[00:18.0] [Dm] Driving through the midnight rain
[00:22.5] [F] Neon signs blur in the dark
[Chorus]
[00:45.0 - 00:49.0] [Am] We were made for this
```

The `LyricCueEditor` page (`client/src/pages/LyricCueEditor.tsx`) provides a UI for editing these cues with a live preview.

---

## iPad Companion Screen

The companion screen (`/companion` route, `client/src/pages/Companion.tsx`) connects to the host Mac via Socket.IO over local Wi-Fi.

**Connection flow:**

1. On the Live Screen, click the Wi-Fi icon to open the QR code modal
2. The QR code encodes `http://<mac-local-ip>:47291/companion`
3. The local IP is resolved server-side via `os.networkInterfaces()`, preferring `en0`/`en1` and filtering to RFC-1918 private addresses only
4. Scan with iPhone/iPad — both devices must be on the same network (use iPhone Personal Hotspot for reliable performance at venues)

**Socket.IO events:**

| Event | Direction | Payload |
|---|---|---|
| `state` | host → companion | Full `PlaybackState` object |
| `updateState` | host → all | Partial `PlaybackState` patch |
| `transportCommand` | companion → host | `play`, `pause`, `stop`, `next`, `prev`, `seek` |

---

## Environment Variables

See `.env.example` for all variables. For local development and the Electron desktop build, **no external services are required** — all defaults work offline.

The `server/_core/env.ts` file declares which env vars are read at runtime.

---

## Known Bugs & Unfinished Areas

| Area | Status | Notes |
|---|---|---|
| Loading splash screen | Missing | Window shows blank briefly while Express server warms up (~1–2s) |
| Auto-updater | Not implemented | Updates require manual DMG rebuild and reinstall |
| macOS code signing | Not configured | macOS shows "unidentified developer" warning on first install; user must right-click → Open |
| Multi-output audio routing | Partial | `outputRoute` field (main/click/guide) is stored but not yet wired to separate audio outputs |
| Stem volume persistence | Partial | Volume changes during live performance are not saved back to the database |
| Windows/Linux build | Not supported | Build script is macOS-only; electron-builder config targets arm64 only |
| Song import metadata | Manual | BPM, key, and duration must be entered manually — no automatic audio analysis |
| Companion transport commands | Implemented | Play/pause/stop/next/prev/seek work from companion → host |

---

## External Services & Dependencies

**The app has no required external services for the Electron desktop build.** It runs fully offline.

The web development version (running in the Manus platform) uses:

- Manus OAuth for authentication (not needed in Electron — cleared during build)
- Manus platform database (MySQL/TiDB) — replaced by local SQLite in Electron

These platform dependencies are stripped during the Vite build via `VITE_OAUTH_PORTAL_URL=""` and related env vars. The `server/_core/` directory contains platform plumbing that is inert in the desktop build.

---

## Ownership & Licensing

You own all the code in this export. It was written specifically for this project and contains no proprietary third-party code beyond open-source npm packages (each governed by their own licenses — MIT, Apache 2.0, etc.). You are free to modify, redistribute, and use it as a foundation for other projects including ROCKDJ.

The `server/_core/` directory contains scaffolding from the Manus platform template. This code is also freely usable and modifiable.
