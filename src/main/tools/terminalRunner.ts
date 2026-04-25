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
  if (DANGEROUS_PATTERNS.some((pattern) => pattern.test(command))) {
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
