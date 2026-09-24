#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# build-electron.sh
# Builds the Midnight Drive Live Rig desktop app for macOS arm64 (M1/M2/M3/M4)
#
# Run from the project root:
#   chmod +x scripts/build-electron.sh
#   ./scripts/build-electron.sh
#
# Output: dist-app/  (contains .dmg and .zip)
# ─────────────────────────────────────────────────────────────────────────────
set -e

echo "🎸 Midnight Drive Live Rig — Desktop Build"
echo "==========================================="

# 1. Install dependencies
echo ""
echo "📦 Installing dependencies..."
pnpm install

# 2. Build the Vite frontend
# Clear OAuth/Manus env vars so the desktop build uses offline mode (no login redirect)
echo ""
echo "⚡ Building frontend (Vite) in offline/desktop mode..."
VITE_OFFLINE_BUILD=true \
  VITE_OAUTH_PORTAL_URL="" \
  VITE_APP_ID="" \
  VITE_FRONTEND_FORGE_API_KEY="" \
  VITE_FRONTEND_FORGE_API_URL="" \
  VITE_ANALYTICS_ENDPOINT="" \
  VITE_ANALYTICS_WEBSITE_ID="" \
  pnpm vite build

# 3. Bundle the Express server with esbuild
#    All npm packages stay external (--packages=external) so they can be
#    loaded as native CJS modules at runtime. better-sqlite3 is a native
#    .node binary and must always be external.
echo ""
echo "🔧 Bundling server..."
mkdir -p dist-server
npx esbuild server/_core/index.ts \
  --platform=node \
  --target=node20 \
  --packages=external \
  --bundle \
  --format=cjs \
  --outfile=dist-server/index.js \
  --external:better-sqlite3 \
  --external:electron \
  --external:vite \
  --define:process.env.NODE_ENV='"production"'

# Copy the Vite frontend output next to the server bundle
echo ""
echo "📋 Copying frontend assets next to server bundle..."
cp -r dist/public dist-server/public 2>/dev/null || cp -r dist dist-server/public

# Install ALL runtime node_modules using npm (not pnpm) so we get a flat,
# fully-resolved node_modules tree with no symlinks — safe to copy into .app
echo ""
echo "📦 Installing server runtime dependencies into dist-server..."
cp electron/server-package.json dist-server/package.json
cd dist-server
npm install --omit=dev --no-package-lock 2>&1 | tail -3
cd ..

# 4. Compile the Electron main process
echo ""
echo "⚡ Compiling Electron main process..."
mkdir -p dist-electron
npx tsc --project electron/tsconfig.json

# 5. Rebuild better-sqlite3 in dist-server for Electron's Node ABI.
#    The server runs inside Electron's utilityProcess, so better-sqlite3 must be
#    compiled for Electron's ABI (not the system node ABI).
#    We use @electron/rebuild directly on dist-server since electron-builder's
#    npmRebuild only touches the project root node_modules, not extraResources.
echo ""
echo "🔨 Rebuilding better-sqlite3 for Electron ABI..."
ELECTRON_VERSION=$(node -e "const p = require('./node_modules/electron/package.json'); console.log(p.version)")
echo "   Electron version: $ELECTRON_VERSION"
cd dist-server
npx @electron/rebuild -v "$ELECTRON_VERSION" -m . --only better-sqlite3 2>&1 | tail -3
cd ..

# 6. Run electron-builder
echo ""
echo "📦 Packaging app with electron-builder..."
npx electron-builder --config electron-builder.json5 --mac --arm64

echo ""
echo "✅ Build complete!"
echo "   Output: dist-app/"
echo ""
echo "To install: open dist-app/ and double-click 'Midnight Drive Live Rig-1.0.0-arm64.dmg'"
