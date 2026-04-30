# Installation, Packaging, and Testing

[English](INSTALLATION_PACKAGING_TESTING.en.md) | [简体中文](INSTALLATION_PACKAGING_TESTING.zh-CN.md)

This guide contains detailed setup, build, packaging, and test instructions for Tasi Harness.

## Requirements

- Node.js 20+
- npm 10+
- Windows, macOS, or Linux for desktop runtime/packaging

## Install Dependencies

```bash
npm install
```

If you only need type-checking or tests in restricted CI, you can skip Electron binary download:

```bash
ELECTRON_SKIP_BINARY_DOWNLOAD=1 npm install --ignore-scripts
```

## Run in Development

```bash
npm run dev
```

This starts:

- TypeScript compilation for Electron main/preload
- Vite dev server for renderer
- Electron app after dependencies are ready

## Build

```bash
npm run build
```

Build output is written to `dist/`.

## Package Desktop Binaries

```bash
npm run pack
npm run dist
npm run dist:win
npm run dist:mac
npm run dist:installers
powershell -ExecutionPolicy Bypass -File scripts/package-win-installer.ps1
bash scripts/package-macos-installer.sh
```

Artifacts are written to `release/`.

Notes:

- `npm run dist:win` builds a Windows `NSIS` installer.
- `npm run dist:mac` builds a macOS `DMG` installer.
- `npm run dist:installers` builds both targets.
- `scripts/package-win-installer.ps1` is Windows-focused.
- `scripts/package-macos-installer.sh` is macOS-focused.
- macOS packaging should normally run on a macOS host.

## Test

```bash
npm test
```

Vitest coverage includes:

- agent-loop tool execution
- memory behavior
- workspace safety checks
- skill parsing and updates
- personal knowledge base flows
- session document context flows

