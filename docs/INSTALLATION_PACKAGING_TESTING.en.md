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
- Installers include command-line launchers: `tasi.cmd` / `tasi-harness.cmd` in the Windows install directory, and `Contents/Resources/bin/tasi` / `tasi-harness` inside the macOS app bundle.

## Command-Line Usage

After installing on Windows, open a new PowerShell window:

```powershell
tasi chat "write a work plan for today"
tasi chat --session xxx "continue the last proposal"
tasi chat -s xxx -e sandbox "continue the last proposal"
tasi chat --execution sandbox --knowledge "answer with my personal knowledge base"
tasi sessions
```

If PowerShell still cannot find `tasi` immediately after installation, close all PowerShell / Windows Terminal windows and open a fresh one. You can inspect the resolved command with:

```powershell
Get-Command tasi
```

The installer writes the install directory to the current user's `PATH` and also creates `tasi.cmd` / `tasi-harness.cmd` shims under `%LOCALAPPDATA%\Microsoft\WindowsApps`. PowerShell uses `tasi.ps1`, while `cmd.exe` delegates `tasi.cmd` to the same PowerShell launcher; the launcher sets console input/output to UTF-8 without printing `chcp` output or clearing the terminal.

After installing the macOS app in `/Applications`:

```bash
/Applications/Tasi\ Harness.app/Contents/Resources/bin/tasi chat "write a work plan for today"
mkdir -p "$HOME/.local/bin"
ln -sf "/Applications/Tasi Harness.app/Contents/Resources/bin/tasi" "$HOME/.local/bin/tasi"
```

Common options:

- `--session <id>` / `-s <id>`: continue an existing session; `<id>` is the full session id and does not need a fixed prefix; omit it to create a new session
- `--execution workspace|sandbox` / `-e workspace|sandbox`: choose the execution mode
- `--knowledge` / `-k`: include personal knowledge base context
- `--plain` / `-p`: only print the raw Markdown stream; normal streamed output prints raw text first and then replaces it with a `marked-terminal` rendered version when complete
- `--json` / `-j`: print the full JSON result, including `sessionId`, `finalResponse`, `messages`, `toolEvents`, `usage`, and `execution`, for scripts to parse
- `--verbose` / `-V`: print tool events
- `--home <path>` / `-H <path>`: override the default data directory

Running `tasi` with no message starts an interactive chat with `:new`, `:session <id>`, and `:exit`. Each reply prints the current session id. The CLI shares the desktop app configuration and local data; browser automation tools run through external Chrome / Edge CDP mode.

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
