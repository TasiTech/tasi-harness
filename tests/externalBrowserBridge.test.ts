import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ExternalBrowserBridge } from '../src/main/browser/externalBrowserBridge.js';
import { defaultConfig, ensureDir } from '../src/main/storage/pathUtils.js';
import { tempHome } from './helpers.js';

describe('ExternalBrowserBridge', () => {
  it('falls back to isolated CDP profiles when system profile launch is unavailable', () => {
    const env = tempHome();
    const previousLocalAppData = process.env.LOCALAPPDATA;
    try {
      process.env.LOCALAPPDATA = env.home;
      ensureDir(join(env.home, 'Microsoft', 'Edge', 'User Data'));
      const bridge = new ExternalBrowserBridge({ runtimeDir: join(env.home, 'runtime') });
      const config = { ...defaultConfig(), externalBrowserProfileMode: 'system' as const };
      const executable = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';

      const attempts = (bridge as any).resolveCdpLaunchAttempts(config, executable, 'http://127.0.0.1:9222', false) as Array<{
        port: number;
        launchProfile: { mode: 'isolated' | 'system'; userDataDir: string };
      }>;
      expect(attempts[0]).toMatchObject({ port: 9222, launchProfile: { mode: 'system' } });
      expect(attempts.some((attempt) => attempt.port === 9222 && attempt.launchProfile.mode === 'isolated')).toBe(true);
      expect(attempts.some((attempt) => attempt.port === 9223 && attempt.launchProfile.mode === 'isolated')).toBe(true);

      const skipped = (bridge as any).resolveCdpLaunchAttempts(config, executable, 'http://127.0.0.1:9222', true) as Array<{
        launchProfile: { mode: 'isolated' | 'system' };
      }>;
      expect(skipped.every((attempt) => attempt.launchProfile.mode === 'isolated')).toBe(true);
    } finally {
      if (previousLocalAppData == null) delete process.env.LOCALAPPDATA;
      else process.env.LOCALAPPDATA = previousLocalAppData;
      env.cleanup();
    }
  });
});
