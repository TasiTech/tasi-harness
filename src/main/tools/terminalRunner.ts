import { spawn } from 'node:child_process';
import type { ToolExecutionResult } from '../../shared/types.js';

const DANGEROUS_PATTERNS = [
  /rm\s+-rf\s+\//i,
  /:\(\)\s*\{\s*:\|:\s*&\s*\}/,
  /mkfs\./i,
  /dd\s+if=.*of=\/dev\//i,
  /shutdown\b/i,
  /reboot\b/i,
  /poweroff\b/i,
  /diskpart\b/i,
  /format\s+[a-z]:/i
];

const RISKY_PATTERNS = [
  /\brm\b/i,
  /\bdel(?:ete)?\b/i,
  /\berase\b/i,
  /\brmdir\b/i,
  /\bRemove-Item\b/i,
  /\bmv\b|\bmove\b|\bMove-Item\b/i,
  /\bcp\b|\bcopy\b|\bCopy-Item\b/i,
  /\bSet-Content\b|\bAdd-Content\b|\bOut-File\b|>>|>/i,
  /\bchmod\b|\bchown\b|\bicacls\b/i,
  /\bsudo\b|\brunas\b/i,
  /\breg(?:\.exe)?\b|\bSet-ItemProperty\b|\bNew-ItemProperty\b/i,
  /\bgit\s+(?:clean|reset)\b/i,
  /\b(?:npm|pnpm|yarn|pip|uv|cargo|gem|go)\s+(?:install|add|remove|uninstall)\b/i
];

export interface TerminalCommandSafety {
  blocked: boolean;
  requiresApproval: boolean;
  reason: string;
}

export function classifyTerminalCommandSafety(command: string): TerminalCommandSafety {
  const trimmed = command.trim();
  if (!trimmed) return { blocked: false, requiresApproval: false, reason: 'empty' };
  if (DANGEROUS_PATTERNS.some((pattern) => pattern.test(trimmed))) {
    return { blocked: true, requiresApproval: false, reason: 'Blocked dangerous command pattern.' };
  }
  if (RISKY_PATTERNS.some((pattern) => pattern.test(trimmed))) {
    return { blocked: false, requiresApproval: true, reason: 'Command may modify files, permissions, packages, or system settings.' };
  }
  return { blocked: false, requiresApproval: false, reason: 'Command appears read-only or low-risk.' };
}

export interface TerminalRunOptions {
  command: string;
  cwd: string;
  timeoutMs?: number;
  allowShellTools: boolean;
}

export async function runTerminalCommand(options: TerminalRunOptions): Promise<ToolExecutionResult> {
  const command = options.command.trim();
  if (!command) return { ok: false, content: 'Command cannot be empty.' };
  if (!options.allowShellTools) {
    return {
      ok: false,
      content: 'Terminal tool is disabled. Enable allowShellTools in Settings before running shell commands.'
    };
  }
  if (classifyTerminalCommandSafety(command).blocked) {
    return { ok: false, content: 'Blocked dangerous command pattern.' };
  }

  return new Promise((resolve) => {
    const child = spawn(command, {
      cwd: options.cwd,
      shell: true,
      env: { ...process.env, TASI_HARNESS: '1' }
    });
    const chunks: Buffer[] = [];
    const errors: Buffer[] = [];
    const timeout = setTimeout(() => {
      child.kill('SIGTERM');
      resolve({ ok: false, content: `Command timed out after ${options.timeoutMs ?? 120000} ms.` });
    }, options.timeoutMs ?? 120000);

    child.stdout.on('data', (data) => chunks.push(Buffer.from(data)));
    child.stderr.on('data', (data) => errors.push(Buffer.from(data)));
    child.on('error', (error) => {
      clearTimeout(timeout);
      resolve({ ok: false, content: error.message });
    });
    child.on('close', (code) => {
      clearTimeout(timeout);
      const stdout = Buffer.concat(chunks).toString('utf8').trim();
      const stderr = Buffer.concat(errors).toString('utf8').trim();
      const content = [`exit=${code}`, stdout && `stdout:\n${stdout}`, stderr && `stderr:\n${stderr}`].filter(Boolean).join('\n\n');
      resolve({ ok: code === 0, content: content || `exit=${code}` });
    });
  });
}
