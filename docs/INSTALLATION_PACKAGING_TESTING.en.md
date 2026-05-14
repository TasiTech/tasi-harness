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

## First-Run Desktop Setup

1. Open **Settings** and choose a model provider, base URL, API key, and model name.
2. Choose a workspace directory. Generated files, browser artifacts, exported outputs, and editable session-document copies are written there.
3. Pick an execution mode:
   - `workspace`: tools operate directly in the configured workspace.
   - `sandbox`: each run gets a copied workspace under `~/.tasi-harness/sandboxes/`.
4. Enable only the tools you want the model to use. Risky file operations and terminal commands can trigger approval prompts when safety approval is enabled.
5. For browser tasks, choose embedded preview or external browser mode in **Settings**. External mode uses Chrome / Edge CDP where available.

## Desktop Usage

### Chat, Streaming, and Attachments

- Chat replies stream into the UI while the model is generating. Tool events are shown as they arrive.
- The chat input supports media attachments for models that can consume them:
  - images: screenshot analysis, UI inspection, visual Q&A
  - video: video-material review when the selected provider supports video input
  - audio: audio input for compatible OpenAI-style endpoints
- Multimodal support depends on the selected provider and model. Text-only models will still receive the text portion of the message, but may reject unsupported attachments.

### Session Documents vs Personal Knowledge

Tasi Harness has two document paths:

- **Session document upload** in Chat: attach documents to the current session. They are converted to bounded XML context and are useful for one-off analysis, rewriting, extraction, and document-grounded writing.
- **Personal Knowledge Base** in Knowledge: import documents into a reusable local knowledge store. They are converted to Markdown, chunked, and retrieved when the chat enables **Personal KB**.

Use session documents for temporary work on a specific file. Use Personal Knowledge for material you want to search and reuse across sessions.

### Image-and-Text Document Writing and Export

- Upload source documents or media in Chat, then ask for reports, summaries, proposals, or image-and-text drafts.
- Assistant replies can be exported from the message actions to PDF or DOCX.
- PDF export uses printable HTML and includes KaTeX styling for formulas.
- DOCX export preserves headings, tables, links, citations, and readable formula text where possible.

### Skills, Browser Coach, and Skill Optimization

Open **Skills** to:

- browse installed bundled/local skills
- browse and install marketplace skills
- upload skill archives
- create or edit local `SKILL.md` workflows
- record browser actions with Browser Coach and generate a reusable browser skill
- use the **Optimize** tab to inspect a previous session, identify failed skill behavior, and patch only the affected skill workflow

Skill optimization uses the normal agent runtime and the built-in skill-management guardrails. Broad cross-domain patches or attempts to downgrade failure signals are rejected.

### WeChat Channel

Configure WeChat in **Settings**:

1. Request a QR code and scan it with WeChat.
2. After login is confirmed, incoming WeChat messages are routed to a dedicated WeChat session.
3. WeChat text messages can trigger an agent reply.
4. WeChat document uploads are converted into session document XML context.
5. WeChat image/audio/video uploads can become multimodal attachments.
6. When the user asks to receive a generated file, the agent can use `wechat_send_file` to send a workspace file back to the active WeChat conversation.

WeChat file return only works for files inside the configured workspace and requires a ready channel token, latest user id, and context token.

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
- The Windows installer cleans the old application install directory before writing new files; the user data directory `~/.tasi-harness` is left intact. On startup, bundled skills from the installer are synced into the matching bundled-skill copies under `~/.tasi-harness/skills`, while other user-installed skills are left unchanged.

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
- streaming message deltas
- memory behavior
- workspace safety checks
- skill parsing and updates
- personal knowledge base flows
- session document context flows
- renderer Markdown, citation, and LaTeX rendering
- PDF/DOCX export helpers
- scheduled tasks and notification paths
