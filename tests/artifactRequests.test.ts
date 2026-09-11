import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveArtifactRequestPath } from '../src/main/artifactRequests.js';
import type { AgentArtifactRef } from '../src/shared/types.js';
import { tempHome } from './helpers.js';

let cleanup = () => {};
afterEach(() => cleanup());

function artifact(path: string, absPath: string): AgentArtifactRef {
  return {
    id: 'artifact_test',
    name: path.split(/[\\/]/).at(-1) ?? path,
    path,
    absPath,
    ext: '.md',
    kind: 'markdown',
    previewMode: 'markdown',
    source: 'assistant-link'
  };
}

describe('resolveArtifactRequestPath', () => {
  it('resolves relative artifact paths against the preferred session workspace', () => {
    const env = tempHome();
    cleanup = env.cleanup;
    const configuredWorkspace = join(env.home, 'workspace');
    const sandboxWorkspace = join(env.home, 'sandboxes', 'run-1');
    mkdirSync(configuredWorkspace, { recursive: true });
    mkdirSync(sandboxWorkspace, { recursive: true });
    const target = join(sandboxWorkspace, 'MASTER.md');
    writeFileSync(target, '# Master\n', 'utf8');

    expect(resolveArtifactRequestPath({ path: 'MASTER.md', sessionId: 'session_1' }, {
      workspaceDir: configuredWorkspace,
      harnessHome: env.home,
      sessions: [{ id: 'session_1', workspaceDir: sandboxWorkspace }]
    })).toBe(target);
  });

  it('uses recent artifact metadata when the request only contains a filename', () => {
    const env = tempHome();
    cleanup = env.cleanup;
    const configuredWorkspace = join(env.home, 'workspace');
    const sandboxWorkspace = join(env.home, 'sandboxes', 'run-2');
    const target = join(sandboxWorkspace, 'nested', 'MASTER.md');
    mkdirSync(join(sandboxWorkspace, 'nested'), { recursive: true });
    writeFileSync(target, '# Master\n', 'utf8');

    expect(resolveArtifactRequestPath({ path: 'MASTER.md' }, {
      workspaceDir: configuredWorkspace,
      harnessHome: env.home,
      sessions: [{ id: 'session_2', workspaceDir: sandboxWorkspace, artifacts: [artifact('nested/MASTER.md', target)] }]
    })).toBe(target);
  });
});
