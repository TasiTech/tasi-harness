import { spawn } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import electronPath from 'electron';

const devServerUrl = process.env.VITE_DEV_SERVER_URL || `http://127.0.0.1:${process.env.TASI_DEV_SERVER_PORT || '5187'}`;

const env = {
  ...process.env,
  VITE_DEV_SERVER_URL: devServerUrl
};
delete env.ELECTRON_RUN_AS_NODE;

function shellSingleQuote(value) {
  return String(value).replace(/'/g, "'\"'\"'");
}

function linuxSandboxArgs() {
  if (process.platform !== 'linux') return [];
  if (process.env.TASI_ELECTRON_REQUIRE_SETUID_SANDBOX === '1') return [];

  const sandboxPath = join(dirname(electronPath), 'chrome-sandbox');
  if (!existsSync(sandboxPath)) return [];

  const stat = statSync(sandboxPath);
  const hasSetuid = Boolean(stat.mode & 0o4000);
  const isRootOwned = stat.uid === 0;
  if (hasSetuid && isRootOwned) return [];

  const quotedSandboxPath = shellSingleQuote(sandboxPath);
  console.warn(
    [
      `Electron chrome-sandbox is not configured for setuid sandboxing: ${sandboxPath}`,
      'Starting Electron with --no-sandbox for this dev session.',
      'To use the setuid sandbox instead, run:',
      `  sudo chown root:root '${quotedSandboxPath}'`,
      `  sudo chmod 4755 '${quotedSandboxPath}'`,
      'Then restart npm run dev.'
    ].join('\n')
  );
  return ['--no-sandbox'];
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForTasiDevServer(url) {
  const deadline = Date.now() + Number(process.env.TASI_DEV_SERVER_TIMEOUT_MS || 30000);
  let lastError = '';

  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { cache: 'no-store' });
      const html = await response.text();
      if (response.ok && html.includes('<title>Tasi Harness</title>') && html.includes('/main.tsx')) {
        return;
      }
      lastError = `Unexpected response from ${url}. Another app may be running on that port.`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await sleep(250);
  }

  throw new Error(`Tasi dev server was not ready at ${url}. ${lastError}`);
}

await waitForTasiDevServer(devServerUrl);

const child = spawn(electronPath, [...linuxSandboxArgs(), '.'], {
  env,
  shell: false,
  stdio: 'inherit',
  windowsHide: false
});

child.on('error', (error) => {
  console.error(error);
  process.exit(1);
});

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});
