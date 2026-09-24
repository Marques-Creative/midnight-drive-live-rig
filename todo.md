# Midnight Drive Live Rig — TODO

## Phase 1: Foundation
- [x] DB schema: songs, stems, setlists, setlist_songs tables
- [x] Global dark theme: deep blacks, electric blue, magenta accents, monospace typography
- [x] App routing: Dashboard, Song Library, Song Editor, Set List Builder, Live Screen, Companion
- [x] AppLayout with sidebar navigation

## Phase 2: Song Library
- [x] Song list page with search and filter by BPM/key/tags
- [x] Create/edit song form: title, BPM, key, duration, tags, notes
- [x] Lyrics and chords editor (timestamped text format)
- [x] Stem management: add/remove/rename stems per song
- [x] File import: upload audio stems via file picker (stored in S3)
- [x] Output route assignment per stem (main / click / guide)

## Phase 3: Set List Builder
- [x] Set list CRUD: create, rename, delete set lists
- [x] Add songs from library to a set list
- [x] Drag-and-drop reorder of songs in set list
- [x] Show song count and total duration
- [x] Save multiple set lists

## Phase 4: Live Performance Screen
- [x] Full-screen live mode layout (Mac-optimised)
- [x] Large song title, BPM, key display
- [x] Transport controls: Play, Pause, Stop, Next, Previous, Restart
- [x] Progress bar with elapsed/remaining time
- [x] Next song preview panel
- [x] Stem mixer: per-stem volume fader and mute toggle
- [x] Lyrics/chords panel: scrollable, synced to playback position
- [x] Safety guards: confirm on Stop/Next while playing
- [x] Emergency fade-out button
- [x] Fullscreen toggle

## Phase 5: WebSocket Sync & iPad Companion
- [x] WebSocket server integrated into Express (socket.io)
- [x] Mac broadcasts playback state: song, position, stems, lyrics scroll
- [x] QR code generator on Mac showing local network URL
- [x] iPad companion route (/companion) — read-only
- [x] Companion view: current song, next song, lyrics/chords, progress, BPM/key
- [x] Companion auto-reconnect on network drop
- [x] Companion count shown in Live Screen header

## Phase 6: Polish & Delivery
- [x] Responsive layout for iPad companion (tablet viewport)
- [x] Loading/empty states on all pages
- [x] Vitest unit tests: 12 tests, 2 test files, all passing
- [x] Checkpoint and delivery

## Phase 7: Web Audio Engine (Multitrack Playback)
- [x] useAudioEngine hook: AudioContext, per-stem AudioBufferSourceNode + GainNode
- [x] Fetch and decode stem audio files from S3 URLs into AudioBuffers
- [x] Sync all stems to a shared startTime offset so they play in lock-step
- [x] Wire Play/Pause/Stop/Restart transport controls to real audio playback
- [x] Wire volume faders to GainNode.gain.value in real time
- [x] Wire mute toggle to GainNode.gain.value (0 when muted, restore on unmute)
- [x] Sync currentTime display to AudioContext.currentTime during playback
- [x] Handle browser autoplay policy: resume AudioContext on first user gesture
- [x] Loading state while stems are being fetched and decoded
- [x] Clean up AudioContext and sources on song change or unmount
- [x] Emergency fade-out: ramp GainNode.gain to 0 over 3s using linearRampToValueAtTime
- [x] Broadcast real audio currentTime to WebSocket companions

## Phase 8: Karaoke Lyric System

- [x] Lyric cue format parser: [MM:SS.s] [Chord] Line text, with optional [start - end] duration
- [x] DB schema: add lyricCues TEXT column to songs table (stores raw cue string)
- [x] Shared type: LyricCue { startTime, endTime?, chord?, text, sectionLabel? }
- [x] WebSocket PlaybackState extended with: currentCueIndex, cues[]
- [x] Server tRPC: songs.updateLyricCues procedure
- [x] Lyric Cue Editor page at /songs/:id/cues
- [x] Paste raw lyrics into editor, split into lines
- [x] Play song from editor, tap "Cue Line" to stamp current playback time
- [x] Auto-advance to next line after each tap
- [x] Manual timestamp editing per line
- [x] Nudge buttons: -0.5s, -0.1s, +0.1s, +0.5s per line
- [x] Save finished lyric timeline to DB
- [x] Karaoke View component: prev/current/next line display
- [x] Karaoke fill progress: left-to-right highlight across current line when duration set
- [x] Section label display (e.g. [Verse 1], [Chorus])
- [x] Current chord badge, next chord preview
- [x] View switcher in Live Screen: Karaoke / Chart / Set
- [x] Set View: current song, next song, minimal lyrics
- [x] Extend WebSocket broadcast with current cue index and cue array
- [x] iPad Companion: full karaoke display (title, section, chord, prev/current/next, progress, next section)
- [x] iPad Companion: karaoke fill animation synced to received playback time
- [x] Vitest tests for lyric cue parser

## Phase 9: Song Library Drag-and-Drop Import

- [x] Full-page file drop overlay (neon blue border + FileAudio icon) when dragging audio files over the window
- [x] Import progress overlay with spinner and status text during create + upload
- [x] Empty-state: large drop zone with "Drop audio files here" CTA and Browse Files button
- [x] Songs-exist state: persistent dashed drop strip above song rows (click or drop)
- [x] Import Audio button in top bar (click-to-browse fallback for all states)
- [x] titleFromFilename: strips extension, converts underscores/hyphens to spaces, title-cases
- [x] Single-file import: creates song, uploads backing track, navigates to editor automatically
- [x] Multi-file import: imports all files, stays on library, shows success toast
- [x] Audio badge on song rows that have a backing track attached
- [x] Song-row drag (to set list) and file drag are properly disambiguated via dataTransfer.types
- [x] Tests: songs.uploadAudio import flow (4 tests) + titleFromFilename utility (5 tests) — 48 total passing

## Phase 10: Mixer Redesign — Vertical Faders

- [x] Vertical fader per channel using native range input with writing-mode: vertical-lr
- [x] Volume value (%) displayed below each fader, updates live as fader moves
- [x] Red M mute button beneath the value — glows red with shadow when active, ghost style when inactive
- [x] Channel strips stacked vertically (column layout, 80px wide), horizontally scrollable for many stems
- [x] Peak meter bar above fader, colour-coded by route (blue/yellow/magenta) and clips to red at >150%
- [x] Backing track master channel uses same vertical layout with component-level state (no hooks-in-render)
- [x] 48 tests passing, 0 TypeScript errors

## Phase 11: Companion Remote Transport Control

- [x] TransportCommand type added to shared/socketTypes.ts (play, pause, stop, next, prev, seek)
- [x] Socket server forwards transportCommand events from companion clients to all host clients
- [x] LiveScreen listens for transportCommand and drives audio engine via stable ref handler
- [x] Companion page: CONTROL toggle button in status bar (off by default, glows magenta when active)
- [x] Companion page: transport bar slides in below status bar when Control Mode is on
- [x] Transport bar shows: prev, play/pause (large, colour-coded), stop, next — all disabled when not connected
- [x] Buttons disabled/dimmed when action is not applicable (e.g. prev at first song, stop when idle)
- [x] 48 tests passing, 0 TypeScript errors

## Phase 12: Mixer Memory (Per-Song Persistence)

- [x] Mixer settings (volume + mute per stem) already stored in stems table via updateStem on every fader commit and mute toggle
- [x] stemOverrides pre-seeded from DB values when stems load for a new song — mixer UI shows saved state immediately
- [x] "saving…" spinner, "✓ saved" and "⚠ save failed" indicators in mixer header bar
- [x] 48 tests passing, 0 TypeScript errors

## Phase 13: Mid-Set Management Panel

- [x] tRPC procedure: insertAfterPosition (inserts song at specific position in set list)
- [x] tRPC procedure: reorder (already existed, reused for live drag reorder)
- [x] Live Screen: SET button in top bar (only visible when a set list is active, magenta when open)
- [x] Slide-over panel: full set order with drag-to-reorder handles (past songs dimmed)
- [x] Slide-over panel: quick-add search to find any song in library and insert after current song
- [x] Currently playing song pinned with lock icon, cannot be dragged
- [x] Changes take effect immediately without stopping or interrupting playback
- [x] 48 tests passing, 0 TypeScript errors

## Phase 14: Fix Stem Uploads (Multipart)
- [x] Root cause: base64-in-tRPC JSON body hits 50MB limit for large audio files
- [x] New Express route: POST /api/upload/stem (multer multipart, no size ceiling)
- [x] New Express route: POST /api/upload/backing (multer multipart, no size ceiling)
- [x] SongEditor: handleFileUpload, handleAudioUpload, handleReplaceStemFile all use multipart fetch
- [x] SongLibrary: drag-and-drop importFiles uses multipart fetch for backing track
- [x] Removed unused tRPC uploadAudio/uploadStem mutations from SongEditor
- [x] 48 tests passing, 0 TypeScript errors

## Phase 15: Dashboard Background Redesign
- [x] Background image (neon water reflections) applied to body — spans full screen including behind sidebar
- [x] Gradient overlay on body: dark on left (readability), transparent on right (neon visible)
- [x] Sidebar: semi-transparent glass effect (rgba(8,10,15,0.72) + backdrop-filter: blur(16px))
- [x] Sidebar border updated to neon blue tint (rgba(0,180,255,0.18))
- [x] Dashboard cards: glassy style with backdrop-filter blur and neon blue/magenta borders
- [x] Removed duplicate fixed background divs from Dashboard.tsx (now handled by body CSS)
- [x] 0 TypeScript errors

## Phase 16: Electron Desktop App Conversion
- [x] Install better-sqlite3, electron, electron-builder as dependencies
- [x] Migrate drizzle/schema.ts from MySQL types to SQLite types
- [x] Rewrite server/db.ts to use drizzle-orm/better-sqlite3 (local SQLite file in ~/MidnightDrive/)
- [x] Rewrite server/storage.ts to write files to ~/MidnightDrive/files/ instead of S3
- [x] Create server/_core/localStorageProxy.ts to serve /local-storage/* with Range support
- [x] Update server/_core/index.ts to use localStorageProxy instead of storageProxy
- [x] Remove S3 presign calls; upload routes now use local storagePut
- [x] Update SongEditor.tsx and SongLibrary.tsx upload flows to use multipart /api/upload/*
- [x] Update useAudioEngine.ts to handle /local-storage/ URLs
- [x] Copy logo and background assets to client/public/ for bundling
- [x] Update AppLayout.tsx and index.css to use bundled asset paths (no manus-storage refs)
- [x] Create electron/main.ts (Electron main process with dynamic port detection)
- [x] Create electron/tsconfig.json for compiling main process
- [x] Create electron-builder.json5 for macOS arm64 packaging
- [x] Create scripts/build-electron.sh (one-command build)
- [x] Update package.json with electron:build scripts
- [x] Add offline auth bypass in server/_core/context.ts (auto-creates local user, no login needed)
- [x] Disable OAuth redirect in client/src/main.tsx when no portal URL configured
- [x] Fix server/_core/vite.ts static path for Electron production mode
- [x] Write DESKTOP_BUILD.md guide with step-by-step instructions for Mac M4
## Phase 17: Web Preview Fix & Electron Build Polish
- [x] Rebuild better-sqlite3 native binary for Linux sandbox (pnpm rebuild better-sqlite3)
- [x] All 48 tests passing after rebuild
- [x] Add directories.output: "dist-app" to electron-builder.json5 so packaged app goes to dist-app/
- [x] Add .data/ to .gitignore to prevent SQLite dev database from being committed

## Phase 18: Fix Electron Blank Window
- [x] Root cause: esbuild CJS bundle replaces import.meta with empty object, so import.meta.dirname is undefined in production
- [x] Fix server/_core/vite.ts: use getDirname() helper that checks __dirname first (injected by esbuild in CJS) then falls back to fileURLToPath(import.meta.url) for ESM dev mode
- [x] 48 tests still passing, dev server still starts correctly

## Phase 19: Fix Missing Runtime node_modules in Electron Bundle
- [x] Root cause: build script used --packages=external but only copied better-sqlite3 to dist-server/node_modules — all other packages (dotenv, express, @trpc/server, drizzle-orm, socket.io, etc.) were missing
- [x] Fix: build script now copies all 13 required runtime packages plus their peer dependencies into dist-server/node_modules
- [x] Verified: dist-server/index.js now starts cleanly with "Server running on http://localhost:3001/"

## Phase 20: Fix Transitive Dependency Resolution in Electron Bundle
- [x] Root cause: cp -r of pnpm node_modules copies symlinks, not real files — symlinks break inside .app bundle
- [x] Root cause 2: manual package list missed transitive deps (body-parser, busboy, etc.)
- [x] Fix: build script now runs npm install --omit=dev inside dist-server/ using electron/server-package.json
- [x] npm resolves the full transitive dep tree with real files (no symlinks), safe to bundle in .app
- [x] Verified: server starts cleanly with "Server running on http://localhost:3001/"

## Phase 21: Fix Electron Blank Window — Diagnostics & Port Fix
- [x] Confirmed: server correctly starts on PORT=47291 when env var is passed
- [x] Fix server/_core/index.ts: skip dotenv in production (esbuild tree-shakes it away with --define:process.env.NODE_ENV='"production"')
- [x] Rewrite electron/main.ts: add startup log file (/tmp/midnight-drive-startup.log), always open DevTools, check / instead of /api/trpc in waitForServer, log all port detection steps
- [x] 48 tests passing

## Phase 22: Fix Server Spawn — Wrong Node Binary
- [x] Root cause: process.execPath in Electron points to the Electron binary, not node — server exits immediately with code 0
- [x] Fix: search common macOS node locations (/opt/homebrew/bin/node, /usr/local/bin/node, ~/.nvm/versions/node/*/bin/node) and use the first one found
- [x] If no node found, show clear error dialog with install instructions

## Phase 23: Fix better-sqlite3 ABI Mismatch
- [x] Root cause: electron-rebuild was overwriting dist-server/node_modules/better-sqlite3 with a binary compiled for Electron's Node ABI (146), but the server runs with system node (ABI 115)
- [x] Fix: remove electron-rebuild step for dist-server — npm install already installs the correct binary for the system node

## Phase 24: Fix iPad Companion QR Code
- [x] Add `localIp` tRPC endpoint that returns Mac's local network IP via `os.networkInterfaces()`
- [x] Update LiveScreen to use local IP in QR code URL instead of `window.location.origin` (localhost)
- [x] Falls back to localhost if no network IP found
