# OpenCLI Browser Bridge Extension

Place the unpacked OpenCLI browser extension files in this folder for packaged builds.

Required file:
- `manifest.json`

When running the packaged app, Tasi Harness will try to auto-load this extension from:
- `<process.resourcesPath>/opencli-extension`

For source builds or advanced setups, you can still override the extension directory by editing:
- `~/.tasi-harness/config.json`
- field: `opencliExtensionPath`
