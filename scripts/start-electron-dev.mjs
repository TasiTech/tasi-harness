import { spawn } from 'node:child_process';
import electronPath from 'electron';

const devServerUrl = process.env.VITE_DEV_SERVER_URL || `http://127.0.0.1:${process.env.TASI_DEV_SERVER_PORT || '5187'}`;

const env = {
  ...process.env,
  VITE_DEV_SERVER_URL: devServerUrl
};
delete env.ELECTRON_RUN_AS_NODE;

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

const child = spawn(electronPath, ['.'], {
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
