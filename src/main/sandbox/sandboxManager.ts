import { cpSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentExecutionDetails, ExecutionMode } from '../../shared/types.js';
import { ensureDir } from '../storage/pathUtils.js';

export class SandboxManager {
  private readonly root: string;

  constructor(harnessHome: string) {
    this.root = ensureDir(join(harnessHome, 'sandboxes'));
  }

  prepare(mode: ExecutionMode, sourceWorkspaceDir: string, runId: string): AgentExecutionDetails {
    if (mode !== 'sandbox') {
      return {
        mode: 'workspace',
        workspaceDir: sourceWorkspaceDir
      };
    }

    const sandboxId = `sandbox-${runId}`;
    const sandboxDir = ensureDir(join(this.root, sandboxId));
    if (existsSync(sourceWorkspaceDir)) {
      cpSync(sourceWorkspaceDir, sandboxDir, {
        recursive: true,
        force: true
      });
    }

    return {
      mode: 'sandbox',
      workspaceDir: sandboxDir,
      sandboxId
    };
  }
}
