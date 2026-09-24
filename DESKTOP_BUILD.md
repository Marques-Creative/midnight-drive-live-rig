# Midnight Drive Live Rig — Desktop App Build Guide

This guide walks you through building the macOS desktop app on your M4 Mac.

---

## Prerequisites (one-time setup)

Install these tools on your Mac if you don't have them already.

### 1. Homebrew (Mac package manager)
Open Terminal and paste:
```bash
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
```

### 2. Node.js 20
```bash
brew install node@20
echo 'export PATH="/opt/homebrew/opt/node@20/bin:$PATH"' >> ~/.zshrc
source ~/.zshrc
```

### 3. pnpm (package manager)
```bash
npm install -g pnpm
```

### 4. Python 3 (needed to compile better-sqlite3)
```bash
brew install python3
```

### 5. Xcode Command Line Tools (needed for native module compilation)
```bash
xcode-select --install
```

---

## Build Steps

### Step 1 — Clone the repository
```bash
git clone https://github.com/YOUR_USERNAME/midnight-drive-live-rig.git
cd midnight-drive-live-rig
```

### Step 2 — Install dependencies
```bash
pnpm install
```

### Step 3 — Run the build script
```bash
chmod +x scripts/build-electron.sh
./scripts/build-electron.sh
```

This will:
1. Build the React frontend with Vite
2. Bundle the Express/tRPC server with esbuild
3. Compile the Electron main process
4. Rebuild `better-sqlite3` for Electron
5. Package everything into a `.dmg` installer

### Step 4 — Install the app
Open the `dist-app/` folder and double-click the `.dmg` file.
Drag **Midnight Drive Live Rig.app** to your Applications folder.

---

## Running in Development Mode (without building)

If you want to run the app directly without packaging:

```bash
pnpm install
pnpm dev
```

Then open `http://localhost:3000` in your browser.

To run as an Electron window in dev mode:
```bash
# Terminal 1 — start the server
pnpm dev

# Terminal 2 — start Electron pointing at the dev server
npx electron electron/main.ts
```

---

## Where Your Data Lives

All your songs, stems, and the database are stored in:
```
~/MidnightDrive/
├── midnight-drive.db        ← SQLite database (all song/set data)
└── files/
    ├── songs/               ← Backing track audio files
    └── stems/               ← Individual stem audio files
```

**To back up your data:** copy the entire `~/MidnightDrive/` folder.
**To move to a new Mac:** copy `~/MidnightDrive/` to the same path on the new machine.

---

## Audio File Formats Supported

- MP3 (`.mp3`)
- WAV (`.wav`)
- AIFF (`.aif`, `.aiff`)
- FLAC (`.flac`)
- M4A / AAC (`.m4a`, `.aac`)
- OGG (`.ogg`)

---

## Troubleshooting

### "App is damaged and can't be opened"
macOS Gatekeeper blocks unsigned apps. Run this in Terminal:
```bash
xattr -cr "/Applications/Midnight Drive Live Rig.app"
```

### App won't start / blank screen
Check if port 47291 is in use:
```bash
lsof -i :47291
```
If something is using it, kill it:
```bash
kill -9 $(lsof -ti :47291)
```

### better-sqlite3 build errors
Make sure Xcode Command Line Tools are installed:
```bash
xcode-select --install
```
Then try rebuilding:
```bash
npx electron-rebuild -f -w better-sqlite3
```

### Audio files not playing
The app serves audio from `~/MidnightDrive/files/`. If you moved the folder, restart the app.

---

## Multi-Output Audio Routing (Main + Click)

The app is pre-configured to route stems to different outputs:
- **Main** stems → stereo output (channels 1/2)
- **Click** stems → mono output (channel 3 or a separate device)
- **Guide** stems → mono output (channel 4 or a separate device)

To use this with a multi-output audio interface:
1. Open **Audio MIDI Setup** on your Mac
2. Create an **Aggregate Device** combining your main speakers and IEM/click output
3. Set this Aggregate Device as your default output in System Settings → Sound
4. The app will automatically route click/guide stems to the correct channels

---

## App Icon

To add a custom app icon, replace `electron/assets/icon.icns` with your own `.icns` file
(1024×1024 px recommended). You can convert a PNG to ICNS using:
```bash
# Install iconutil (comes with Xcode)
mkdir icon.iconset
sizearray=(16 32 64 128 256 512 1024)
for size in "${sizearray[@]}"; do
  sips -z $size $size your-icon.png --out icon.iconset/icon_${size}x${size}.png
done
iconutil -c icns icon.iconset -o electron/assets/icon.icns
```
