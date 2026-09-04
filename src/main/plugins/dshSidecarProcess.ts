import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, parse, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import JSZip from 'jszip';
import type {
  DshSidecarClientMount,
  DshSidecarClientMountPoint,
  DshSidecarRuntimeSkill,
  DshSidecarRuntimePlugin,
  DshSidecarRuntimeStatus,
  DshSidecarChatRunRequest,
  DshSidecarChatRunResult,
  DshSidecarPluginActionRequest,
  DshSidecarPluginInstallRequest,
  DshSidecarPluginRecord,
  DshSidecarToolCallRequest,
  DshSidecarPluginUploadRequest,
  DshSidecarStatus,
  ToolDefinition,
  ToolExecutionResult
} from '../../shared/types.js';
import { nowIso } from '../../shared/types.js';
import { DshCordisHost } from './dshCordisHost.js';
import { DshSidecarStore } from './dshSidecarStore.js';

interface RpcRequest {
  id: string;
  method: string;
  params?: unknown;
}

interface ParentRpcResponse {
  id: string;
  result?: unknown;
  error?: { message: string };
}

interface PendingParentCall {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

interface CommandResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

const sidecarHome = process.env.TASI_DSH_SIDECAR_HOME || join(homedir(), '.tasi-harness', 'dsh-sidecar');
const defaultProfileName = process.env.TASI_DSH_PROFILE_NAME || 'default';
const store = new DshSidecarStore(sidecarHome);
let clientServer: Server | undefined;
let clientBaseUrl = '';
let clientServerStartPromise: Promise<string> | undefined;
let nextParentRequestId = 1;
const pendingParentCalls = new Map<string, PendingParentCall>();

function profileDir(profileName = defaultProfileName): string {
  return join(sidecarHome, 'profiles', cleanSegment(profileName || defaultProfileName));
}

function status(profileName = defaultProfileName): DshSidecarStatus {
  const dir = profileDir(profileName);
  return {
    available: true,
    running: true,
    pid: process.pid,
    protocolVersion: 1,
    home: sidecarHome,
    profileName,
    profileDir: dir,
    nodeVersion: process.version
  };
}

function cleanSegment(value: string): string {
  const clean = value.trim().replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  if (!clean || clean.includes('..') || clean.includes('/') || clean.includes('\\')) throw new Error(`Invalid sidecar path segment: ${value}`);
  return clean;
}

function ensureProfile(profileName = defaultProfileName): string {
  const dir = profileDir(profileName);
  mkdirSync(dir, { recursive: true });
  const pkgPath = join(dir, 'package.json');
  if (!existsSync(pkgPath)) {
    writeFileSync(pkgPath, JSON.stringify({
      name: `tasi-dsh-profile-${cleanSegment(profileName)}`,
      private: true,
      type: 'module',
      dependencies: {}
    }, null, 2) + '\n', 'utf8');
  }
  const workspacePath = join(dir, 'pnpm-workspace.yaml');
  if (!existsSync(workspacePath)) {
    writeFileSync(workspacePath, 'packages: []\n', 'utf8');
  }
  const npmrcPath = join(dir, '.npmrc');
  if (!existsSync(npmrcPath) || !readFileSync(npmrcPath, 'utf8').includes('auto-install-peers=false')) {
    writeFileSync(npmrcPath, 'node-linker=hoisted\nauto-install-peers=false\n', 'utf8');
  }
  return dir;
}

function packageManagerBinary(): string {
  return 'pnpm';
}

function runCommand(command: string, args: string[], cwd: string): Promise<CommandResult> {
  return new Promise((resolveCommand) => {
    let child;
    try {
      child = spawnCommand(command, args, cwd);
    } catch (error) {
      resolveCommand({ code: 1, stdout: '', stderr: error instanceof Error ? error.message : String(error) });
      return;
    }
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.on('error', (error) => {
      resolveCommand({ code: 1, stdout, stderr: `${stderr}${error.message}` });
    });
    child.on('close', (code) => {
      resolveCommand({ code, stdout, stderr });
    });
  });
}

function spawnCommand(command: string, args: string[], cwd: string) {
  if (process.platform === 'win32') {
    return spawn('cmd.exe', ['/d', '/s', '/c', [command, ...args].map(quoteWindowsCmdArg).join(' ')], {
      cwd,
      env: process.env,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });
  }
  return spawn(command, args, {
    cwd,
    env: process.env,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe']
  });
}

function quoteWindowsCmdArg(value: string): string {
  if (/^[a-zA-Z0-9_@%+=:,./\\#-]+$/.test(value)) return value;
  return `"${value.replace(/"/g, '""')}"`;
}

function installSpecifier(source: string): string {
  const clean = source.trim();
  if (!clean) throw new Error('Plugin source is required.');
  const maybePath = isAbsolute(clean) ? clean : resolve(process.cwd(), clean);
  return existsSync(maybePath) ? maybePath : clean;
}

function preferredInstallSource(source: string, packageName: string): string {
  const cleanSource = source.trim();
  if (/^github:/i.test(cleanSource) && packageName.trim()) return packageName.trim();
  return cleanSource;
}

function unscopedPackageName(packageName: string): string | undefined {
  const clean = packageName.trim();
  if (!clean.startsWith('@') || !clean.includes('/')) return undefined;
  const base = basename(clean.replace(/\\/g, '/'));
  return base && base !== clean ? base : undefined;
}

function githubSourceFromScopedPackage(packageName: string): string | undefined {
  const clean = packageName.trim();
  if (!clean.startsWith('@') || !clean.includes('/')) return undefined;
  const [scope, name] = clean.slice(1).split('/');
  return scope && name ? `github:${scope}/${name}` : undefined;
}

export function dshPluginInstallSourceCandidates(source: string, packageName: string): string[] {
  const candidates = new Set<string>();
  const add = (value: string | undefined) => {
    const clean = value?.trim();
    if (clean) candidates.add(clean);
  };
  add(source);
  add(packageName);
  add(unscopedPackageName(packageName));
  add(githubSourceFromScopedPackage(packageName));
  return [...candidates];
}

async function addPackageWithFallback(profile: string, source: string, packageName: string): Promise<{ result: CommandResult; source: string }> {
  const command = packageManagerBinary();
  const failures: string[] = [];
  let lastResult: CommandResult = { code: 1, stdout: '', stderr: 'No install source candidates were available.' };
  for (const candidate of dshPluginInstallSourceCandidates(source, packageName)) {
    const result = await runCommand(command, ['add', '--config.auto-install-peers=false', installSpecifier(candidate)], profile);
    if (result.code === 0) return { result, source: candidate };
    lastResult = result;
    failures.push(`${candidate}: ${compactError(result.stderr || result.stdout || `${command} add failed with code ${result.code}`)}`);
  }
  return {
    source,
    result: {
      ...lastResult,
      stderr: failures.join('\n')
    }
  };
}

function failedPluginRecord(base: DshSidecarPluginRecord, lastError: string): DshSidecarPluginRecord {
  return {
    ...base,
    enabled: false,
    status: 'failed',
    lastError,
    updatedAt: nowIso()
  };
}

function packageNameFromSource(source: string, hint?: string): string {
  if (hint?.trim()) return hint.trim();
  const clean = source.trim().replace(/\\/g, '/').replace(/\/+$/, '');
  if (clean.startsWith('@')) {
    const [scope, nameWithVersion = ''] = clean.split('/');
    const name = nameWithVersion.includes('@') ? nameWithVersion.slice(0, nameWithVersion.indexOf('@')) : nameWithVersion;
    if (scope && name) return `${scope}/${name}`;
  }
  if (/^[a-zA-Z0-9._-]+(?:@[a-zA-Z0-9._-]+)?$/.test(clean)) {
    return clean.includes('@') ? clean.slice(0, clean.indexOf('@')) : clean;
  }
  const localPkg = join(isAbsolute(source) ? source : resolve(process.cwd(), source), 'package.json');
  if (existsSync(localPkg)) {
    try {
      const manifest = JSON.parse(readFileSync(localPkg, 'utf8')) as { name?: unknown };
      if (typeof manifest.name === 'string' && manifest.name.trim()) return manifest.name.trim();
    } catch {
      // Fall through to a derived label.
    }
  }
  return basename(clean).replace(/\.git$/i, '') || clean;
}

function pluginIdFromPackage(packageName: string): string {
  return packageName.replace(/^@/, '').replace(/[^a-zA-Z0-9._-]+/g, '-');
}

function filenameStem(filename: string): string {
  return basename(filename.trim() || 'uploaded-plugin').replace(/\.(?:zip|tgz|tar\.gz)$/i, '') || 'uploaded-plugin';
}

function packageRoot(profile: string, packageName: string): string {
  return join(profile, 'node_modules', ...packageName.split('/'));
}

function readInstalledManifest(profile: string, packageName: string): { version?: string; dshBundlePatch?: string } {
  const root = packageRoot(profile, packageName);
  const pkgPath = join(root, 'package.json');
  if (!existsSync(pkgPath)) return {};
  const manifest = JSON.parse(readFileSync(pkgPath, 'utf8')) as {
    version?: unknown;
    dsh?: {
      bundle?: {
        patch?: unknown;
      };
    };
  };
  const declaredPatch = typeof manifest.dsh?.bundle?.patch === 'string' ? manifest.dsh.bundle.patch : undefined;
  const fallbackPatch = existsSync(join(root, 'cordis.patch.yml')) ? './cordis.patch.yml' : undefined;
  return {
    version: typeof manifest.version === 'string' ? manifest.version : undefined,
    dshBundlePatch: declaredPatch ?? fallbackPatch
  };
}

async function prepareInstalledPlugin(profile: string, packageName: string): Promise<string[]> {
  const warnings: string[] = [];
  warnings.push(...await installMissingPeerDependencies(profile, packageName));
  warnings.push(...await buildSourcePluginIfNeeded(profile, packageName));
  warnings.push(...await installMissingPeerDependencies(profile, packageName));
  return warnings.filter(Boolean);
}

async function installMissingPeerDependencies(profile: string, packageName: string): Promise<string[]> {
  const manifest = readPackageManifest(profile, packageName);
  const peers = objectValue(manifest?.peerDependencies);
  const missing = Object.entries(peers)
    .filter(([name, range]) => typeof name === 'string' && name.trim() && typeof range === 'string' && range.trim())
    .filter(([name]) => !existsSync(join(packageRoot(profile, name), 'package.json')))
    .map(([name, range]) => dependencyInstallSpecifier(name, range as string));
  if (missing.length === 0) return [];
  const warnings: string[] = [];
  for (const specifier of missing) {
    const { result, specifier: installedSpecifier } = await addDependencyWithPrereleaseFallback(profile, specifier);
    if (result.code !== 0) {
      warnings.push(`Failed to install plugin peer dependency ${specifier}: ${compactError(result.stderr || result.stdout || `pnpm add ${specifier} failed with code ${result.code}`)}`);
    } else if (installedSpecifier !== specifier) {
      warnings.push(`Installed plugin peer dependency ${installedSpecifier} as a prerelease fallback for ${specifier}.`);
    }
  }
  return warnings;
}

async function buildSourcePluginIfNeeded(profile: string, packageName: string): Promise<string[]> {
  const root = resolvePackageRoot(profile, packageName);
  const manifest = readPackageManifest(profile, packageName);
  if (!root || moduleEntryPath(root, manifest)) return [];
  const scripts = objectValue(manifest?.scripts);
  if (typeof scripts.build !== 'string' || !scripts.build.trim()) return [];
  const install = await runCommand(packageManagerBinary(), ['--dir', root, 'install'], profile);
  if (install.code !== 0) {
    return [`Plugin source install failed before build: ${compactError(install.stderr || install.stdout || `pnpm install failed with code ${install.code}`)}`];
  }
  const build = await runCommand(packageManagerBinary(), ['--dir', root, 'build'], profile);
  if (build.code !== 0) {
    return [`Plugin source build failed: ${compactError(build.stderr || build.stdout || `pnpm build failed with code ${build.code}`)}`];
  }
  return moduleEntryPath(root, manifest)
    ? []
    : [`Plugin build completed but runtime entry is still missing: ${stringValue(manifest?.main, './index.js')}`];
}

function npmReleaseSpecifier(packageName: string, version?: string): string {
  const clean = packageName.trim();
  const cleanVersion = version?.trim();
  if (!cleanVersion || cleanVersion === 'latest') return clean;
  if (clean.startsWith('@')) {
    const [scope, name] = clean.split('/');
    return scope && name ? `${scope}/${name}@${cleanVersion}` : clean;
  }
  return `${clean}@${cleanVersion}`;
}

async function installNpmReleaseForMissingEntry(profile: string, packageName: string, version?: string): Promise<string[]> {
  const root = resolvePackageRoot(profile, packageName);
  const manifest = readPackageManifest(profile, packageName);
  if (!root || moduleEntryPath(root, manifest)) return [];
  const specifier = npmReleaseSpecifier(packageName, version || stringValue(manifest?.version));
  const result = await runCommand(packageManagerBinary(), ['add', '--config.auto-install-peers=false', specifier], profile);
  if (result.code !== 0) {
    return [`Failed to replace source install with npm release ${specifier}: ${compactError(result.stderr || result.stdout || `pnpm add failed with code ${result.code}`)}`];
  }
  const peerWarnings = await installMissingPeerDependencies(profile, packageName);
  const nextRoot = resolvePackageRoot(profile, packageName);
  const nextManifest = readPackageManifest(profile, packageName);
  const entryWarnings = nextRoot && moduleEntryPath(nextRoot, nextManifest)
    ? []
    : [`Installed npm release ${specifier}, but runtime entry is still missing.`];
  return [...peerWarnings, ...entryWarnings];
}

function missingPackageName(error: string | undefined): string | undefined {
  const match = error?.match(/Cannot find package ['"]([^'"]+)['"]/i);
  return match?.[1]?.trim();
}

function dependencySpecifierForPackage(manifest: JsonObject | undefined, packageName: string): string {
  for (const field of ['peerDependencies', 'dependencies', 'devDependencies']) {
    const deps = objectValue(manifest?.[field]);
    const range = deps[packageName];
    if (typeof range === 'string' && range.trim()) return dependencyInstallSpecifier(packageName, range);
  }
  return packageName;
}

function dependencyInstallSpecifier(packageName: string, range: string): string {
  const cleanRange = range.trim();
  if (!cleanRange || cleanRange === '*' || cleanRange.toLowerCase() === 'latest') return packageName;
  const pinned = cleanRange.match(/^[\^~](\d+(?:\.\d+){0,2}(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)$/)?.[1];
  return `${packageName}@${pinned || cleanRange}`;
}

async function addDependencyWithPrereleaseFallback(profile: string, specifier: string): Promise<{ result: CommandResult; specifier: string }> {
  const result = await runCommand(packageManagerBinary(), ['add', '--config.auto-install-peers=false', specifier], profile);
  if (result.code === 0) return { result, specifier };
  const fallback = prereleaseFallbackSpecifier(specifier, result.stderr || result.stdout);
  if (!fallback) return { result, specifier };
  const retry = await runCommand(packageManagerBinary(), ['add', '--config.auto-install-peers=false', fallback], profile);
  if (retry.code === 0) return { result: retry, specifier: fallback };
  return {
    result: {
      ...retry,
      stderr: [
        `${specifier}: ${compactError(result.stderr || result.stdout || `pnpm add ${specifier} failed with code ${result.code}`)}`,
        `${fallback}: ${compactError(retry.stderr || retry.stdout || `pnpm add ${fallback} failed with code ${retry.code}`)}`
      ].join('\n')
    },
    specifier: fallback
  };
}

export function prereleaseFallbackSpecifier(specifier: string, errorText: string): string | undefined {
  if (!/ERR_PNPM_NO_MATCHING_VERSION|No matching version/i.test(errorText)) return undefined;
  const packageName = packageNameFromDependencySpecifier(specifier);
  if (!packageName.startsWith('@deepseek-ai/dsh-')) return undefined;
  if (!/\bnext:/i.test(errorText)) return undefined;
  return `${packageName}@next`;
}

function packageNameFromDependencySpecifier(specifier: string): string {
  const clean = specifier.trim();
  if (clean.startsWith('@')) {
    const [scope = '', name = ''] = clean.split('/');
    const packageBase = name.includes('@') ? name.slice(0, name.indexOf('@')) : name;
    return scope && packageBase ? `${scope}/${packageBase}` : clean;
  }
  const at = clean.indexOf('@');
  return at > 0 ? clean.slice(0, at) : clean;
}

async function installMissingRuntimePackage(profile: string, pluginPackageName: string, missingPackage: string): Promise<string | undefined> {
  if (!missingPackage.trim()) return undefined;
  const manifest = readPackageManifest(profile, pluginPackageName);
  const specifier = dependencySpecifierForPackage(manifest, missingPackage);
  const { result } = await addDependencyWithPrereleaseFallback(profile, specifier);
  if (result.code === 0) return undefined;
  return `Failed to install missing runtime package ${specifier}: ${compactError(result.stderr || result.stdout || `pnpm add failed with code ${result.code}`)}`;
}

function findDshBundlePackage(profile: string, preferredPackageName: string): string | undefined {
  if (existsSync(join(packageRoot(profile, preferredPackageName), 'package.json'))) return preferredPackageName;
  const nodeModules = join(profile, 'node_modules');
  if (!existsSync(nodeModules)) return undefined;
  const candidates: string[] = [];
  for (const entry of readdirSync(nodeModules, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith('.')) continue;
    if (entry.name.startsWith('@')) {
      const scopeDir = join(nodeModules, entry.name);
      for (const scoped of readdirSync(scopeDir, { withFileTypes: true })) {
        if (scoped.isDirectory()) candidates.push(`${entry.name}/${scoped.name}`);
      }
    } else {
      candidates.push(entry.name);
    }
  }
  const preferredBase = basename(preferredPackageName.replace(/\\/g, '/'));
  const preferredCandidates = candidates.filter((candidate) => (
    candidate === preferredPackageName ||
    candidate === preferredBase ||
    candidate.endsWith(`/${preferredBase}`)
  ));
  return preferredCandidates.find((candidate) => {
    try {
      return Boolean(readInstalledManifest(profile, candidate).dshBundlePatch);
    } catch {
      return false;
    }
  });
}

export function dshFindInstalledPackage(profile: string, preferredPackageName: string, source: string): string | undefined {
  if (existsSync(join(packageRoot(profile, preferredPackageName), 'package.json'))) return preferredPackageName;
  const deps = profileDependencies(profile);
  for (const candidate of dshPluginInstallSourceCandidates(source, preferredPackageName)) {
    if (Object.prototype.hasOwnProperty.call(deps, candidate) && existsSync(join(packageRoot(profile, candidate), 'package.json'))) {
      return candidate;
    }
  }
  const sourceKey = source.trim().toLowerCase();
  const depKey = Object.entries(deps).find(([, value]) => value.trim().toLowerCase() === sourceKey)?.[0];
  if (depKey && existsSync(join(packageRoot(profile, depKey), 'package.json'))) return depKey;
  return findDshBundlePackage(profile, preferredPackageName);
}

async function installPlugin(params: DshSidecarPluginInstallRequest): Promise<DshSidecarPluginRecord> {
  const now = nowIso();
  const profileName = params.profileName || defaultProfileName;
  const profile = ensureProfile(profileName);
  const source = params.source.trim();
  const packageName = packageNameFromSource(source, params.packageName);
  const installSource = preferredInstallSource(source, packageName);
  const id = pluginIdFromPackage(packageName);
  const base: DshSidecarPluginRecord = {
    id,
    packageName,
    source: installSource,
    enabled: false,
    status: 'installed',
    profileName,
    installedAt: store.get(id)?.installedAt ?? now,
    updatedAt: now
  };
  const command = packageManagerBinary();
  const install = await addPackageWithFallback(profile, installSource, packageName);
  const result = install.result;
  if (result.code !== 0) {
    const failed = failedPluginRecord(base, compactError(result.stderr || result.stdout || `${command} add failed with code ${result.code}`));
    store.upsert(failed);
    return failed;
  }
  try {
    const installedPackageName = dshFindInstalledPackage(profile, packageName, install.source);
    if (!installedPackageName) {
      const failed = failedPluginRecord(
        base,
        [
          `Installed package is not resolvable from profile node_modules: ${packageName}`,
          `Tried install sources: ${dshPluginInstallSourceCandidates(installSource, packageName).join(', ')}`
        ].join('\n')
      );
      store.upsert(failed);
      return failed;
    }
    const prepareWarnings = await prepareInstalledPlugin(profile, installedPackageName);
    prepareWarnings.push(...await installNpmReleaseForMissingEntry(profile, installedPackageName, undefined));
    const manifest = readInstalledManifest(profile, installedPackageName);
    const installed: DshSidecarPluginRecord = {
      ...base,
      id: pluginIdFromPackage(installedPackageName),
      packageName: installedPackageName,
      source: install.source,
      version: manifest.version,
      dshBundlePatch: manifest.dshBundlePatch,
      status: manifest.dshBundlePatch ? 'installed' : 'incompatible',
      lastError: manifest.dshBundlePatch
        ? prepareWarnings.join('\n') || undefined
        : ['Installed package does not declare dsh.bundle.patch.', ...prepareWarnings].join('\n')
    };
    store.upsert(installed);
    return installed;
  } catch (error) {
    const failed = failedPluginRecord(base, error instanceof Error ? error.message : String(error));
    store.upsert(failed);
    return failed;
  }
}

function compactError(value: string): string {
  return value.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '').trim().slice(-4000);
}

async function uploadPlugin(params: DshSidecarPluginUploadRequest): Promise<DshSidecarPluginRecord> {
  const uploaded = await extractUploadedZip(params);
  return await installPlugin({
    source: uploaded.sourcePath,
    packageName: params.packageName || uploaded.packageName,
    profileName: params.profileName
  });
}

async function extractUploadedZip(params: DshSidecarPluginUploadRequest): Promise<{ sourcePath: string; packageName?: string }> {
  if (!params.filename?.trim()) throw new Error('Plugin ZIP filename is required.');
  if (!params.contentBase64?.trim()) throw new Error('Plugin ZIP content is required.');
  const zip = await JSZip.loadAsync(Buffer.from(params.contentBase64, 'base64'));
  const packageEntry = findPackageJsonEntry(zip);
  if (!packageEntry) throw new Error('Plugin ZIP must contain a package.json file.');
  const packageText = await packageEntry.async('string');
  const manifest = JSON.parse(packageText) as { name?: unknown };
  const packageName = typeof manifest.name === 'string' && manifest.name.trim()
    ? manifest.name.trim()
    : params.packageName?.trim();
  const rootPrefix = packageEntry.name.replace(/package\.json$/i, '');
  const targetId = pluginIdFromPackage(packageName || filenameStem(params.filename));
  const targetRoot = join(sidecarHome, 'uploaded');
  const targetDir = join(targetRoot, `${cleanSegment(targetId)}-${Date.now().toString(36)}`);
  mkdirSync(targetRoot, { recursive: true });
  rmSync(targetDir, { recursive: true, force: true });
  mkdirSync(targetDir, { recursive: true });
  for (const entry of Object.values(zip.files)) {
    if (entry.dir) continue;
    if (!entry.name.startsWith(rootPrefix)) continue;
    const relativePath = normalizeZipPath(entry.name.slice(rootPrefix.length));
    if (!relativePath) continue;
    const targetPath = resolve(targetDir, ...relativePath.split('/'));
    if (!isPathInside(targetDir, targetPath)) throw new Error(`ZIP entry escapes plugin directory: ${entry.name}`);
    mkdirSync(dirname(targetPath), { recursive: true });
    writeFileSync(targetPath, await entry.async('nodebuffer'));
  }
  return { sourcePath: targetDir, packageName };
}

function findPackageJsonEntry(zip: JSZip): JSZip.JSZipObject | undefined {
  return Object.values(zip.files)
    .filter((entry) => !entry.dir && /(^|\/)package\.json$/i.test(entry.name) && !entry.name.includes('/node_modules/'))
    .sort((left, right) => left.name.split('/').length - right.name.split('/').length)[0];
}

function normalizeZipPath(input: string): string {
  const clean = input.replace(/\\/g, '/').replace(/^\/+/, '');
  const parts = clean.split('/').filter(Boolean);
  if (parts.some((part) => part === '..' || part.includes('\0'))) throw new Error(`Unsafe ZIP entry path: ${input}`);
  return parts.join('/');
}

function isPathInside(root: string, target: string): boolean {
  const rootResolved = resolve(root).replace(/\\/g, '/').replace(/\/+$/, '');
  const targetResolved = resolve(target).replace(/\\/g, '/');
  return targetResolved === rootResolved || targetResolved.startsWith(`${rootResolved}/`);
}

type JsonObject = Record<string, unknown>;

interface RuntimeTool extends ToolDefinition {
  pluginId: string;
}

interface AgentTeamMember {
  name: string;
  role?: string;
  prompt?: string;
  provider?: string;
  model?: string;
  reasoning_effort?: string;
  createdAt: string;
}

interface AgentTeamTask {
  id: string;
  title: string;
  description?: string;
  assignee?: string;
  status: 'pending' | 'in_progress' | 'blocked' | 'done' | 'failed';
  blockers: string[];
  notes: string[];
  createdAt: string;
  updatedAt: string;
}

interface AgentTeamMessage {
  id: string;
  from: string;
  to: string;
  content: string;
  createdAt: string;
}

interface AgentTeamState {
  teamId: string;
  sessionId: string;
  goal: string;
  createdAt: string;
  updatedAt: string;
  members: AgentTeamMember[];
  tasks: AgentTeamTask[];
  messages: AgentTeamMessage[];
}

function readJsonFile<T>(file: string, fallback: T): T {
  if (!existsSync(file)) return fallback;
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as T;
  } catch {
    return fallback;
  }
}

function profileDependencies(profile: string): Record<string, string> {
  const manifest = readJsonFile<JsonObject>(join(profile, 'package.json'), {});
  const deps = objectValue(manifest.dependencies);
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(deps)) {
    if (typeof value === 'string') result[name] = value;
  }
  return result;
}

function dependencyKeyForRecord(profile: string, record: DshSidecarPluginRecord): string | undefined {
  const deps = profileDependencies(profile);
  if (Object.prototype.hasOwnProperty.call(deps, record.packageName)) return record.packageName;
  const source = record.source.trim().toLowerCase();
  const bySource = Object.entries(deps).find(([, value]) => value.trim().toLowerCase() === source)?.[0];
  if (bySource) return bySource;
  const candidates = new Set([
    basename(record.packageName.replace(/\\/g, '/')).toLowerCase(),
    basename(record.source.replace(/\\/g, '/').replace(/\.git$/i, '')).toLowerCase()
  ]);
  return Object.keys(deps).find((name) => candidates.has(name.toLowerCase()));
}

function writeJsonFile(file: string, value: unknown): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function packageJsonPath(profile: string, packageName: string): string {
  return join(packageRoot(profile, packageName), 'package.json');
}

function readPackageManifest(profile: string, packageName: string): JsonObject | undefined {
  const file = packageJsonPath(profile, packageName);
  if (!existsSync(file)) return undefined;
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as JsonObject;
  } catch {
    return undefined;
  }
}

function objectValue(value: unknown): JsonObject {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : {};
}

function isJsonObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function stringValue(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0) : [];
}

function resolvePackageRoot(profile: string, packageName: string): string | undefined {
  const direct = packageRoot(profile, packageName);
  return existsSync(join(direct, 'package.json')) ? direct : undefined;
}

function resolvePatchPath(profile: string, record: DshSidecarPluginRecord, manifest?: JsonObject): string | undefined {
  const root = resolvePackageRoot(profile, record.packageName);
  if (!root) return undefined;
  const dsh = objectValue(manifest?.dsh);
  const bundle = objectValue(dsh.bundle);
  const declared = stringValue(bundle.patch, record.dshBundlePatch || './cordis.patch.yml');
  const candidate = resolve(root, declared);
  if (existsSync(candidate)) return candidate;
  const fallback = resolve(root, 'cordis.patch.yml');
  return existsSync(fallback) ? fallback : undefined;
}

export function moduleEntryPath(root: string | undefined, manifest?: JsonObject): string | undefined {
  if (!root) return undefined;
  const candidates = moduleEntryCandidates(manifest);
  for (const entry of candidates) {
    const resolved = resolve(root, entry);
    if (existsSync(resolved) && statSync(resolved).isFile()) return resolved;
    const index = resolve(resolved, 'index.js');
    if (existsSync(index) && statSync(index).isFile()) return index;
  }
  return undefined;
}

function moduleEntryCandidates(manifest?: JsonObject): string[] {
  const candidates: string[] = [];
  const add = (value: unknown) => {
    if (typeof value !== 'string') return;
    const clean = value.trim();
    if (clean && !clean.startsWith('#') && !clean.includes('*')) candidates.push(clean);
  };
  const addExportTarget = (value: unknown) => {
    if (typeof value === 'string') {
      add(value);
      return;
    }
    const obj = objectValue(value);
    for (const key of ['import', 'node', 'default', 'require']) add(obj[key]);
  };
  const exportsField = manifest?.exports;
  if (typeof exportsField === 'string') {
    add(exportsField);
  } else {
    const exportsObject = objectValue(exportsField);
    addExportTarget(exportsObject['.']);
    addExportTarget(exportsObject['./dsh']);
  }
  const dsh = objectValue(manifest?.dsh);
  const bundle = objectValue(dsh.bundle);
  add(bundle.entry);
  add(dsh.entry);
  add(manifest?.main);
  add('./dsh/index.js');
  add('./dist/dsh/index.js');
  add('./index.js');
  return [...new Set(candidates)];
}

function parseInsertedBundleNames(patchPath: string | undefined): string[] {
  if (!patchPath || !existsSync(patchPath)) return [];
  const text = readFileSync(patchPath, 'utf8');
  const names: string[] = [];
  const regex = /^\s*name:\s*['"]?([^'"\r\n#]+)['"]?/gm;
  for (const match of text.matchAll(regex)) {
    const name = match[1]?.trim();
    if (name) names.push(name);
  }
  return names;
}

function parsePatchBundleConfig(patchPath: string | undefined): JsonObject {
  if (!patchPath || !existsSync(patchPath)) return {};
  const lines = readFileSync(patchPath, 'utf8').split(/\r?\n/);
  const configLineIndex = lines.findIndex((line) => /^\s*config:\s*(?:#.*)?$/.test(line));
  if (configLineIndex < 0) return {};
  const configIndent = indentation(lines[configLineIndex] ?? '');
  const block: string[] = [];
  for (const line of lines.slice(configLineIndex + 1)) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const indent = indentation(line);
    if (indent <= configIndent) break;
    block.push(line.slice(configIndent + 2));
  }
  return objectValue(parseYamlSubset(block));
}

function parseYamlSubset(lines: string[]): unknown {
  const index = { value: 0 };
  return parseYamlBlock(lines, index, firstContentIndent(lines, 0));
}

function parseYamlBlock(lines: string[], index: { value: number }, indent: number): unknown {
  const object: JsonObject = {};
  const array: unknown[] = [];
  let mode: 'object' | 'array' | undefined;
  while (index.value < lines.length) {
    const line = lines[index.value] ?? '';
    if (!line.trim() || line.trim().startsWith('#')) {
      index.value += 1;
      continue;
    }
    const currentIndent = indentation(line);
    if (currentIndent < indent) break;
    if (currentIndent > indent) {
      index.value += 1;
      continue;
    }
    const trimmed = stripYamlComment(line.trim());
    if (trimmed.startsWith('- ')) {
      mode = 'array';
      const item = trimmed.slice(2).trim();
      index.value += 1;
      array.push(item ? parseYamlScalar(item) : parseYamlBlock(lines, index, firstContentIndent(lines, index.value)));
      continue;
    }
    const match = trimmed.match(/^([^:]+):\s*(.*)$/);
    if (!match) {
      index.value += 1;
      continue;
    }
    mode = 'object';
    const key = unquoteYaml(match[1]?.trim() ?? '');
    const rawValue = match[2]?.trim() ?? '';
    index.value += 1;
    object[key] = rawValue
      ? parseYamlScalar(rawValue)
      : parseYamlBlock(lines, index, firstContentIndent(lines, index.value));
  }
  return mode === 'array' ? array : object;
}

function firstContentIndent(lines: string[], start: number): number {
  for (let index = start; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    if (line.trim() && !line.trim().startsWith('#')) return indentation(line);
  }
  return 0;
}

function indentation(line: string): number {
  return line.match(/^\s*/)?.[0].length ?? 0;
}

function stripYamlComment(value: string): string {
  let quote: string | undefined;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if ((char === '"' || char === "'") && (index === 0 || value[index - 1] !== '\\')) {
      quote = quote === char ? undefined : quote ?? char;
    }
    if (char === '#' && !quote && (index === 0 || /\s/.test(value[index - 1] ?? ''))) return value.slice(0, index).trimEnd();
  }
  return value;
}

function parseYamlScalar(value: string): unknown {
  const clean = stripYamlComment(value).trim();
  if (clean === '') return '';
  if (clean === 'true') return true;
  if (clean === 'false') return false;
  if (clean === 'null' || clean === '~') return null;
  if (/^-?\d+(?:\.\d+)?$/.test(clean)) return Number(clean);
  if (clean.startsWith('[') || clean.startsWith('{')) {
    try {
      return JSON.parse(clean);
    } catch {
      return clean;
    }
  }
  return unquoteYaml(clean);
}

function unquoteYaml(value: string): string {
  const clean = value.trim();
  if ((clean.startsWith("'") && clean.endsWith("'")) || (clean.startsWith('"') && clean.endsWith('"'))) {
    return clean.slice(1, -1);
  }
  return clean;
}

function pluginSettingsEntries(record: DshSidecarPluginRecord): string[] {
  if (record.packageName === '@xmanrui/dsh-im') return ['IM Bot'];
  if (record.packageName === '@nanmicoder/dsh-agent-teams') return ['Agent Teams'];
  return [];
}

function pluginCommands(record: DshSidecarPluginRecord): string[] {
  if (record.packageName === '@nanmicoder/dsh-agent-teams') return ['/agent-teams'];
  return [];
}

function compatibilityPluginTools(record: DshSidecarPluginRecord): RuntimeTool[] {
  if (record.packageName === '@nanmicoder/dsh-agent-teams') return agentTeamsToolDefinitions(record.id);
  if (record.packageName === '@xmanrui/dsh-im') return dshImToolDefinitions(record.id);
  return [];
}

let cordisHostCache: { fingerprint: string; host: DshCordisHost } | undefined;

async function ensureClientServer(): Promise<string> {
  if (clientBaseUrl) return clientBaseUrl;
  if (clientServerStartPromise) return await clientServerStartPromise;
  clientServerStartPromise = new Promise<string>((resolveServer, rejectServer) => {
    const server = createServer((req, res) => {
      void handleClientServerRequest(req.url || '/', req, res);
    });
    server.on('error', rejectServer);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address() as AddressInfo;
      clientServer = server;
      clientBaseUrl = `http://127.0.0.1:${address.port}`;
      resolveServer(clientBaseUrl);
    });
  }).finally(() => {
    clientServerStartPromise = undefined;
  });
  return await clientServerStartPromise;
}

async function handleClientServerRequest(rawUrl: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const url = new URL(rawUrl, clientBaseUrl || 'http://127.0.0.1');
    if (url.pathname === '/health') {
      sendText(res, 200, 'ok', 'text/plain; charset=utf-8');
      return;
    }
    if (url.pathname === '/client-rpc') {
      await handleClientRpcRequest(req, res);
      return;
    }
    if (url.pathname === '/client-workspaces') {
      await handleClientWorkspacesRequest(req, res);
      return;
    }
    const assetMatch = url.pathname.match(/^\/client-asset\/([^/]+)\/(.+)$/);
    if (assetMatch) {
      sendClientAsset(decodeURIComponent(assetMatch[1] ?? ''), decodeURIComponent(assetMatch[2] ?? ''), res);
      return;
    }
    const match = url.pathname.match(/^\/client-mount\/([^/]+)\/([^/]+)\/?$/);
    if (!match) {
      const host = await getCordisHost();
      if (await host.handleWebRequest(url.pathname, req, res)) return;
      sendText(res, 404, 'Not found', 'text/plain; charset=utf-8');
      return;
    }
    const pluginId = decodeURIComponent(match[1] ?? '');
    const mountId = decodeURIComponent(match[2] ?? '');
    const host = await getCordisHost();
    const record = store.get(pluginId) ?? store.find({ id: pluginId });
    const plugin = record ? runtimePluginRecord(record, host) : undefined;
    const mount = plugin?.clientMounts?.find((item) => item.id === mountId);
    if (!record || !plugin || !mount) {
      sendText(res, 404, clientMountShellHtml(undefined, pluginId, mountId, `Client mount is not registered: ${pluginId}/${mountId}`), 'text/html; charset=utf-8');
      return;
    }
    const html = await host.transformIndexHtml(clientMountShellHtml(mount, pluginId, mountId, undefined, clientScriptUrl(pluginId)));
    sendText(res, 200, html, 'text/html; charset=utf-8');
  } catch (error) {
    sendText(res, 500, clientMountShellHtml(undefined, '', '', error instanceof Error ? error.message : String(error)), 'text/html; charset=utf-8');
  }
}

async function handleClientWorkspacesRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== 'POST') {
    sendJson(res, 405, { ok: false, error: { code: 'method-not-allowed', message: 'POST is required.' } });
    return;
  }
  try {
    const body = await readRequestBody(req, 256 * 1024);
    const parsed = JSON.parse(body) as unknown;
    if (!isJsonObject(parsed)) throw clientWorkspaceError('invalid-request', 'Invalid workspace payload.');
    const method = stringValue(parsed.method).trim();
    const args = Array.isArray(parsed.args) ? parsed.args : [];
    if (method === 'listDirectory') {
      sendJson(res, 200, { ok: true, value: listWorkspaceDirectory(typeof args[0] === 'string' ? args[0] : undefined) });
      return;
    }
    if (method === 'pickDirectory') {
      throw clientWorkspaceError('directory-picker-unavailable', 'Native directory picker is unavailable in the DSH sidecar browser shell.', {
        capability: 'native'
      });
    }
    throw clientWorkspaceError('unknown-method', `Unknown workspace method: ${method || 'empty'}`);
  } catch (error) {
    sendJson(res, 200, { ok: false, error: clientRpcFailure(error) });
  }
}

async function handleClientRpcRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== 'POST') {
    sendJson(res, 405, { ok: false, error: { code: 'method-not-allowed', message: 'POST is required.' } });
    return;
  }
  try {
    const body = await readRequestBody(req, 2 * 1024 * 1024);
    const parsed = JSON.parse(body) as unknown;
    if (!isJsonObject(parsed)) throw new Error('Invalid RPC payload.');
    const channel = stringValue(parsed.channel).trim();
    const endpoint = stringValue(parsed.endpoint ?? parsed.method).trim();
    if (!channel || !endpoint) throw new Error('RPC channel and endpoint are required.');
    const host = await getCordisHost();
    const value = await host.callConnectionRpc(channel, endpoint, parsed.payload);
    sendJson(res, 200, { ok: true, value });
  } catch (error) {
    sendJson(res, 200, { ok: false, error: clientRpcFailure(error) });
  }
}

function readRequestBody(req: IncomingMessage, maxBytes: number): Promise<string> {
  return new Promise((resolveBody, rejectBody) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.byteLength;
      if (size > maxBytes) {
        rejectBody(new Error('Request body is too large.'));
        req.destroy();
        return;
      }
      chunks.push(Buffer.from(chunk));
    });
    req.on('end', () => resolveBody(Buffer.concat(chunks).toString('utf8')));
    req.on('error', rejectBody);
  });
}

function sendJson(res: ServerResponse, statusCode: number, body: unknown): void {
  sendText(res, statusCode, JSON.stringify(body), 'application/json; charset=utf-8');
}

function clientRpcFailure(error: unknown): { code: string; message: string; details?: unknown } {
  if (error && typeof error === 'object') {
    const input = error as { code?: unknown; message?: unknown; details?: unknown };
    return {
      code: typeof input.code === 'string' ? input.code : 'rpc-failed',
      message: typeof input.message === 'string' ? input.message : String(error),
      ...(input.details === undefined ? {} : { details: input.details })
    };
  }
  return { code: 'rpc-failed', message: String(error) };
}

function clientWorkspaceError(code: string, message: string, details?: unknown): Error & { code: string; details?: unknown } {
  const error = new Error(message) as Error & { code: string; details?: unknown };
  error.code = code;
  if (details !== undefined) error.details = details;
  return error;
}

export interface DshWorkspaceDirectoryListing {
  path: string;
  home: string;
  crumbs: Array<{ name: string; path: string }>;
  entries: Array<{ name: string; path: string; hidden?: boolean }>;
  truncated?: boolean;
}

export function listWorkspaceDirectory(inputPath?: string): DshWorkspaceDirectoryListing {
  const target = resolveWorkspaceDirectoryPath(inputPath);
  let stats;
  try {
    stats = statSync(target);
  } catch {
    throw clientWorkspaceError('directory-unreadable', 'Unable to read directory. Please try again.', { path: target });
  }
  if (!stats.isDirectory()) {
    throw clientWorkspaceError('not-directory', 'Workspace path must point to a directory.', { path: target });
  }
  let children;
  try {
    children = readdirSync(target, { withFileTypes: true });
  } catch {
    throw clientWorkspaceError('directory-unreadable', 'Unable to read directory. Please try again.', { path: target });
  }
  const maxEntries = 300;
  const entries = children
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({
      name: entry.name,
      path: join(target, entry.name),
      hidden: entry.name.startsWith('.')
    }))
    .sort((left, right) => left.name.localeCompare(right.name, undefined, { numeric: true, sensitivity: 'base' }));
  return {
    path: target,
    home: workspaceHomePath(),
    crumbs: workspaceCrumbs(target),
    entries: entries.slice(0, maxEntries),
    truncated: entries.length > maxEntries
  };
}

function resolveWorkspaceDirectoryPath(inputPath?: string): string {
  const clean = inputPath?.trim();
  if (!clean) return workspaceHomePath();
  if (!isAbsolute(clean)) {
    throw clientWorkspaceError('not-absolute', 'Workspace path must be absolute.', { path: clean });
  }
  return resolve(clean);
}

function workspaceHomePath(): string {
  return resolve(process.cwd());
}

function workspaceCrumbs(target: string): Array<{ name: string; path: string }> {
  const root = parse(target).root;
  const crumbs: Array<{ name: string; path: string }> = [];
  let cursor = target;
  while (cursor && cursor !== root) {
    crumbs.push({ name: basename(cursor), path: cursor });
    const parent = dirname(cursor);
    if (!parent || parent === cursor) break;
    cursor = parent;
  }
  crumbs.push({ name: root || target, path: root || target });
  return crumbs.reverse();
}

function sendClientAsset(pluginId: string, relativePath: string, res: ServerResponse): void {
  const record = store.get(pluginId) ?? store.find({ id: pluginId });
  if (!record) {
    sendText(res, 404, 'Unknown plugin', 'text/plain; charset=utf-8');
    return;
  }
  const input = pluginHostInput(record);
  if (!input.root) {
    sendText(res, 404, 'Plugin package root is unavailable', 'text/plain; charset=utf-8');
    return;
  }
  const clean = relativePath.replace(/\\/g, '/').replace(/^\/+/, '');
  if (!clean || clean.split('/').some((part) => part === '..' || part.includes('\0'))) {
    sendText(res, 403, 'Forbidden', 'text/plain; charset=utf-8');
    return;
  }
  const target = resolve(input.root, clean);
  if (!isPathInside(input.root, target) || !existsSync(target)) {
    sendText(res, 404, 'Not found', 'text/plain; charset=utf-8');
    return;
  }
  res.writeHead(200, {
    'content-type': contentTypeForClientAsset(target),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff'
  });
  res.end(readFileSync(target));
}

function clientScriptUrl(pluginId: string): string | undefined {
  const record = store.get(pluginId) ?? store.find({ id: pluginId });
  if (!record) return undefined;
  const input = pluginHostInput(record);
  if (!input.root || !input.manifest) return undefined;
  const relative = clientScriptRelativePath(input.manifest, input.root);
  return relative ? `${clientBaseUrl.replace(/\/+$/, '')}/client-asset/${encodeURIComponent(pluginId)}/${relative.split('/').map(encodeURIComponent).join('/')}` : undefined;
}

function clientScriptRelativePath(manifest: JsonObject, root: string): string | undefined {
  const dsh = objectValue(manifest.dsh);
  const client = objectValue(dsh.client ?? manifest['dsh.client']);
  const exportsObject = objectValue(manifest.exports);
  const candidates = [
    stringValue(client.entry),
    stringValue(client.main),
    stringValue(client.script),
    stringValue(exportsObject['./client']),
    'lib/client.js',
    'dist/client.js',
    'client.js'
  ].filter((item) => item.trim().length > 0);
  for (const candidate of candidates) {
    const clean = candidate.replace(/^\.?\//, '');
    const target = resolve(root, clean);
    if (isPathInside(root, target) && existsSync(target)) return clean.replace(/\\/g, '/');
  }
  return undefined;
}

function contentTypeForClientAsset(path: string): string {
  const lower = path.toLowerCase();
  if (lower.endsWith('.js') || lower.endsWith('.mjs')) return 'text/javascript; charset=utf-8';
  if (lower.endsWith('.css')) return 'text/css; charset=utf-8';
  if (lower.endsWith('.json')) return 'application/json; charset=utf-8';
  if (lower.endsWith('.png')) return 'image/png';
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
  if (lower.endsWith('.webp')) return 'image/webp';
  if (lower.endsWith('.gif')) return 'image/gif';
  if (lower.endsWith('.svg')) return 'image/svg+xml';
  return 'application/octet-stream';
}

function sendText(res: ServerResponse, statusCode: number, body: string, contentType: string): void {
  res.writeHead(statusCode, {
    'content-type': contentType,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff'
  });
  res.end(body);
}

export function clientMountShellHtml(mount: DshSidecarClientMount | undefined, pluginId: string, mountId: string, error?: string, clientScript?: string): string {
  const title = mount?.title || mountId || pluginId || 'DSH Plugin';
  const permissions = mount?.permissions?.length ? mount.permissions.join(', ') : 'none';
  const payload = JSON.stringify({ mount, pluginId, mountId });
  const bootstrap = clientMountBootstrapScript(payload);
  const scriptTag = clientScript ? `<script src="${escapeHtml(clientScript)}"></script>` : '';
  const isCompanionMount = Boolean(mount && (mount.mountPoint === 'desktop-companion' || mount.mountPoint === 'floating'));
  const bodyClass = [
    clientScript || mount ? 'has-client' : '',
    isCompanionMount ? 'companion-client' : ''
  ].filter(Boolean).join(' ');
  const rootInitialContent = isCompanionMount ? '' : `<div class="client-loading">Loading ${escapeHtml(title)}...</div>`;
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(title)}</title>
  <style>
    :root { width: 100%; height: 100%; color-scheme: dark light; font-family: Inter, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    html { width: 100%; height: 100%; background: transparent; }
    body { width: 100%; min-width: 0; height: 100%; margin: 0; min-height: 100vh; background: #101418; color: #edf2f7; display: grid; place-items: center; }
    body.has-client { display: block !important; place-items: initial; background: #fff; color: #1f2329; overflow: hidden; }
    body.companion-client { background: transparent; color: #1f2329; }
    body.has-client > .mount-info { display: none; }
    #plugin-root { width: 100%; min-width: 0; min-height: 100vh; height: 100vh; display: none; }
    body.has-client #plugin-root { display: block; }
    .client-loading { min-height: 100vh; display: grid; place-items: center; color: #646a73; font-size: 13px; }
    .client-error { margin: 24px; padding: 14px; border: 1px solid #fca5a5; border-radius: 10px; background: #fef2f2; color: #991b1b; white-space: pre-wrap; }
    .plugin-companion-close { display: none; position: fixed; top: 10px; right: 10px; z-index: 2147483647; width: 28px; height: 28px; border: 0; border-radius: 999px; background: rgba(17, 24, 39, .72); color: #fff; font-size: 18px; line-height: 28px; cursor: pointer; opacity: .2; transition: opacity .12s ease, transform .12s ease; }
    body.companion-client .plugin-companion-close { display: grid; place-items: center; }
    body.companion-client .plugin-companion-close:hover { opacity: .95; transform: scale(1.04); }
    .dsh-client-shell { width: 100%; min-width: 0; min-height: 100vh; height: 100vh; display: grid; grid-template-columns: 184px minmax(0, 1fr); background: #fff; color: #1f2329; overflow: hidden; }
    .dsh-settings-rail { min-width: 0; padding: 18px 14px; border-right: 1px solid #eef0f3; background: #fff; overflow-y: auto; }
    .dsh-settings-title { margin: 0 0 20px; font-size: 16px; line-height: 24px; font-weight: 760; }
    .dsh-settings-nav { display: grid; gap: 7px; }
    .dsh-settings-nav-item { min-width: 0; min-height: 40px; display: flex; align-items: center; gap: 10px; padding: 0 11px; border: 0; border-radius: 10px; color: #4e5969; background: transparent; font: inherit; font-size: 14px; text-align: left; white-space: nowrap; cursor: default; }
    .dsh-settings-nav-item.active { color: #1f2329; background: #eef2ff; font-weight: 650; }
    .dsh-settings-nav-item.selectable { cursor: pointer; }
    .dsh-settings-nav-icon { width: 18px; height: 18px; display: inline-grid; place-items: center; flex: 0 0 18px; color: #646a73; font-size: 15px; line-height: 1; }
    .dsh-client-main { width: 100%; min-width: 0; min-height: 0; overflow: auto; background: #fff; }
    .dsh-client-content { width: 100%; min-width: 0; max-width: none; padding: 26px 32px 40px; box-sizing: border-box; }
    .dsh-client-content > * { min-width: 0; }
    .dsh-client-content .dim-page { max-width: none; }
    .mount-info { width: min(720px, calc(100vw - 32px)); border: 1px solid rgba(255,255,255,.14); border-radius: 14px; padding: 22px; background: rgba(255,255,255,.05); box-shadow: 0 18px 40px rgba(0,0,0,.25); }
    .mount-info h1 { margin: 0 0 8px; font-size: 22px; }
    .mount-info p { color: #b8c2cc; line-height: 1.55; }
    .mount-info code { background: rgba(255,255,255,.08); border-radius: 6px; padding: 2px 6px; }
    .grid { display: grid; grid-template-columns: 120px 1fr; gap: 8px 12px; margin-top: 16px; color: #dbe4ee; }
    .label { color: #8ea0b2; }
    .error { margin-top: 14px; color: #ffd2d2; background: rgba(255, 80, 80, .12); border: 1px solid rgba(255, 120, 120, .25); border-radius: 10px; padding: 10px; }
    @media (max-width: 760px) {
      .dsh-client-shell { grid-template-columns: minmax(0, 1fr); }
      .dsh-settings-rail { display: none; }
      .dsh-client-content { padding: 18px 16px 32px; }
    }
  </style>
</head>
<body class="${escapeHtml(bodyClass)}">
  <button class="plugin-companion-close" type="button" title="Close" onclick="window.close()" aria-label="Close">&times;</button>
  <main class="mount-info">
    <h1>${escapeHtml(title)}</h1>
    <p>DSH client mount is active in the Tasi sidecar host. Plugins that provide a bundled web client can use <code>window.dsh</code> to call the sidecar bridge from this isolated page.</p>
    <div class="grid">
      <span class="label">Plugin</span><span>${escapeHtml(mount?.packageName || pluginId || 'unknown')}</span>
      <span class="label">Mount</span><span>${escapeHtml(mount?.mountPoint || 'unknown')}</span>
      <span class="label">ID</span><span>${escapeHtml(mount?.id || mountId || 'unknown')}</span>
      <span class="label">Permissions</span><span>${escapeHtml(permissions)}</span>
    </div>
    ${error ? `<div class="error">${escapeHtml(error)}</div>` : ''}
  </main>
  <div id="plugin-root">${rootInitialContent}</div>
  <script>
${bootstrap}
  </script>
  ${scriptTag}
</body>
</html>`;
}

export function clientMountBootstrapScript(payload: string): string {
  return `
    (function () {
      var mountPayload = ${payload};
      var rootEl = document.getElementById('plugin-root');
      var dictionaries = {};
      var slotEntries = [];
      var disposers = [];
      var activeSlotId = '';
      var renderTimer = 0;

      function showError(error) {
        var message = error && error.stack ? error.stack : error && error.message ? error.message : String(error);
        if (!rootEl) return;
        rootEl.innerHTML = '';
        var box = document.createElement('pre');
        box.className = 'client-error';
        box.textContent = message;
        rootEl.appendChild(box);
      }

      window.addEventListener('error', function (event) { showError(event.error || event.message); });
      window.addEventListener('unhandledrejection', function (event) { showError(event.reason || 'Unhandled promise rejection'); });

      var React = (function () {
        var Fragment = Symbol('Fragment');
        var currentRoot = null;
        var currentFrame = null;
        var hookIndex = 0;
        var pendingEffects = [];
        var roots = new WeakMap();

        function flatten(input, out) {
          if (Array.isArray(input)) {
            input.forEach(function (item) { flatten(item, out); });
          } else if (input !== undefined && input !== null && input !== false && input !== true) {
            out.push(input);
          }
          return out;
        }

        function createElement(type, props) {
          var children = flatten(Array.prototype.slice.call(arguments, 2), []);
          var nextProps = {};
          if (props) {
            Object.keys(props).forEach(function (key) { nextProps[key] = props[key]; });
          }
          if (children.length === 1) nextProps.children = children[0];
          else if (children.length > 1) nextProps.children = children;
          return { type: type, props: nextProps };
        }

        function depsChanged(prev, next) {
          if (!prev || !next || prev.length !== next.length) return true;
          for (var i = 0; i < prev.length; i += 1) {
            if (!Object.is(prev[i], next[i])) return true;
          }
          return false;
        }

        function schedule(root) {
          if (root.queued) return;
          root.queued = true;
          setTimeout(function () {
            root.queued = false;
            rerender(root);
          }, 0);
        }

        function activeFrame(name) {
          if (!currentRoot || !currentFrame) throw new Error(name + ' called outside render');
          return currentFrame;
        }

        function useState(initial) {
          var frame = activeFrame('useState');
          var root = currentRoot;
          var index = hookIndex++;
          var hook = frame.hooks[index];
          if (!hook || hook.kind !== 'state') {
            hook = { kind: 'state', value: typeof initial === 'function' ? initial() : initial };
            frame.hooks[index] = hook;
          }
          return [hook.value, function (value) {
            hook.value = typeof value === 'function' ? value(hook.value) : value;
            schedule(root);
          }];
        }

        function useReducer(reducer, initialArg, init) {
          var pair = useState(function () { return init ? init(initialArg) : initialArg; });
          return [pair[0], function (action) { pair[1](function (state) { return reducer(state, action); }); }];
        }

        function useRef(initial) {
          var frame = activeFrame('useRef');
          var index = hookIndex++;
          var hook = frame.hooks[index];
          if (!hook || hook.kind !== 'ref') {
            hook = { kind: 'ref', current: initial };
            frame.hooks[index] = hook;
          }
          return hook;
        }

        function useMemo(factory, deps) {
          var frame = activeFrame('useMemo');
          var index = hookIndex++;
          var cached = frame.hooks[index];
          if (!cached || cached.kind !== 'memo' || depsChanged(cached.deps, deps)) {
            cached = { kind: 'memo', deps: deps, value: factory() };
            frame.hooks[index] = cached;
          }
          return cached.value;
        }

        function useEffect(factory, deps) {
          var frame = activeFrame('useEffect');
          var index = hookIndex++;
          var cached = frame.effects[index];
          if (!cached || depsChanged(cached.deps, deps)) {
            pendingEffects.push({ frame: frame, index: index, factory: factory, deps: deps });
          }
        }

        function createContext(defaultValue) {
          var context = { current: defaultValue, defaultValue: defaultValue };
          context.Provider = function Provider(props) {
            return { __provider: context, value: props.value, children: props.children };
          };
          return context;
        }

        function useContext(context) {
          return context.current === undefined ? context.defaultValue : context.current;
        }

        function setProps(el, props) {
          Object.keys(props || {}).forEach(function (key) {
            var value = props[key];
            if (key === 'children' || key === 'ref' || key === 'key' || value === undefined || value === null || value === false) return;
            if (key === 'className') {
              el.setAttribute('class', String(value));
            } else if (key === 'style' && value && typeof value === 'object') {
              Object.keys(value).forEach(function (name) { el.style[name] = value[name]; });
            } else if (key === 'dangerouslySetInnerHTML' && value && typeof value.__html === 'string') {
              el.innerHTML = value.__html;
            } else if (/^on[A-Z]/.test(key) && typeof value === 'function') {
              el.addEventListener(key.slice(2).toLowerCase(), value);
            } else if (key === 'htmlFor') {
              el.setAttribute('for', String(value));
            } else if (key in el) {
              try { el[key] = value; } catch (_) { el.setAttribute(key, String(value)); }
            } else if (value === true) {
              el.setAttribute(key, '');
            } else {
              el.setAttribute(key, String(value));
            }
          });
        }

        function componentFrame(root, node, path) {
          var type = node && node.type;
          var props = node && node.props || {};
          var key = props.key !== undefined && props.key !== null ? String(props.key) : type && type.name ? type.name : 'component';
          var frameKey = path.join('.') + ':' + key;
          var frame = root.frames[frameKey];
          if (!frame || frame.type !== type) {
            frame = { type: type, hooks: [], effects: [] };
            root.frames[frameKey] = frame;
          }
          root.seenFrames[frameKey] = true;
          return frame;
        }

        function toDom(node, root, path) {
          if (Array.isArray(node)) {
            var frag = document.createDocumentFragment();
            node.forEach(function (child, index) { frag.appendChild(toDom(child, root, path.concat(index))); });
            return frag;
          }
          if (node === undefined || node === null || node === false || node === true) return document.createTextNode('');
          if (typeof node === 'string' || typeof node === 'number') return document.createTextNode(String(node));
          if (node.__portal) {
            var portalKey = path.join('.') + ':portal';
            var portal = root.portals[portalKey];
            if (!portal || portal.container !== node.container) {
              if (portal && portal.host && portal.host.parentNode) portal.host.parentNode.removeChild(portal.host);
              portal = { container: node.container, host: document.createElement('div') };
              portal.host.setAttribute('data-tasi-dsh-portal', portalKey);
              node.container.appendChild(portal.host);
              root.portals[portalKey] = portal;
            }
            root.seenPortals[portalKey] = true;
            portal.host.replaceChildren(toDom(node.children, root, path.concat('portal')));
            return document.createTextNode('');
          }
          if (node.__provider) {
            var previous = node.__provider.current;
            node.__provider.current = node.value;
            var provided = toDom(node.children, root, path.concat('provider'));
            node.__provider.current = previous;
            return provided;
          }
          if (node.type === Fragment) return toDom(node.props && node.props.children, root, path.concat('fragment'));
          if (typeof node.type === 'function') {
            var previousFrame = currentFrame;
            var previousHookIndex = hookIndex;
            var frame = componentFrame(root, node, path);
            currentFrame = frame;
            hookIndex = 0;
            var rendered = node.type(node.props || {});
            currentFrame = previousFrame;
            hookIndex = previousHookIndex;
            return toDom(rendered, root, path.concat('rendered'));
          }
          var el = document.createElement(String(node.type));
          setProps(el, node.props || {});
          if (!(node.props && node.props.dangerouslySetInnerHTML)) {
            flatten(node.props && node.props.children, []).forEach(function (child, index) { el.appendChild(toDom(child, root, path.concat(String(node.type), index))); });
          }
          var ref = node.props && node.props.ref;
          if (typeof ref === 'function') ref(el);
          else if (ref && typeof ref === 'object') ref.current = el;
          return el;
        }

        function rerender(root) {
          currentRoot = root;
          currentFrame = null;
          hookIndex = 0;
          pendingEffects = [];
          root.seenFrames = {};
          root.seenPortals = {};
          root.container.replaceChildren(toDom(root.element, root, ['root']));
          currentRoot = null;
          currentFrame = null;
          Object.keys(root.portals).forEach(function (key) {
            if (root.seenPortals[key]) return;
            var portal = root.portals[key];
            if (portal && portal.host && portal.host.parentNode) portal.host.parentNode.removeChild(portal.host);
            delete root.portals[key];
          });
          Object.keys(root.frames).forEach(function (key) {
            if (root.seenFrames[key]) return;
            root.frames[key].effects.forEach(function (effect) {
              if (effect && typeof effect.cleanup === 'function') {
                try { effect.cleanup(); } catch (_) {}
              }
            });
            delete root.frames[key];
          });
          pendingEffects.forEach(function (item) {
            var old = item.frame.effects[item.index];
            if (old && typeof old.cleanup === 'function') {
              try { old.cleanup(); } catch (_) {}
            }
            var cleanup = item.factory();
            item.frame.effects[item.index] = { deps: item.deps, cleanup: cleanup };
          });
        }

        function render(element, container) {
          var root = roots.get(container) || { container: container, frames: {}, seenFrames: {}, portals: {}, seenPortals: {}, queued: false, element: element };
          root.element = element;
          roots.set(container, root);
          rerender(root);
        }

        function forwardRef(fn) {
          return function ForwardRef(props) { return fn(props || {}, props ? props.ref : null); };
        }

        function cloneElement(element, props) {
          var children = Array.prototype.slice.call(arguments, 2);
          return createElement.apply(null, [element.type, Object.assign({}, element.props || {}, props || {})].concat(children.length ? children : [element.props && element.props.children]));
        }

        return {
          Fragment: Fragment,
          createElement: createElement,
          createContext: createContext,
          useContext: useContext,
          useState: useState,
          useReducer: useReducer,
          useRef: useRef,
          useMemo: useMemo,
          useCallback: function (fn, deps) { return useMemo(function () { return fn; }, deps); },
          useEffect: useEffect,
          useLayoutEffect: useEffect,
          useId: function () { return 'tasi-' + Math.random().toString(36).slice(2); },
          useDeferredValue: function (value) { return value; },
          useSyncExternalStore: function (subscribe, getSnapshot) { useEffect(function () { return subscribe(function () {}); }, [subscribe]); return getSnapshot(); },
          startTransition: function (fn) { fn(); },
          forwardRef: forwardRef,
          memo: function (component) { return component; },
          cloneElement: cloneElement,
          isValidElement: function (value) { return !!value && typeof value === 'object' && 'type' in value; },
          Children: {
            toArray: function (children) { return flatten(children, []); },
            map: function (children, fn) { return flatten(children, []).map(fn); },
            count: function (children) { return flatten(children, []).length; },
            only: function (children) { return flatten(children, [])[0]; }
          },
          __render: render,
          __createPortal: function (children, container) { return { __portal: true, children: children, container: container }; }
        };
      })();

      function translate(namespace, key) {
        var language = (navigator.language || '').toLowerCase().startsWith('zh') ? 'zh' : 'en';
        var table = dictionaries[namespace] || {};
        var bundle = table[language] || table.en || table.zh || {};
        return typeof bundle[key] === 'string' ? bundle[key] : key;
      }

      var locale = {
        register: function (namespace, table) {
          dictionaries[namespace] = table || {};
          scheduleRenderSlots();
          return function () { delete dictionaries[namespace]; scheduleRenderSlots(); };
        },
        bind: function (namespace) {
          return function (key) { return translate(namespace, key); };
        }
      };

      function rpcCall(channel, endpoint, payload, signal) {
        return fetch('/client-rpc', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ channel: channel, endpoint: endpoint, payload: payload }),
          signal: signal
        }).then(function (response) { return response.json(); }).then(function (result) {
          if (result && result.ok) return result.value;
          var message = result && result.error && result.error.message ? result.error.message : 'RPC failed';
          throw new Error(message);
        });
      }

      function workspaceCall(method, args, signal) {
        return fetch('/client-workspaces', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ method: method, args: args || [] }),
          signal: signal
        }).then(function (response) { return response.json(); }).then(function (result) {
          if (result && result.ok) return result.value;
          var error = result && result.error ? result.error : {};
          var thrown = new Error(error.message || 'Workspace operation failed.');
          thrown.code = error.code || 'workspace-failed';
          thrown.details = error.details;
          thrown.rpcError = error;
          throw thrown;
        });
      }

      function retainDisposer(value) {
        if (typeof value === 'function') disposers.push(value);
        return value;
      }

      function consumeEffectResult(value) {
        if (!value) return value;
        if (typeof value.then === 'function') {
          value.then(consumeEffectResult).catch(showError);
          return value;
        }
        if (typeof value[Symbol.iterator] === 'function') {
          var last;
          try {
            var iterator = value[Symbol.iterator]();
            var step = iterator.next();
            while (!step.done) {
              last = consumeEffectResult(step.value);
              step = iterator.next();
            }
          } catch (error) {
            showError(error);
          }
          return last;
        }
        if (typeof Symbol !== 'undefined' && Symbol.asyncIterator && typeof value[Symbol.asyncIterator] === 'function') {
          (async function () {
            try {
              for await (var item of value) consumeEffectResult(item);
            } catch (error) {
              showError(error);
            }
          })();
          return value;
        }
        return retainDisposer(value);
      }

      function scheduleRenderSlots() {
        clearTimeout(renderTimer);
        renderTimer = setTimeout(renderSlots, 0);
      }

      function renderSlots() {
        if (!rootEl) return;
        var settingsEntries = slotEntries.filter(function (entry) {
          return entry.meta && (entry.meta.name === 'settings.section' || entry.meta.name === 'settings.plugin.item');
        });
        if (settingsEntries.length === 0) {
          if (mountPayload.mount && mountPayload.mount.mountPoint !== 'settings') {
            rootEl.innerHTML = '';
            return;
          }
          rootEl.innerHTML = '<div class="client-loading">Client loaded. No standalone settings UI was registered.</div>';
          return;
        }
        if (!activeSlotId || !settingsEntries.some(function (entry) { return entry.id === activeSlotId; })) activeSlotId = settingsEntries[0].id;
        var active = settingsEntries.find(function (entry) { return entry.id === activeSlotId; }) || settingsEntries[0];

        function currentLanguage() {
          return (navigator.language || '').toLowerCase().startsWith('zh') ? 'zh' : 'en';
        }

        function label(zh, en) {
          return currentLanguage() === 'zh' ? zh : en;
        }

        function entryLabel(entry) {
          if (!entry || !entry.meta) return '';
          return typeof entry.meta.label === 'function' ? entry.meta.label() : entry.meta.label || entry.id;
        }

        function Shell() {
          var pluginNavLabel = entryLabel(active) || label('IM 机器人', 'IM Bots');
          var navItems = [
            { id: 'general', icon: 'G', text: label('通用设置', 'General') },
            { id: 'models', icon: 'M', text: label('模型', 'Models') },
            { id: 'plugins', icon: 'P', text: label('插件', 'Plugins') },
            { id: 'presets', icon: 'A', text: label('Agent 预设', 'Agent Presets') }
          ];
          return React.createElement('div', { className: 'dsh-client-shell' },
            React.createElement('aside', { className: 'dsh-settings-rail' },
              React.createElement('h1', { className: 'dsh-settings-title' }, label('设置', 'Settings')),
              React.createElement('nav', { className: 'dsh-settings-nav', 'aria-label': label('设置导航', 'Settings navigation') },
                navItems.map(function (item) {
                  return React.createElement('div', { key: item.id, className: 'dsh-settings-nav-item' },
                    React.createElement('span', { className: 'dsh-settings-nav-icon', 'aria-hidden': 'true' }, item.icon),
                    React.createElement('span', null, item.text)
                  );
                }),
                settingsEntries.map(function (entry) {
                  var itemLabel = entryLabel(entry);
                  return React.createElement('button', {
                    key: entry.id,
                    type: 'button',
                    className: 'dsh-settings-nav-item selectable' + (entry.id === activeSlotId ? ' active' : ''),
                    onClick: function () { activeSlotId = entry.id; scheduleRenderSlots(); }
                  },
                    React.createElement('span', { className: 'dsh-settings-nav-icon', 'aria-hidden': 'true' }, 'IM'),
                    React.createElement('span', null, itemLabel || pluginNavLabel)
                  );
                })
              )
            ),
            React.createElement('main', { className: 'dsh-client-main' },
              React.createElement('div', { className: 'dsh-client-content' },
                React.createElement(active.component, Object.assign({
                  t: locale.bind(active.meta.locale || ''),
                  rpcCall: function (endpoint, payload, signal) { return rpcCall('/dsh-plugin/' + mountPayload.pluginId, endpoint, payload, signal); }
                }, typeof active.meta.inject === 'function' ? active.meta.inject() || {} : {}))
              )
            )
          );
        }
        React.__render(React.createElement(Shell, null), rootEl);
      }

      var slots = {
        inject: function (_name, callback) {
          if (typeof callback === 'function') return consumeEffectResult(callback());
          return undefined;
        },
        register: function (meta, component) {
          var entry = {
            id: meta && meta.id ? String(meta.id) : 'slot-' + slotEntries.length,
            meta: meta || {},
            component: component
          };
          slotEntries.push(entry);
          scheduleRenderSlots();
          return function () {
            slotEntries = slotEntries.filter(function (item) { return item !== entry; });
            scheduleRenderSlots();
          };
        }
      };

      var context = {
        mount: mountPayload.mount,
        app: 'tasi-harness',
        sidecar: true,
        effect: function (factory) {
          return consumeEffectResult(typeof factory === 'function' ? factory() : undefined);
        },
        locale: locale,
        slots: slots,
        workspaces: {
          listDirectory: function (path, signal) { return workspaceCall('listDirectory', [path], signal); },
          pickDirectory: function (signal) { return workspaceCall('pickDirectory', [], signal); }
        },
        connection: {
          rpc: {
            call: rpcCall
          }
        }
      };

      function moduleRequire(name) {
        if (name === 'react') return React;
        if (name === 'react-dom' || name === 'react-dom/client') {
          return {
            render: React.__render,
            createRoot: function (container) { return { render: function (element) { React.__render(element, container); }, unmount: function () { container.replaceChildren(); } }; },
            createPortal: React.__createPortal
          };
        }
        if (name === 'react/jsx-runtime' || name === 'react/jsx-dev-runtime') {
          return {
            Fragment: React.Fragment,
            jsx: function (type, props) { return React.createElement(type, props); },
            jsxs: function (type, props) { return React.createElement(type, props); }
          };
        }
        if (name === '@deepseek-ai/dsh-client-ui-primitives') {
          return clientUiPrimitives();
        }
        throw new Error('Plugin client module require("' + name + '") is not available in the Tasi sidecar shell.');
      }

      function primitiveStyle(extra) {
        return Object.assign({
          boxSizing: 'border-box',
          minWidth: 0,
          font: 'inherit',
          color: 'inherit'
        }, extra || {});
      }

      function mergePropsStyle(props, style) {
        return Object.assign({}, props || {}, { style: Object.assign({}, style, props && props.style || {}) });
      }

      function clientUiPrimitives() {
        return {
          Input: function Input(props) {
            return React.createElement('input', mergePropsStyle(props, primitiveStyle({
              width: '100%',
              minHeight: '34px',
              padding: '7px 10px',
              border: '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.35))',
              borderRadius: '8px',
              background: 'var(--dsw-alias-bg-layer-3, transparent)'
            })));
          },
          Textarea: function Textarea(props) {
            return React.createElement('textarea', mergePropsStyle(props, primitiveStyle({
              width: '100%',
              minHeight: '80px',
              padding: '7px 10px',
              border: '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.35))',
              borderRadius: '8px',
              background: 'var(--dsw-alias-bg-layer-3, transparent)',
              resize: 'vertical'
            })));
          },
          Button: function Button(props) {
            return React.createElement('button', mergePropsStyle(props, primitiveStyle({
              minHeight: '32px',
              padding: '5px 14px',
              border: '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.35))',
              borderRadius: '8px',
              background: 'transparent',
              cursor: props && props.disabled ? 'default' : 'pointer'
            })));
          },
          Select: function Select(props) {
            return React.createElement('select', mergePropsStyle(props, primitiveStyle({
              width: '100%',
              minHeight: '34px',
              padding: '7px 10px',
              border: '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.35))',
              borderRadius: '8px',
              background: 'transparent'
            })));
          }
        };
      }

      window.__TASI_DSH_CLIENT_MOUNT__ = mountPayload;
      window.__TASI_DSH_CLIENT_CONTEXT__ = context;
      window.React = window.React || React;
      window.ReactDOM = window.ReactDOM || moduleRequire('react-dom');
      window.dsh = {
        call: rpcCall,
        on: function () { return function unsubscribe() {}; },
        settings: {
          get: function () { return Promise.resolve({}); },
          set: function () { return Promise.resolve({}); }
        },
        agent: {
          ask: function (_prompt) { return Promise.reject(new Error('agent bridge is not connected yet.')); }
        }
      };
      window.__ModuleLoader__ = window.__ModuleLoader__ || {
        load: function (definition) {
          try {
            var exports = definition && typeof definition.factory === 'function' ? definition.factory(moduleRequire) : undefined;
            var apply = exports && typeof exports.apply === 'function' ? exports.apply : undefined;
            if (apply) apply(context);
            scheduleRenderSlots();
            return exports;
          } catch (error) {
            showError(error);
            return {};
          }
        }
      };
      window.addEventListener('beforeunload', function () {
        disposers.reverse().forEach(function (dispose) {
          try { dispose(); } catch (_) {}
        });
      });
    })();
  `;
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function runtimeFingerprint(): string {
  return JSON.stringify(store.list().map((record) => ({
    id: record.id,
    packageName: record.packageName,
    version: record.version,
    enabled: record.enabled,
    status: record.status,
    profileName: record.profileName,
    updatedAt: record.updatedAt
  })));
}

function pluginHostInput(record: DshSidecarPluginRecord) {
  const profile = ensureProfile(record.profileName || defaultProfileName);
  const manifest = readPackageManifest(profile, record.packageName);
  const root = resolvePackageRoot(profile, record.packageName);
  const patchPath = resolvePatchPath(profile, record, manifest);
  const entry = moduleEntryPath(root, manifest);
  const config = parsePatchBundleConfig(patchPath);
  return { profile, manifest, root, patchPath, entry, config };
}

async function getCordisHost(): Promise<DshCordisHost> {
  const fingerprint = runtimeFingerprint();
  if (cordisHostCache?.fingerprint === fingerprint) return cordisHostCache.host;
  cordisHostCache?.host.dispose();
  const host = new DshCordisHost({
    sidecarHome,
    profileName: defaultProfileName,
    clientBaseUrl: await ensureClientServer(),
    mainRequest: (method, params) => callParent(method, params)
  });
  for (const record of store.list()) {
    if (!record.enabled || record.status === 'failed' || record.status === 'incompatible') continue;
    let currentRecord = record;
    let input = pluginHostInput(currentRecord);
    if (!input.root) {
      const repaired = await repairInstalledRecord(currentRecord);
      if (repaired.id !== currentRecord.id) store.remove(currentRecord.id);
      store.upsert(repaired);
      currentRecord = repaired;
      input = pluginHostInput(currentRecord);
      if (currentRecord.status === 'failed' || currentRecord.status === 'incompatible') continue;
    }
    const prepareWarnings = currentRecord.packageName ? await prepareInstalledPlugin(input.profile, currentRecord.packageName) : [];
    if (prepareWarnings.length > 0 && prepareWarnings.join('\n') !== record.lastError) {
      store.upsert({
        ...currentRecord,
        lastError: prepareWarnings.join('\n'),
        updatedAt: nowIso()
      });
    }
    input = pluginHostInput(currentRecord);
    if (!input.entry && currentRecord.packageName) {
      const warnings = await installNpmReleaseForMissingEntry(input.profile, currentRecord.packageName, currentRecord.version);
      input = pluginHostInput(currentRecord);
      const nextSource = input.entry ? npmReleaseSpecifier(currentRecord.packageName, currentRecord.version) : currentRecord.source;
      store.upsert({
        ...currentRecord,
        source: nextSource,
        lastError: warnings.join('\n') || (input.entry ? undefined : record.lastError),
        updatedAt: warnings.length > 0 || input.entry ? nowIso() : record.updatedAt
      });
      currentRecord = store.get(currentRecord.id) ?? currentRecord;
    }
    let loaded = await host.loadPlugin({
      record: currentRecord,
      packageRoot: input.root,
      patchPath: input.patchPath,
      moduleEntry: input.entry,
      config: input.config
    });
    const repairedPackages = new Set<string>();
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const missingPackage = missingPackageName(loaded.lastError);
      if (!missingPackage || repairedPackages.has(missingPackage)) break;
      repairedPackages.add(missingPackage);
      const warning = await installMissingRuntimePackage(input.profile, currentRecord.packageName, missingPackage);
      if (warning) {
        store.upsert({ ...currentRecord, lastError: warning, updatedAt: nowIso() });
        break;
      } else {
        input = pluginHostInput(currentRecord);
        loaded = await host.loadPlugin({
          record: currentRecord,
          packageRoot: input.root,
          patchPath: input.patchPath,
          moduleEntry: input.entry,
          config: input.config
        });
        store.upsert({
          ...currentRecord,
          source: currentRecord.source.startsWith('github:') ? npmReleaseSpecifier(currentRecord.packageName, currentRecord.version) : currentRecord.source,
          lastError: loaded.lastError,
          updatedAt: nowIso()
        });
      }
    }
    if (!missingPackageName(loaded.lastError) && loaded.lastError !== record.lastError) {
      store.upsert({
        ...currentRecord,
        lastError: loaded.lastError,
        updatedAt: nowIso()
      });
    }
  }
  cordisHostCache = { fingerprint, host };
  return host;
}

function callParent<T = unknown>(method: string, params?: unknown, timeoutMs = 10 * 60_000): Promise<T> {
  const id = `main-${nextParentRequestId++}`;
  const payload = JSON.stringify({ id, method, params });
  return new Promise<T>((resolveCall, rejectCall) => {
    const timer = setTimeout(() => {
      pendingParentCalls.delete(id);
      rejectCall(new Error(`Tasi main request timed out: ${method}`));
    }, timeoutMs);
    pendingParentCalls.set(id, {
      resolve: (value) => resolveCall(value as T),
      reject: rejectCall,
      timer
    });
    process.stdout.write(`${payload}\n`, 'utf8', (error) => {
      if (!error) return;
      clearTimeout(timer);
      pendingParentCalls.delete(id);
      rejectCall(error);
    });
  });
}

function handleParentResponse(value: unknown): boolean {
  if (!isJsonObject(value)) return false;
  if (typeof value.method === 'string') return false;
  const id = typeof value.id === 'string' ? value.id : '';
  const pending = id ? pendingParentCalls.get(id) : undefined;
  if (!pending) return false;
  clearTimeout(pending.timer);
  pendingParentCalls.delete(id);
  const response = value as unknown as ParentRpcResponse;
  if (response.error) pending.reject(new Error(response.error.message));
  else pending.resolve(response.result);
  return true;
}

function clearCordisHostCache(): void {
  cordisHostCache?.host.dispose();
  cordisHostCache = undefined;
}

function mergeUnique(left: string[], right: string[]): string[] {
  return [...new Set([...left, ...right])];
}

function mergeClientMounts(left: DshSidecarClientMount[], right: DshSidecarClientMount[]): DshSidecarClientMount[] {
  const seen = new Set<string>();
  const out: DshSidecarClientMount[] = [];
  for (const mount of [...left, ...right]) {
    const key = `${mount.pluginId}:${mount.id}:${mount.mountPoint}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(mount);
  }
  return out;
}

export function clientMountsFromManifest(record: DshSidecarPluginRecord, manifest?: JsonObject): DshSidecarClientMount[] {
  if (!manifest) return [];
  const dsh = objectValue(manifest.dsh);
  const client = objectValue(dsh.client ?? manifest['dsh.client']);
  const clientRuntime = objectValue(dsh.clientRuntime ?? manifest['dsh.clientRuntime'] ?? manifest.clientRuntime);
  const declaredMounts = [
    ...clientMountArray(client.mounts),
    ...clientMountArray(clientRuntime.mounts),
    ...clientMountArray(manifest.clientMounts)
  ];
  if (declaredMounts.length > 0) {
    return declaredMounts.map((entry, index) => manifestClientMount(record, entry, index));
  }
  const platform = stringValue(client.platform).trim().toLowerCase();
  if (platform !== 'web') return [];
  if (hasDshSettingsClientExtension(manifest, client)) {
    return [manifestClientMount(record, {
      id: 'settings',
      title: `${stringValue(manifest.displayName ?? manifest.name, record.packageName)} Settings`,
      mountPoint: 'settings',
      path: manifestClientExportPath(manifest) || stringValue(client.entry ?? client.main ?? client.script) || './client'
    }, 0)];
  }
  const clientEntry = manifestClientExportPath(manifest) || stringValue(client.entry ?? client.main ?? client.script);
  if (clientEntry && !isDshClientDependencyExtension(client)) {
    return [manifestClientMount(record, {
      id: stringValue(client.id) || 'client',
      title: stringValue(manifest.displayName ?? manifest.name, record.packageName),
      mountPoint: inferManifestMountPoint(record, manifest, client),
      path: clientEntry
    }, 0)];
  }
  const standaloneUrl = stringValue(client.url ?? client.href ?? client.route ?? client.path);
  if (!standaloneUrl) return [];
  return [manifestClientMount(record, {
    id: record.id,
    title: stringValue(manifest.displayName ?? manifest.name, record.packageName),
    mountPoint: inferManifestMountPoint(record, manifest, client),
    url: standaloneUrl
  }, 0)];
}

function hasDshSettingsClientExtension(manifest: JsonObject, client: JsonObject): boolean {
  if (!manifestClientExportPath(manifest) && !stringValue(client.entry ?? client.main ?? client.script)) return false;
  return stringArray(client.inject).some((item) => {
    const clean = item.trim().toLowerCase();
    return clean === 'settings'
      || clean === 'client-ui-settings'
      || clean.endsWith('/dsh-client-ui-settings')
      || clean.endsWith(':dsh-client-ui-settings')
      || clean.includes('dsh-client-ui-settings');
  });
}

function isDshClientDependencyExtension(client: JsonObject): boolean {
  const inject = stringArray(client.inject).map((item) => item.trim().toLowerCase());
  if (inject.length === 0) return false;
  return inject.some((item) => (
    item.includes('dsh-client-ui-')
    || item.includes('dsh-client-runtime')
    || item.includes('dsh-client-connection')
    || item.includes('dsh-client-locale')
    || item.includes('dsh-client-store')
  ));
}

function manifestClientExportPath(manifest: JsonObject): string {
  const exportsObject = objectValue(manifest.exports);
  const clientExport = exportsObject['./client'];
  const direct = stringValue(clientExport);
  if (direct) return direct;
  const clientExportObject = objectValue(clientExport);
  return stringValue(clientExportObject.default)
    || stringValue(clientExportObject.import)
    || stringValue(clientExportObject.browser)
    || stringValue(clientExportObject.require);
}

function clientMountArray(value: unknown): JsonObject[] {
  if (Array.isArray(value)) return value.map(objectValue).filter((entry) => Object.keys(entry).length > 0);
  const object = objectValue(value);
  if (Object.keys(object).length > 0) return Object.entries(object).map(([id, entry]) => ({ id, ...objectValue(entry) }));
  return [];
}

function manifestClientMount(record: DshSidecarPluginRecord, entry: JsonObject, index: number): DshSidecarClientMount {
  const id = cleanClientMountSegment(stringValue(entry.id) || stringValue(entry.name) || `${record.id}-${index + 1}`);
  const mountPoint = normalizeClientMountPoint(stringValue(entry.mountPoint) || stringValue(entry.slot) || stringValue(entry.area));
  const declaredUrl = stringValue(entry.url) || stringValue(entry.href) || stringValue(entry.route) || stringValue(entry.path);
  return {
    id,
    pluginId: record.id,
    packageName: record.packageName,
    title: stringValue(entry.title) || stringValue(entry.label) || stringValue(entry.name) || record.packageName,
    mountPoint,
    url: sidecarClientMountUrl(record.id, id, declaredUrl),
    icon: stringValue(entry.icon) || undefined,
    description: stringValue(entry.description) || undefined,
    permissions: stringArray(entry.permissions)
  };
}

function inferManifestMountPoint(record: DshSidecarPluginRecord, manifest: JsonObject, client: JsonObject): DshSidecarClientMountPoint {
  const declared = stringValue(client.mountPoint) || stringValue(client.slot) || stringValue(client.area);
  if (declared) return normalizeClientMountPoint(declared);
  const keywords = stringArray(manifest.keywords).join(' ');
  const kind = [
    record.id,
    record.packageName,
    stringValue(manifest.name),
    stringValue(manifest.description),
    keywords,
    stringValue(client.kind),
    stringValue(client.type),
    stringValue(client.window)
  ].join(' ').toLowerCase();
  if (/desktop|companion|pet|floating|whale|widget|balance/.test(kind)) return 'desktop-companion';
  return 'right-panel';
}

function normalizeClientMountPoint(value: string): DshSidecarClientMountPoint {
  const clean = value.trim().toLowerCase().replace(/_/g, '-');
  if (clean === 'sidebar' || clean === 'side-bar' || clean === 'nav' || clean === 'navigation') return 'sidebar';
  if (clean === 'main' || clean === 'main-panel' || clean === 'workspace' || clean === 'page') return 'main-panel';
  if (clean === 'right' || clean === 'right-panel' || clean === 'panel' || clean === 'tool-panel') return 'right-panel';
  if (clean === 'settings' || clean === 'config' || clean === 'configuration') return 'settings';
  if (clean === 'floating' || clean === 'float' || clean === 'overlay') return 'floating';
  if (clean === 'desktop' || clean === 'desktop-companion' || clean === 'companion' || clean === 'pet') return 'desktop-companion';
  if (clean === 'command' || clean === 'command-palette' || clean === 'palette') return 'command-palette';
  if (clean === 'status' || clean === 'status-bar' || clean === 'tray') return 'status-bar';
  return 'right-panel';
}

function sidecarClientMountUrl(pluginId: string, mountId: string, declaredUrl: string): string {
  if (/^https?:\/\//i.test(declaredUrl)) return declaredUrl;
  const base = clientBaseUrl.replace(/\/+$/, '');
  return `${base}/client-mount/${encodeURIComponent(pluginId)}/${encodeURIComponent(mountId)}/`;
}

function cleanClientMountSegment(value: string): string {
  const clean = value.trim().replace(/^@/, '').replace(/[^a-zA-Z0-9_.-]+/g, '-').replace(/^-+|-+$/g, '');
  return clean || `mount-${Date.now().toString(36)}`;
}

function runtimePluginRecord(record: DshSidecarPluginRecord, host: DshCordisHost): DshSidecarRuntimePlugin {
  const { root, patchPath, entry, manifest } = pluginHostInput(record);
  const hosted = host.runtimePlugin(record.id);
  const manifestMounts = record.enabled && record.status !== 'failed' && record.status !== 'incompatible'
    ? clientMountsFromManifest(record, manifest)
    : [];
  const indexTapMounts = record.enabled && record.status !== 'failed' && record.status !== 'incompatible' && hosted?.providedServices.includes('webServer:tapIndex')
    ? [indexTapClientMount(record, manifest)]
    : [];
  const realTools = hosted?.tools ?? [];
  const compatibilityTools = record.enabled && realTools.length === 0 && record.status !== 'failed' && record.status !== 'incompatible'
    ? compatibilityPluginTools(record).map((tool) => tool.function.name)
    : [];
  const tools = record.enabled && record.status !== 'failed' && record.status !== 'incompatible'
    ? mergeUnique(realTools, compatibilityTools)
    : [];
  const insertedNames = parseInsertedBundleNames(patchPath);
  let statusValue: DshSidecarRuntimePlugin['status'] = 'skipped';
  let lastError = record.lastError;
  if (record.enabled && record.status !== 'failed' && record.status !== 'incompatible') {
    if (!root) {
      statusValue = 'failed';
      lastError = `Installed package is not resolvable from profile node_modules: ${record.packageName}`;
    } else if (!patchPath) {
      statusValue = 'failed';
      lastError = `Bundle patch is missing for ${record.packageName}.`;
    } else if (!entry) {
      statusValue = tools.length > 0 ? 'partial' : 'failed';
      lastError = `Runtime module entry is missing for ${record.packageName}; using Tasi compatibility capabilities where available.`;
    } else if (hosted) {
      statusValue = hosted.status === 'failed' && tools.length > 0 ? 'partial' : hosted.status;
      lastError = hosted.lastError;
      if (hosted.status === 'failed' && tools.length > 0) {
        lastError = `${hosted.lastError || `Failed to load ${record.packageName} through Cordis host.`} Using Tasi compatibility capabilities where available.`;
      }
    } else {
      statusValue = tools.length > 0 ? 'partial' : 'failed';
      lastError = tools.length > 0
        ? 'Cordis host did not load this plugin; using Tasi compatibility capabilities where available.'
        : 'Cordis host did not load this plugin and no compatibility capabilities are available.';
    }
  }
  return {
    id: record.id,
    packageName: record.packageName,
    version: record.version,
    enabled: record.enabled,
    status: statusValue,
    packageRoot: root,
    patchPath,
    moduleEntry: entry,
    tools,
    settingsEntries: mergeUnique(hosted?.settingsEntries ?? [], pluginSettingsEntries(record)),
    commands: mergeUnique(hosted?.commands ?? [], [...pluginCommands(record), ...insertedNames.filter((name) => name.startsWith('/'))]),
    webRoutes: hosted?.webRoutes ?? [],
    clientMounts: mergeClientMounts(hosted?.clientMounts ?? [], [...manifestMounts, ...indexTapMounts]),
    lastError
  };
}

function indexTapClientMount(record: DshSidecarPluginRecord, manifest?: JsonObject): DshSidecarClientMount {
  const client = objectValue(objectValue(manifest?.dsh).client ?? manifest?.['dsh.client']);
  const title = stringValue(manifest?.displayName ?? manifest?.name, record.packageName);
  return {
    id: 'web',
    pluginId: record.id,
    packageName: record.packageName,
    title,
    mountPoint: inferManifestMountPoint(record, manifest ?? {}, client),
    url: sidecarClientMountUrl(record.id, 'web', ''),
    description: stringValue(manifest?.description) || undefined
  };
}

async function runtimeStatus(profileName = defaultProfileName): Promise<DshSidecarRuntimeStatus> {
  const host = await getCordisHost();
  const plugins = store.list().map((record) => runtimePluginRecord(record, host));
  const enabledTools = new Set(plugins.flatMap((plugin) => plugin.tools));
  const tools = await runtimeToolDefinitions();
  const skills = await runtimeSkillDocuments();
  return {
    status: status(profileName),
    plugins: plugins.map((plugin) => ({
      ...plugin,
      skills: skills.filter((skill) => skill.pluginId === plugin.id).map((skill) => skill.name)
    })),
    tools: tools.filter((tool) => enabledTools.has(tool.function.name)),
    skills,
    clientMounts: plugins.flatMap((plugin) => plugin.clientMounts ?? [])
  };
}

async function runtimeSkillDocuments(): Promise<DshSidecarRuntimeSkill[]> {
  const host = await getCordisHost();
  return await host.skillDocuments();
}

async function runtimeToolDefinitions(): Promise<RuntimeTool[]> {
  const host = await getCordisHost();
  const realTools = host.toolDefinitions().map((tool): RuntimeTool => ({ ...tool, pluginId: 'cordis' }));
  const realToolNames = new Set(realTools.map((tool) => tool.function.name));
  const compatibilityTools = store.list()
    .filter((record) => record.enabled && record.status !== 'failed' && record.status !== 'incompatible')
    .flatMap((record) => {
      const hosted = host.runtimePlugin(record.id);
      return hosted && hosted.tools.length > 0 ? [] : compatibilityPluginTools(record);
    })
    .filter((tool) => !realToolNames.has(tool.function.name));
  return [...realTools, ...compatibilityTools];
}

function agentTeamsToolDefinitions(pluginId: string): RuntimeTool[] {
  return [
    {
      pluginId,
      type: 'function',
      function: {
        name: 'agent_teams_create',
        description: 'Create or reset the active AgentTeams compatibility team for this Tasi session. Use it when the user asks to use AgentTeams, build a team, or coordinate several specialist agents.',
        parameters: {
          type: 'object',
          properties: {
            goal: { type: 'string', description: 'The shared team objective.' },
            team_id: { type: 'string', description: 'Optional stable team id. Defaults to the Tasi session id.' },
            members: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  name: { type: 'string' },
                  role: { type: 'string' },
                  prompt: { type: 'string' },
                  provider: { type: 'string' },
                  model: { type: 'string' },
                  reasoning_effort: { type: 'string' }
                }
              }
            },
            tasks: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  title: { type: 'string' },
                  description: { type: 'string' },
                  assignee: { type: 'string' },
                  blockers: { type: 'array', items: { type: 'string' } }
                }
              }
            },
            approval: { type: 'string', enum: ['required', 'automatic'], description: 'Accepted for DSH compatibility. Tasi compatibility mode records the plan immediately.' }
          },
          required: ['goal']
        }
      }
    },
    {
      pluginId,
      type: 'function',
      function: {
        name: 'agent_teams_add_member',
        description: 'Add or update a member in the active AgentTeams compatibility team.',
        parameters: {
          type: 'object',
          properties: {
            team_id: { type: 'string' },
            name: { type: 'string' },
            role: { type: 'string' },
            prompt: { type: 'string' },
            provider: { type: 'string' },
            model: { type: 'string' },
            reasoning_effort: { type: 'string' }
          },
          required: ['name']
        }
      }
    },
    {
      pluginId,
      type: 'function',
      function: {
        name: 'agent_teams_create_task',
        description: 'Create a dependency-aware task in the active AgentTeams compatibility board.',
        parameters: {
          type: 'object',
          properties: {
            team_id: { type: 'string' },
            title: { type: 'string' },
            description: { type: 'string' },
            assignee: { type: 'string' },
            blockers: { type: 'array', items: { type: 'string' } }
          },
          required: ['title']
        }
      }
    },
    {
      pluginId,
      type: 'function',
      function: {
        name: 'agent_teams_update_task',
        description: 'Update an AgentTeams compatibility task status, assignee, and notes.',
        parameters: {
          type: 'object',
          properties: {
            team_id: { type: 'string' },
            task_id: { type: 'string' },
            status: { type: 'string', enum: ['pending', 'in_progress', 'blocked', 'done', 'failed'] },
            assignee: { type: 'string' },
            note: { type: 'string' }
          },
          required: ['task_id']
        }
      }
    },
    {
      pluginId,
      type: 'function',
      function: {
        name: 'agent_teams_send_message',
        description: 'Record a durable direct message between AgentTeams compatibility members.',
        parameters: {
          type: 'object',
          properties: {
            team_id: { type: 'string' },
            from: { type: 'string' },
            to: { type: 'string' },
            content: { type: 'string' }
          },
          required: ['to', 'content']
        }
      }
    },
    {
      pluginId,
      type: 'function',
      function: {
        name: 'agent_teams_view',
        description: 'View the active AgentTeams compatibility roster, task board, and mailbox for this Tasi session.',
        parameters: {
          type: 'object',
          properties: {
            team_id: { type: 'string' }
          }
        }
      }
    }
  ];
}

function dshImToolDefinitions(pluginId: string): RuntimeTool[] {
  return [
    {
      pluginId,
      type: 'function',
      function: {
        name: 'dsh_im_status',
        description: 'Inspect the installed dsh-im compatibility bridge status and explain what IM configuration is still required before external messages can enter Tasi.',
        parameters: {
          type: 'object',
          properties: {}
        }
      }
    }
  ];
}

function cleanTeamId(value: string): string {
  return cleanSegment(value || 'default-team');
}

function teamFile(workspaceDir: string, sessionId: string, teamId?: string): string {
  const id = cleanTeamId(teamId || sessionId || 'manual');
  return resolve(workspaceDir, '.agent-teams', `${id}.json`);
}

function defaultTeam(context: DshSidecarToolCallRequest['context'], goal = '', teamId?: string): AgentTeamState {
  const now = nowIso();
  return {
    teamId: cleanTeamId(teamId || context.sessionId || 'manual'),
    sessionId: context.sessionId,
    goal,
    createdAt: now,
    updatedAt: now,
    members: [],
    tasks: [],
    messages: []
  };
}

function loadTeam(context: DshSidecarToolCallRequest['context'], args: JsonObject = {}): AgentTeamState {
  const explicit = stringValue(args.team_id);
  const file = teamFile(context.workspaceDir, context.sessionId, explicit);
  return readJsonFile<AgentTeamState>(file, defaultTeam(context, '', explicit));
}

function saveTeam(context: DshSidecarToolCallRequest['context'], team: AgentTeamState): AgentTeamState {
  const next = { ...team, updatedAt: nowIso() };
  writeJsonFile(teamFile(context.workspaceDir, context.sessionId, next.teamId), next);
  return next;
}

function taskId(nextIndex: number): string {
  return `task-${String(nextIndex).padStart(3, '0')}`;
}

function messageId(nextIndex: number): string {
  return `msg-${String(nextIndex).padStart(3, '0')}`;
}

function summarizeTeam(team: AgentTeamState): string {
  return [
    `AgentTeams team ${team.teamId}`,
    `Goal: ${team.goal || '(not set)'}`,
    `Members: ${team.members.map((member) => `${member.name}${member.role ? ` (${member.role})` : ''}`).join(', ') || '(none)'}`,
    `Tasks: ${team.tasks.map((task) => `${task.id} [${task.status}] ${task.title}${task.assignee ? ` -> ${task.assignee}` : ''}`).join('; ') || '(none)'}`,
    `Messages: ${team.messages.length}`
  ].join('\n');
}

function executeAgentTeamsTool(name: string, args: JsonObject, context: DshSidecarToolCallRequest['context']): ToolExecutionResult {
  if (name === 'agent_teams_create') {
    let team = defaultTeam(context, stringValue(args.goal), stringValue(args.team_id));
    const now = nowIso();
    const members = Array.isArray(args.members) ? args.members.map((item): AgentTeamMember | undefined => {
      const obj = objectValue(item);
      const memberName = stringValue(obj.name).trim();
      if (!memberName) return undefined;
      return {
        name: memberName,
        role: stringValue(obj.role) || undefined,
        prompt: stringValue(obj.prompt) || undefined,
        provider: stringValue(obj.provider) || undefined,
        model: stringValue(obj.model) || undefined,
        reasoning_effort: stringValue(obj.reasoning_effort) || undefined,
        createdAt: now
      };
    }).filter((item): item is AgentTeamMember => Boolean(item)) : [];
    const tasks = Array.isArray(args.tasks) ? args.tasks.map((item, index): AgentTeamTask | undefined => {
      const obj = objectValue(item);
      const title = stringValue(obj.title).trim();
      if (!title) return undefined;
      return {
        id: taskId(index + 1),
        title,
        description: stringValue(obj.description) || undefined,
        assignee: stringValue(obj.assignee) || undefined,
        status: 'pending',
        blockers: stringArray(obj.blockers),
        notes: [],
        createdAt: now,
        updatedAt: now
      };
    }).filter((item): item is AgentTeamTask => Boolean(item)) : [];
    team = { ...team, members, tasks };
    const saved = saveTeam(context, team);
    return { ok: true, content: summarizeTeam(saved), data: saved };
  }
  if (name === 'agent_teams_add_member') {
    const memberName = stringValue(args.name).trim();
    if (!memberName) return { ok: false, content: 'agent_teams_add_member requires name.' };
    const team = loadTeam(context, args);
    const member: AgentTeamMember = {
      name: memberName,
      role: stringValue(args.role) || undefined,
      prompt: stringValue(args.prompt) || undefined,
      provider: stringValue(args.provider) || undefined,
      model: stringValue(args.model) || undefined,
      reasoning_effort: stringValue(args.reasoning_effort) || undefined,
      createdAt: team.members.find((item) => item.name === memberName)?.createdAt ?? nowIso()
    };
    const members = [...team.members.filter((item) => item.name !== memberName), member];
    const saved = saveTeam(context, { ...team, members });
    return { ok: true, content: summarizeTeam(saved), data: saved };
  }
  if (name === 'agent_teams_create_task') {
    const title = stringValue(args.title).trim();
    if (!title) return { ok: false, content: 'agent_teams_create_task requires title.' };
    const team = loadTeam(context, args);
    const now = nowIso();
    const task: AgentTeamTask = {
      id: taskId(team.tasks.length + 1),
      title,
      description: stringValue(args.description) || undefined,
      assignee: stringValue(args.assignee) || undefined,
      status: 'pending',
      blockers: stringArray(args.blockers),
      notes: [],
      createdAt: now,
      updatedAt: now
    };
    const saved = saveTeam(context, { ...team, tasks: [...team.tasks, task] });
    return { ok: true, content: summarizeTeam(saved), data: saved };
  }
  if (name === 'agent_teams_update_task') {
    const id = stringValue(args.task_id).trim();
    if (!id) return { ok: false, content: 'agent_teams_update_task requires task_id.' };
    const team = loadTeam(context, args);
    let found = false;
    const tasks = team.tasks.map((task) => {
      if (task.id !== id) return task;
      found = true;
      const note = stringValue(args.note).trim();
      return {
        ...task,
        status: ['pending', 'in_progress', 'blocked', 'done', 'failed'].includes(stringValue(args.status))
          ? stringValue(args.status) as AgentTeamTask['status']
          : task.status,
        assignee: stringValue(args.assignee) || task.assignee,
        notes: note ? [...task.notes, note] : task.notes,
        updatedAt: nowIso()
      };
    });
    if (!found) return { ok: false, content: `Unknown AgentTeams task: ${id}` };
    const saved = saveTeam(context, { ...team, tasks });
    return { ok: true, content: summarizeTeam(saved), data: saved };
  }
  if (name === 'agent_teams_send_message') {
    const to = stringValue(args.to).trim();
    const content = stringValue(args.content).trim();
    if (!to || !content) return { ok: false, content: 'agent_teams_send_message requires to and content.' };
    const team = loadTeam(context, args);
    const message: AgentTeamMessage = {
      id: messageId(team.messages.length + 1),
      from: stringValue(args.from, 'captain') || 'captain',
      to,
      content,
      createdAt: nowIso()
    };
    const saved = saveTeam(context, { ...team, messages: [...team.messages, message] });
    return { ok: true, content: `Queued AgentTeams message ${message.id} from ${message.from} to ${message.to}.\n${summarizeTeam(saved)}`, data: saved };
  }
  if (name === 'agent_teams_view') {
    const team = loadTeam(context, args);
    return { ok: true, content: summarizeTeam(team), data: team };
  }
  return { ok: false, content: `Unsupported AgentTeams compatibility tool: ${name}` };
}

async function executeDshImTool(name: string): Promise<ToolExecutionResult> {
  if (name !== 'dsh_im_status') return { ok: false, content: `Unsupported dsh-im compatibility tool: ${name}` };
  const record = store.get('xmanrui-dsh-im') ?? store.list().find((item) => item.packageName === '@xmanrui/dsh-im');
  if (!record) return { ok: false, content: '@xmanrui/dsh-im is not installed in the DSH sidecar profile.' };
  const host = await getCordisHost();
  const plugin = runtimePluginRecord(record, host);
  return {
    ok: true,
    content: [
      '@xmanrui/dsh-im is installed and enabled in the DSH sidecar profile.',
      'Tasi now attempts to load the real Cordis plugin host first. External IM channel plugins can invoke main.chat.run through the sidecar bridge; Tasi queues runs, isolates sessions, and returns the final result.',
      `Runtime status: ${plugin.status}${plugin.lastError ? ` (${plugin.lastError})` : ''}`
    ].join('\n'),
    data: plugin
  };
}

async function callRuntimeTool(params: DshSidecarToolCallRequest): Promise<ToolExecutionResult> {
  const name = params.name.trim();
  const args = objectValue(params.args);
  const host = await getCordisHost();
  const cordisResult = await host.callTool(params);
  if (cordisResult) return cordisResult;
  const tools = await runtimeToolDefinitions();
  if (!tools.some((tool) => tool.function.name === name)) return { ok: false, content: `Unknown or disabled DSH runtime tool: ${name}` };
  if (name.startsWith('agent_teams_')) return executeAgentTeamsTool(name, args, params.context);
  if (name.startsWith('dsh_im_')) return await executeDshImTool(name);
  return { ok: false, content: `DSH runtime tool has no Tasi bridge implementation: ${name}` };
}

async function runSidecarChat(params: DshSidecarChatRunRequest): Promise<DshSidecarChatRunResult> {
  const host = await getCordisHost();
  return await host.runChat({
    ...params,
    pluginRef: params.pluginRef.trim().replace(/^@/, '')
  });
}

function readAction(params: unknown): DshSidecarPluginActionRequest {
  const record = params && typeof params === 'object' ? params as Partial<DshSidecarPluginActionRequest> : {};
  if (!record.id?.trim() && !record.packageName?.trim() && !record.source?.trim()) {
    throw new Error('Plugin id, packageName, or source is required.');
  }
  return {
    id: record.id?.trim() || '',
    packageName: record.packageName?.trim(),
    source: record.source?.trim(),
    profileName: record.profileName
  };
}

async function repairInstalledRecord(record: DshSidecarPluginRecord): Promise<DshSidecarPluginRecord> {
  const profile = ensureProfile(record.profileName);
  let installedPackageName = dshFindInstalledPackage(profile, record.packageName, record.source);
  if (!installedPackageName) {
    const install = await addPackageWithFallback(profile, record.source || record.packageName, record.packageName);
    if (install.result.code !== 0) {
      return failedPluginRecord(
        record,
        compactError(install.result.stderr || install.result.stdout || `pnpm add failed with code ${install.result.code}`)
      );
    }
    installedPackageName = dshFindInstalledPackage(profile, record.packageName, install.source);
    if (!installedPackageName) {
      return failedPluginRecord(record, `Installed package is not resolvable from profile node_modules: ${record.packageName}`);
    }
    record = { ...record, source: install.source };
  }
  const prepareWarnings = await prepareInstalledPlugin(profile, installedPackageName);
  const manifest = readInstalledManifest(profile, installedPackageName);
  if (!manifest.dshBundlePatch) {
    return {
      ...record,
      id: pluginIdFromPackage(installedPackageName),
      packageName: installedPackageName,
      version: manifest.version ?? record.version,
      status: 'incompatible',
      lastError: ['Installed package does not declare dsh.bundle.patch.', ...prepareWarnings].join('\n'),
      updatedAt: nowIso()
    };
  }
  return {
    ...record,
    id: pluginIdFromPackage(installedPackageName),
    packageName: installedPackageName,
    version: manifest.version ?? record.version,
    status: record.enabled ? 'enabled' : 'installed',
    dshBundlePatch: manifest.dshBundlePatch,
    lastError: prepareWarnings.join('\n') || undefined,
    updatedAt: nowIso()
  };
}

async function setEnabled(params: unknown, enabled: boolean): Promise<DshSidecarPluginRecord> {
  const req = readAction(params);
  let record = store.find(req);
  if (!record) throw new Error(`Unknown DSH plugin: ${req.id || req.packageName || req.source}`);
  const originalRecord = record;
  if (enabled || record.status === 'incompatible' || !resolvePackageRoot(ensureProfile(record.profileName), record.packageName)) {
    record = await repairInstalledRecord(record);
    if (record.id !== originalRecord.id) store.remove(originalRecord.id);
    store.upsert(record);
  }
  if (record.status === 'failed') throw new Error(record.lastError || `DSH plugin failed to install: ${req.id}`);
  if (record.status === 'incompatible') throw new Error(record.lastError || `DSH plugin is incompatible: ${req.id}`);
  const next: DshSidecarPluginRecord = {
    ...record,
    enabled,
    status: enabled ? 'enabled' : 'disabled',
    updatedAt: nowIso(),
    lastError: enabled ? undefined : record.lastError
  };
  store.upsert(next);
  return next;
}

async function uninstallPlugin(params: unknown): Promise<boolean> {
  const req = readAction(params);
  const record = store.find(req);
  if (!record) return false;
  const profile = ensureProfile(req.profileName || record.profileName);
  const dependencyKey = dependencyKeyForRecord(profile, record);
  if (!dependencyKey) {
    return store.removeBy({
      id: record.id,
      packageName: record.packageName,
      source: record.source
    });
  }
  const result = await runCommand(packageManagerBinary(), ['remove', dependencyKey], profile);
  if (result.code !== 0 && existsSync(join(profile, 'package.json'))) {
    const failed: DshSidecarPluginRecord = {
      ...record,
      status: 'failed',
      enabled: false,
      updatedAt: nowIso(),
      lastError: compactError(result.stderr || result.stdout || `pnpm remove ${dependencyKey} failed with code ${result.code}`)
    };
    store.upsert(failed);
    return false;
  }
  return store.removeBy({
    id: record.id,
    packageName: record.packageName,
    source: record.source
  });
}

async function dispatch(method: string, params: unknown): Promise<unknown> {
  if (method === 'status') return status((params as { profileName?: string } | undefined)?.profileName);
  if (method === 'plugin.list') return store.list();
  if (method === 'plugin.install') return await installPlugin(params as DshSidecarPluginInstallRequest);
  if (method === 'plugin.upload') return await uploadPlugin(params as DshSidecarPluginUploadRequest);
  if (method === 'plugin.enable') return setEnabled(params, true);
  if (method === 'plugin.disable') return setEnabled(params, false);
  if (method === 'plugin.uninstall') return await uninstallPlugin(params);
  if (method === 'runtime.status') return await runtimeStatus((params as { profileName?: string } | undefined)?.profileName);
  if (method === 'runtime.tools') return (await runtimeStatus((params as { profileName?: string } | undefined)?.profileName)).tools;
  if (method === 'runtime.skills') return await runtimeSkillDocuments();
  if (method === 'client.mounts') return (await runtimeStatus((params as { profileName?: string } | undefined)?.profileName)).clientMounts ?? [];
  if (method === 'runtime.tool.call') return await callRuntimeTool(params as DshSidecarToolCallRequest);
  if (method === 'chat.run') return await runSidecarChat(params as DshSidecarChatRunRequest);
  if (method === 'shutdown') {
    clientServer?.close();
    clientServer = undefined;
    clientBaseUrl = '';
    queueMicrotask(() => process.exit(0));
    return { ok: true };
  }
  throw new Error(`Unknown DSH sidecar method: ${method}`);
}

function send(id: string, payload: { result?: unknown; error?: { message: string } }): void {
  process.stdout.write(JSON.stringify({ id, ...payload }) + '\n');
}

const rl = createInterface({ input: process.stdin });
rl.on('line', async (line) => {
  let req: RpcRequest;
  try {
    const parsed = JSON.parse(line) as unknown;
    if (handleParentResponse(parsed)) return;
    req = parsed as RpcRequest;
  } catch {
    return;
  }
  try {
    send(req.id, { result: await dispatch(req.method, req.params) });
  } catch (error) {
    send(req.id, { error: { message: error instanceof Error ? error.message : String(error) } });
  }
});

process.on('uncaughtException', (error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
});
