#!/usr/bin/env node

import { appendFileSync, chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const rootDir = resolve(fileURLToPath(new URL('..', import.meta.url)));
const releaseDir = join(rootDir, 'release');
const argv = new Set(process.argv.slice(2));
const builderRetryCount = Math.max(1, Number(process.env.TASI_BUILDER_RETRIES ?? '3') || 3);
const builderRetryDelayMs = Math.max(0, Number(process.env.TASI_BUILDER_RETRY_DELAY_MS ?? '2000') || 2000);
const windowsExecutablePath = join(releaseDir, 'win-unpacked', 'Tasi Harness.exe');
const linuxUnpackedPath = join(releaseDir, 'linux-unpacked');
const packageMetadata = JSON.parse(readFileSync(join(rootDir, 'package.json'), 'utf8'));
const macCliScripts = [join(rootDir, 'build', 'cli', 'mac', 'tasi'), join(rootDir, 'build', 'cli', 'mac', 'tasi-harness')];
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
      '  node scripts/package-installers.mjs --ubuntu',
      '  node scripts/package-installers.mjs --ubuntu-deb',
      '  node scripts/package-installers.mjs --win --mac',
      '',
      'Options:',
      '  --win              Build the Windows NSIS installer.',
      '  --mac              Build the macOS DMG installer.',
      '  --ubuntu           Build the Ubuntu/Linux executable .bin installer.',
      '  --ubuntu-bin       Alias for --ubuntu.',
      '  --ubuntu-deb       Build the Ubuntu Debian package.',
      '  --skip-build       Skip `npm run build` before packaging.',
      '  --allow-cross-mac  Skip the macOS host check.',
      '  --allow-cross-ubuntu',
      '                     Skip the Ubuntu/Linux host check.',
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
  const spawnCommand = process.platform === 'win32' && command.toLowerCase().endsWith('.cmd')
    ? process.env.ComSpec || 'cmd.exe'
    : command;
  const spawnArgs = spawnCommand !== command
    ? ['/d', '/c', command, ...args]
    : args;
  const result = spawnSync(spawnCommand, spawnArgs, {
    cwd: rootDir,
    encoding: 'utf8'
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

function prepareCliAssets(targets) {
  if (!targets.mac) return;
  for (const scriptPath of macCliScripts) {
    if (!existsSync(scriptPath)) {
      throw new Error(`Expected macOS CLI launcher is missing: ${scriptPath}`);
    }
    chmodSync(scriptPath, 0o755);
  }
}

function parseSkillFrontmatter(content) {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return {};
  const data = {};
  for (const raw of match[1].split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const idx = line.indexOf(':');
    if (idx < 0) continue;
    data[line.slice(0, idx).trim()] = line.slice(idx + 1).trim().replace(/^['"]|['"]$/g, '');
  }
  return data;
}

function findSkillFiles(root) {
  if (!existsSync(root)) return [];
  const out = [];
  const visit = (dir) => {
    for (const name of readdirSync(dir)) {
      const file = join(dir, name);
      const stat = statSync(file);
      if (stat.isDirectory()) visit(file);
      else if (name === 'SKILL.md') out.push(file);
    }
  };
  visit(root);
  return out;
}

function generateBundledSkillManifest(targets) {
  if (!targets.win) return;
  const skillsRoot = join(rootDir, 'resources', 'skills');
  const manifestPath = join(rootDir, 'build', 'nsis', 'bundled-skills.json');
  const skills = findSkillFiles(skillsRoot).map((file) => {
    const frontmatter = parseSkillFrontmatter(readFileSync(file, 'utf8'));
    const folder = String(file.split(/[\\/]/).at(-2) || '').trim();
    return {
      name: String(frontmatter.name || folder).trim(),
      folder,
      category: String(frontmatter.category || file.split(/[\\/]/).at(-3) || '').trim()
    };
  }).filter((skill) => skill.name).sort((a, b) => (a.folder || a.name).localeCompare(b.folder || b.name));
  mkdirSync(join(rootDir, 'build', 'nsis'), { recursive: true });
  writeFileSync(manifestPath, `${JSON.stringify({ generatedAt: new Date().toISOString(), skills }, null, 2)}\n`, 'utf8');
  console.log(`Generated bundled skill manifest: ${manifestPath} (${skills.length} skills)`);
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

function hadRecoveredRceditFailure(result) {
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  return output.includes('rcedit') && output.includes('Fatal error: Unable to commit changes');
}

function applyWindowsExecutableMetadata() {
  if (process.platform !== 'win32') return;
  if (!existsSync(windowsExecutablePath)) {
    throw new Error(`Cannot repair Windows executable metadata because the executable is missing: ${windowsExecutablePath}`);
  }
  const localAppData = process.env.LOCALAPPDATA;
  if (!localAppData) throw new Error('LOCALAPPDATA is not set; cannot locate rcedit.');
  const rcedit = join(localAppData, 'electron-builder', 'Cache', 'winCodeSign', 'winCodeSign-2.6.0', 'rcedit-x64.exe');
  if (!existsSync(rcedit)) throw new Error(`rcedit was not found: ${rcedit}`);
  const productName = String(packageMetadata.build?.productName ?? packageMetadata.productName ?? expectedWindowsMetadata.productName);
  const version = String(packageMetadata.version ?? '0.0.0');
  const productVersion = /^\d+\.\d+\.\d+$/.test(version) ? `${version}.0` : version;
  const copyright = `Copyright © ${new Date().getFullYear()} ${productName}`;
  const result = spawnSync(rcedit, [
    windowsExecutablePath,
    '--set-version-string', 'FileDescription', productName,
    '--set-version-string', 'ProductName', productName,
    '--set-version-string', 'LegalCopyright', copyright,
    '--set-file-version', version,
    '--set-product-version', productVersion,
    '--set-version-string', 'InternalName', productName,
    '--set-version-string', 'CompanyName', productName,
    '--set-icon', join(rootDir, 'build', 'icon.ico')
  ], {
    cwd: rootDir,
    encoding: 'utf8'
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  ensureSuccess(result, 'Repairing Windows executable metadata');
}

function packageInstallers(command, args, targets) {
  let lastError;
  for (let attempt = 1; attempt <= builderRetryCount; attempt += 1) {
    clearReleaseDir(attempt === 1 ? 'Clearing release directory before packaging' : `Clearing release directory before retry ${attempt}`);
    const result = run(command, args, `Packaging installers (attempt ${attempt}/${builderRetryCount})`);
    if (result.status === 0) {
      try {
        if (targets.win) verifyWindowsExecutableIdentity();
        if (hadRecoveredRceditFailure(result)) {
          console.warn(
            'Note: electron-builder reported transient rcedit "Unable to commit changes" errors, then retried successfully. The final Windows executable metadata was verified.'
          );
        }
        return;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
      }
    } else {
      lastError = new Error(`electron-builder exited with code ${result.status ?? 'unknown'}.`);
      if (targets.win && hadRecoveredRceditFailure(result) && existsSync(windowsExecutablePath)) {
        try {
          console.warn('electron-builder failed while writing Windows executable metadata. Repairing metadata and building NSIS from the prepackaged app...');
          applyWindowsExecutableMetadata();
          const prepackagedArgs = [...args, '--prepackaged', join('release', 'win-unpacked')];
          const prepackagedResult = run(command, prepackagedArgs, 'Packaging Windows installer from prepackaged app');
          ensureSuccess(prepackagedResult, 'Packaging Windows installer from prepackaged app');
          verifyWindowsExecutableIdentity();
          return;
        } catch (error) {
          lastError = error instanceof Error ? error : new Error(String(error));
        }
      }
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

function shellSingleQuote(value) {
  return String(value).replace(/'/g, "'\"'\"'");
}

function createLinuxBinInstallerStub(metadata) {
  return `#!/usr/bin/env bash
set -euo pipefail

APP_NAME='${shellSingleQuote(metadata.productName)}'
APP_ID='${shellSingleQuote(metadata.appId)}'
APP_VERSION='${shellSingleQuote(metadata.version)}'
DEFAULT_INSTALL_DIR="/opt/$APP_ID"
DEFAULT_BIN_DIR="/usr/local/bin"
PAYLOAD_LINE=__PAYLOAD_LINE__

show_usage() {
  cat <<EOF
$APP_NAME $APP_VERSION installer

Usage:
  sudo ./$(basename "$0")
  ./$(basename "$0") --prefix "\$HOME/.local/opt/$APP_ID" --bin-dir "\$HOME/.local/bin"

Options:
  --prefix <dir>       Install directory. Default: $DEFAULT_INSTALL_DIR
  --bin-dir <dir>      Directory for the command-line launcher. Default: $DEFAULT_BIN_DIR
  --no-bin-link        Do not create the command-line launcher.
  --help               Show this help message.
EOF
}

INSTALL_DIR="\${INSTALL_DIR:-$DEFAULT_INSTALL_DIR}"
BIN_DIR="\${BIN_DIR:-$DEFAULT_BIN_DIR}"
CREATE_BIN_LINK=1

while [[ $# -gt 0 ]]; do
  case "$1" in
    --prefix)
      INSTALL_DIR="\${2:-}"
      if [[ -z "$INSTALL_DIR" ]]; then
        echo "--prefix requires a directory." >&2
        exit 1
      fi
      shift 2
      ;;
    --bin-dir)
      BIN_DIR="\${2:-}"
      if [[ -z "$BIN_DIR" ]]; then
        echo "--bin-dir requires a directory." >&2
        exit 1
      fi
      shift 2
      ;;
    --no-bin-link)
      CREATE_BIN_LINK=0
      shift
      ;;
    --help|-h)
      show_usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      show_usage
      exit 1
      ;;
  esac
done

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Required command not found: $1" >&2
    exit 1
  fi
}

choose_sudo() {
  local parent
  parent="$(dirname "$INSTALL_DIR")"
  if [[ "$EUID" -eq 0 ]]; then
    return
  fi
  if [[ ! -d "$parent" || ! -w "$parent" ]]; then
    if ! command -v sudo >/dev/null 2>&1; then
      echo "Installing to $INSTALL_DIR requires elevated permissions, but sudo was not found." >&2
      exit 1
    fi
    SUDO=(sudo)
    return
  fi
  if [[ "$CREATE_BIN_LINK" -eq 1 && (! -d "$BIN_DIR" || ! -w "$BIN_DIR") ]]; then
    if ! command -v sudo >/dev/null 2>&1; then
      echo "Creating launcher in $BIN_DIR requires elevated permissions, but sudo was not found." >&2
      exit 1
    fi
    SUDO=(sudo)
  fi
}

find_app_executable() {
  local candidate
  for candidate in "$INSTALL_DIR/$APP_ID" "$INSTALL_DIR/$APP_NAME" "$INSTALL_DIR/tasi-harness" "$INSTALL_DIR/Tasi Harness"; do
    if [[ -x "$candidate" && ! -d "$candidate" ]]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done
  find "$INSTALL_DIR" -maxdepth 1 -type f -perm -111 | head -n 1
}

require_command tail
require_command tar
require_command mktemp

SUDO=()
choose_sudo

WORK_DIR="$(mktemp -d)"
cleanup() {
  rm -rf "$WORK_DIR"
}
trap cleanup EXIT

PAYLOAD_START=$((PAYLOAD_LINE + 1))
tail -n +"$PAYLOAD_START" "$0" | tar -xzf - -C "$WORK_DIR"

APP_SOURCE="$WORK_DIR/linux-unpacked"
if [[ ! -d "$APP_SOURCE" ]]; then
  echo "Installer payload is missing linux-unpacked." >&2
  exit 1
fi

echo "Installing $APP_NAME $APP_VERSION to $INSTALL_DIR"
"\${SUDO[@]}" rm -rf "$INSTALL_DIR"
"\${SUDO[@]}" mkdir -p "$INSTALL_DIR"
"\${SUDO[@]}" cp -R "$APP_SOURCE/." "$INSTALL_DIR/"

APP_EXECUTABLE="$(find_app_executable)"
if [[ -z "$APP_EXECUTABLE" ]]; then
  echo "Installed app executable was not found in $INSTALL_DIR." >&2
  exit 1
fi

if [[ "$CREATE_BIN_LINK" -eq 1 ]]; then
  "\${SUDO[@]}" mkdir -p "$BIN_DIR"
  "\${SUDO[@]}" ln -sfn "$APP_EXECUTABLE" "$BIN_DIR/$APP_ID"
  echo "Command-line launcher: $BIN_DIR/$APP_ID"
fi

echo "Installation completed."
`;
}

function archLabel() {
  if (process.arch === 'x64') return 'x64';
  if (process.arch === 'arm64') return 'arm64';
  return process.arch;
}

function artifactSafeName(value) {
  return String(value).trim().replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'app';
}

function createLinuxBinInstaller(targets) {
  if (!targets.ubuntuBin) return;
  if (!existsSync(linuxUnpackedPath)) {
    throw new Error(`Expected Linux unpacked app was not produced: ${linuxUnpackedPath}`);
  }

  const productName = String(packageMetadata.build?.productName ?? packageMetadata.productName ?? packageMetadata.name ?? 'Tasi Harness');
  const appId = 'tasi-harness';
  const version = String(packageMetadata.version ?? '0.0.0');
  const artifactName = `${artifactSafeName(productName)}-${version}-${archLabel()}.bin`;
  const installerPath = join(releaseDir, artifactName);
  const payloadPath = join(releaseDir, '.tasi-harness-linux-bin-payload.tar.gz');
  ensureSuccess(run('tar', ['-czf', payloadPath, '-C', releaseDir, 'linux-unpacked'], 'Creating Ubuntu/Linux .bin payload'), 'Creating Ubuntu/Linux .bin payload');

  const stub = createLinuxBinInstallerStub({ productName, appId, version });
  const payloadLine = (stub.match(/\n/g) ?? []).length;
  const installerStub = stub.replace('__PAYLOAD_LINE__', String(payloadLine));
  writeFileSync(installerPath, installerStub, 'utf8');
  appendFileSync(installerPath, readFileSync(payloadPath));
  chmodSync(installerPath, 0o755);
  rmSync(payloadPath, { force: true });
  console.log(`Created Ubuntu/Linux executable installer: ${installerPath}`);
}

if (argv.has('--help')) {
  printUsage();
  process.exit(0);
}

const wantsUbuntuBin = argv.has('--ubuntu') || argv.has('--ubuntu-bin') || argv.has('--linux-bin');
const wantsUbuntuDeb = argv.has('--ubuntu-deb') || argv.has('--linux-deb');
const explicitTarget = argv.has('--win') || argv.has('--mac') || wantsUbuntuBin || wantsUbuntuDeb || argv.has('--linux');
const targets = {
  win: argv.has('--win'),
  mac: argv.has('--mac'),
  ubuntuBin: wantsUbuntuBin || (argv.has('--linux') && !wantsUbuntuDeb),
  ubuntuDeb: wantsUbuntuDeb
};

if (!explicitTarget) {
  if (process.platform === 'win32') targets.win = true;
  else if (process.platform === 'darwin') targets.mac = true;
  else if (process.platform === 'linux') targets.ubuntuBin = true;
}

if (!targets.win && !targets.mac && !targets.ubuntuBin && !targets.ubuntuDeb) {
  console.error('No packaging target selected. Use --win, --mac, --ubuntu, and/or --ubuntu-deb.');
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

const allowCrossUbuntu = argv.has('--allow-cross-ubuntu') || process.env.TASI_ALLOW_CROSS_UBUNTU === '1';
if ((targets.ubuntuBin || targets.ubuntuDeb) && process.platform !== 'linux' && !allowCrossUbuntu) {
  console.error(
    'Ubuntu/Linux packaging should normally run on a Linux/Ubuntu host. Re-run this command on Ubuntu, or pass --allow-cross-ubuntu if you have a custom cross-build environment.'
  );
  process.exit(1);
}

const npm = commandName('npm');
prepareCliAssets(targets);
generateBundledSkillManifest(targets);
if (!argv.has('--skip-build')) {
  ensureSuccess(run(npm, ['run', 'build'], 'Building app'), 'Building app');
}

const builderArgs = ['exec', 'electron-builder', '--', '--publish', 'never'];
if (targets.win) builderArgs.push('--win', 'nsis');
if (targets.mac) builderArgs.push('--mac', 'dmg');
const linuxTargets = [];
if (targets.ubuntuBin) linuxTargets.push('dir');
if (targets.ubuntuDeb) linuxTargets.push('deb');
if (linuxTargets.length > 0) builderArgs.push('--linux', ...linuxTargets);
packageInstallers(npm, builderArgs, targets);
createLinuxBinInstaller(targets);

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
