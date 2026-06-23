import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const electronRequire = createRequire(import.meta.url);
const { app } = electronRequire('electron/main') as typeof import('electron/main');
const { nativeImage } = electronRequire('electron/common') as typeof import('electron/common');
const WINDOWS_APP_USER_MODEL_ID = 'com.tasiharness.desktop';

function assetCandidates(fileName: string): string[] {
  const appRoot = resolve(__dirname, '..', '..');
  return [
    resolve(appRoot, 'resources', fileName),
    resolve(process.resourcesPath, 'app.asar', 'resources', fileName),
    resolve(process.resourcesPath, 'app.asar.unpacked', 'resources', fileName),
    resolve(process.resourcesPath, 'resources', fileName)
  ];
}

function findAsset(fileNames: string[]): string | undefined {
  for (const fileName of fileNames) {
    for (const candidate of assetCandidates(fileName)) {
      if (existsSync(candidate)) return candidate;
    }
  }
  return undefined;
}

export function resolveAppWindowIconPath(): string | undefined {
  return process.platform === 'win32'
    ? findAsset(['app-icon.ico', 'app-icon.png'])
    : findAsset(['app-icon.png', 'app-icon.ico']);
}

export function applyPlatformAppIdentity(): void {
  if (process.platform === 'win32') {
    app.setAppUserModelId(WINDOWS_APP_USER_MODEL_ID);
  }
}

export function applyAppDockIcon(): void {
  if (process.platform !== 'darwin' || !app.dock) return;
  const iconPath = findAsset(['app-icon.png']);
  if (!iconPath) return;
  const icon = nativeImage.createFromPath(iconPath);
  if (icon.isEmpty()) return;
  app.dock.setIcon(icon);
}
