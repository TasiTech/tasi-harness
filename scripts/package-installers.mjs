#!/usr/bin/env node

import { existsSync, readdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const rootDir = resolve(fileURLToPath(new URL('..', import.meta.url)));
const releaseDir = join(rootDir, 'release');
const argv = new Set(process.argv.slice(2));
const builderRetryCount = Math.max(1, Number(process.env.TASI_BUILDER_RETRIES ?? '3') || 3);
const builderRetryDelayMs = Math.max(0, Number(process.env.TASI_BUILDER_RETRY_DELAY_MS ?? '2000') || 2000);
const windowsExecutablePath = join(releaseDir, 'win-unpacked', 'Tasi Harness.exe');
const expectedWindowsMetadata = {
  productName: 'Tasi Harness',
  fileDescription: 'Tasi Harness'
};

function printUsage() {
  console.log(
    [
      'Usage:',
      '  node scripts/package-installers.mjs --win',
      '  node scripts/package-installers.mjs --mac',
      '  node scripts/package-installers.mjs --win --mac',
      '',
      'Options:',
      '  --win              Build the Windows NSIS installer.',
      '  --mac              Build the macOS DMG installer.',
      '  --skip-build       Skip `npm run build` before packaging.',
      '  --allow-cross-mac  Skip the macOS host check.',
      '',
      'Environment:',
      '  TASI_BUILDER_RETRIES          Retry count for electron-builder (default: 3).',
      '  TASI_BUILDER_RETRY_DELAY_MS   Delay between retries in milliseconds (default: 2000).',
      '  --help             Show this help message.'
    ].join('\n')
  );
}

function run(command, args, title) {
  console.log(`\n==> ${title}`);
  const result = spawnSync(command, args, {
    cwd: rootDir,
    encoding: 'utf8',
    shell: process.platform === 'win32'
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.error) {
    throw result.error;
  }
  return result;
}

function commandName(base) {
  return process.platform === 'win32' ? `${base}.cmd` : base;
}

function sleep(ms) {
  if (ms <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function clearReleaseDir(reason) {
  console.log(`\n==> ${reason}`);
  if (!existsSync(releaseDir)) {
    console.log(`Release directory does not exist: ${releaseDir}`);
    return;
  }
  rmSync(releaseDir, { recursive: true, force: true });
  console.log(`Removed ${releaseDir}`);
}

function ensureSuccess(result, title) {
  if (result.status === 0) return;
  const detail = [result.stderr?.trim(), result.stdout?.trim()].filter(Boolean).join('\n');
  const suffix = detail ? `\n${detail}` : '';
  throw new Error(`${title} failed with exit code ${result.status ?? 'unknown'}.${suffix}`);
}

function inspectWindowsExecutableMetadata(executablePath) {
  const escapedPath = executablePath.replace(/'/g, "''");
  const command = [
    `$item = Get-Item -LiteralPath '${escapedPath}'`,
    '$info = $item.VersionInfo',
    '[Console]::Out.Write((@{ ProductName=$info.ProductName; FileDescription=$info.FileDescription; CompanyName=$info.CompanyName } | ConvertTo-Json -Compress))'
  ].join('; ');
  const result = spawnSync('powershell.exe', ['-NoProfile', '-Command', command], {
    cwd: rootDir,
    encoding: 'utf8'
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = [result.stderr?.trim(), result.stdout?.trim()].filter(Boolean).join('\n');
    throw new Error(`Failed to inspect Windows executable metadata for ${executablePath}.${detail ? `\n${detail}` : ''}`);
  }
  const raw = (result.stdout ?? '').trim();
  if (!raw) throw new Error(`No metadata output received for ${executablePath}.`);
  return JSON.parse(raw);
}

function verifyWindowsExecutableIdentity() {
  if (process.platform !== 'win32') {
    console.warn('Skipping Windows executable identity check because current host is not Windows.');
    return;
  }
  if (!existsSync(windowsExecutablePath)) {
    throw new Error(`Expected Windows executable was not produced: ${windowsExecutablePath}`);
  }
  const metadata = inspectWindowsExecutableMetadata(windowsExecutablePath);
  const productName = String(metadata.ProductName ?? '').trim();
  const fileDescription = String(metadata.FileDescription ?? '').trim();
  if (productName !== expectedWindowsMetadata.productName || fileDescription !== expectedWindowsMetadata.fileDescription) {
    throw new Error(
      [
        `Windows executable metadata verification failed for ${windowsExecutablePath}.`,
        `Expected ProductName=${expectedWindowsMetadata.productName}, actual=${productName || '(empty)'}.`,
        `Expected FileDescription=${expectedWindowsMetadata.fileDescription}, actual=${fileDescription || '(empty)'}.`
      ].join(' ')
    );
  }
  console.log(`Verified Windows executable metadata: ProductName=${productName}, FileDescription=${fileDescription}.`);
}

function packageInstallers(command, args, targets) {
  let lastError;
  for (let attempt = 1; attempt <= builderRetryCount; attempt += 1) {
    clearReleaseDir(attempt === 1 ? 'Clearing release directory before packaging' : `Clearing release directory before retry ${attempt}`);
    const result = run(command, args, `Packaging installers (attempt ${attempt}/${builderRetryCount})`);
    if (result.status === 0) {
      try {
        if (targets.win) verifyWindowsExecutableIdentity();
        return;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
      }
    } else {
      lastError = new Error(`electron-builder exited with code ${result.status ?? 'unknown'}.`);
    }

    if (attempt < builderRetryCount) {
      console.warn(`Packaging attempt ${attempt}/${builderRetryCount} failed: ${lastError.message}`);
      console.warn(`Retrying in ${builderRetryDelayMs}ms...`);
      sleep(builderRetryDelayMs);
      continue;
    }
  }
  throw lastError ?? new Error('Packaging failed for an unknown reason.');
}

if (argv.has('--help')) {
  printUsage();
  process.exit(0);
}

const explicitTarget = argv.has('--win') || argv.has('--mac');
const targets = {
  win: argv.has('--win'),
  mac: argv.has('--mac')
};

if (!explicitTarget) {
  if (process.platform === 'win32') targets.win = true;
  else if (process.platform === 'darwin') targets.mac = true;
}

if (!targets.win && !targets.mac) {
  console.error('No packaging target selected. Use --win and/or --mac.');
  printUsage();
  process.exit(1);
}

const allowCrossMac = argv.has('--allow-cross-mac') || process.env.TASI_ALLOW_CROSS_MAC === '1';
if (targets.mac && process.platform !== 'darwin' && !allowCrossMac) {
  console.error(
    'macOS DMG packaging should normally run on a macOS host. Re-run this command on macOS, or pass --allow-cross-mac if you have a custom cross-build environment.'
  );
  process.exit(1);
}

const npm = commandName('npm');
if (!argv.has('--skip-build')) {
  ensureSuccess(run(npm, ['run', 'build'], 'Building app'), 'Building app');
}

const builderArgs = ['exec', 'electron-builder', '--', '--publish', 'never'];
if (targets.win) builderArgs.push('--win', 'nsis');
if (targets.mac) builderArgs.push('--mac', 'dmg');
packageInstallers(npm, builderArgs, targets);

let artifacts = [];
try {
  artifacts = readdirSync(releaseDir).sort();
} catch {
  artifacts = [];
}

console.log('\nPackaging completed.');
console.log(`Artifacts directory: ${releaseDir}`);
if (artifacts.length > 0) {
  console.log('Top-level release entries:');
  for (const name of artifacts) console.log(`- ${name}`);
}
