import { existsSync, statSync } from 'node:fs';
import { basename, extname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AgentArtifactRef, ArtifactPathRequest } from '../shared/types.js';
import { classifyArtifactKind, decodeArtifactPathText, isArtifactExtension } from '../shared/artifacts.js';
import { isPathInside } from './tools/toolRegistry.js';

export interface ArtifactResolutionSession {
  id: string;
  workspaceDir?: string;
  updatedAt?: string;
  artifacts?: AgentArtifactRef[];
}

export interface ArtifactResolutionOptions {
  workspaceDir: string;
  harnessHome: string;
  sessions?: ArtifactResolutionSession[];
}

export function allowedArtifactRoots(options: Pick<ArtifactResolutionOptions, 'workspaceDir' | 'harnessHome'>): string[] {
  return [
    options.workspaceDir,
    join(options.harnessHome, 'workspace'),
    join(options.harnessHome, 'sandboxes'),
    join(options.harnessHome, 'artifacts'),
    join(options.harnessHome, 'dsh-sidecar'),
    join(options.harnessHome, 'im-artifacts')
  ].map((root) => resolve(root));
}

export function normalizeArtifactRequestPath(raw: string): string {
  const trimmed = raw.trim();
  if (/^file:/i.test(trimmed)) {
    try {
      return fileURLToPath(trimmed);
    } catch {
      return decodeArtifactPathText(trimmed);
    }
  }
  return decodeArtifactPathText(trimmed);
}

function normalizeArtifactLookupValue(value: string): string {
  return normalizeArtifactRequestPath(value)
    .trim()
    .replace(/^['"`<(\[]+/, '')
    .replace(/['"`>)\].,;:，。；：]+$/, '')
    .toLocaleLowerCase();
}

function artifactFileName(value: string): string {
  return normalizeArtifactLookupValue(value).split(/[\\/]/).filter(Boolean).at(-1) ?? '';
}

function artifactMatchesRequest(artifact: AgentArtifactRef, normalizedRaw: string): boolean {
  const requestValue = normalizeArtifactLookupValue(normalizedRaw);
  const requestName = artifactFileName(normalizedRaw);
  if (!requestValue) return false;
  return [artifact.name, artifact.path, artifact.absPath].filter((value): value is string => Boolean(value)).some((value) => {
    const normalized = normalizeArtifactLookupValue(value);
    return normalized === requestValue || Boolean(requestName && artifactFileName(normalized) === requestName);
  });
}

function addCandidate(candidates: string[], seen: Set<string>, candidate: string): void {
  const resolved = resolve(candidate);
  if (seen.has(resolved)) return;
  seen.add(resolved);
  candidates.push(resolved);
}

function addRelativeCandidate(candidates: string[], seen: Set<string>, root: string | undefined, path: string): void {
  const cleanRoot = root?.trim();
  if (!cleanRoot) return;
  addCandidate(candidates, seen, isAbsolute(path) ? path : resolve(cleanRoot, path));
}

function artifactCandidatePaths(req: ArtifactPathRequest, normalizedRaw: string, options: ArtifactResolutionOptions): string[] {
  const candidates: string[] = [];
  const seen = new Set<string>();
  if (isAbsolute(normalizedRaw)) {
    addCandidate(candidates, seen, normalizedRaw);
    return candidates;
  }

  const sessions = options.sessions ?? [];
  const matchingSessions = sessions.filter((session) => session.artifacts?.some((artifact) => artifactMatchesRequest(artifact, normalizedRaw)));
  const orderedSessions = [
    ...matchingSessions,
    ...sessions.filter((session) => !matchingSessions.some((matched) => matched.id === session.id))
  ];

  for (const session of matchingSessions) {
    for (const artifact of session.artifacts ?? []) {
      if (!artifactMatchesRequest(artifact, normalizedRaw)) continue;
      if (artifact.absPath) addCandidate(candidates, seen, artifact.absPath);
      addRelativeCandidate(candidates, seen, session.workspaceDir, artifact.path);
    }
  }
  for (const session of orderedSessions) addRelativeCandidate(candidates, seen, session.workspaceDir, normalizedRaw);
  addRelativeCandidate(candidates, seen, options.workspaceDir, normalizedRaw);
  for (const root of allowedArtifactRoots(options)) addRelativeCandidate(candidates, seen, root, normalizedRaw);
  return candidates;
}

function isAllowedArtifactTarget(target: string, normalizedRaw: string, options: ArtifactResolutionOptions): boolean {
  const allowed = allowedArtifactRoots(options).some((root) => isPathInside(root, target));
  const ext = extname(target).toLowerCase();
  const kind = classifyArtifactKind(ext);
  const externalFileAllowed = isAbsolute(normalizedRaw) && isArtifactExtension(ext) && kind !== 'executable';
  return allowed || externalFileAllowed;
}

export function resolveArtifactRequestPath(req: ArtifactPathRequest, options: ArtifactResolutionOptions): string {
  const raw = req.absPath?.trim() || req.path?.trim();
  if (!raw) throw new Error('Artifact path is required.');
  const normalizedRaw = normalizeArtifactRequestPath(raw);
  let hadAllowedCandidate = false;
  for (const target of artifactCandidatePaths(req, normalizedRaw, options)) {
    if (!isAllowedArtifactTarget(target, normalizedRaw, options)) continue;
    hadAllowedCandidate = true;
    if (!existsSync(target)) continue;
    const stat = statSync(target);
    if (!stat.isFile()) throw new Error(`Artifact path is not a file: ${normalizedRaw}`);
    return target;
  }
  if (!hadAllowedCandidate) throw new Error(`Artifact path is outside allowed roots: ${normalizedRaw}`);
  throw new Error(`Artifact file not found: ${basename(normalizedRaw) || normalizedRaw}`);
}
