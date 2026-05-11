#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { clearScreenDown, moveCursor } from 'node:readline';
import { createInterface, type Interface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { fileURLToPath } from 'node:url';
import { marked } from 'marked';
import { markedTerminal } from 'marked-terminal';
import type { ExecutionMode, ToolApprovalDecision, ToolApprovalRequest } from '../shared/types.js';
import { CliContext } from './cliContext.js';

marked.use(
  markedTerminal({
    showSectionPrefix: false
  })
);

export interface CliOptions {
  command: 'chat' | 'sessions' | 'help' | 'version';
  message: string;
  sessionId?: string;
  executionMode?: ExecutionMode;
  usePersonalKnowledgeBase: boolean;
  json: boolean;
  plain: boolean;
  verbose: boolean;
  stream: boolean;
  home?: string;
}

function printUsage(): void {
  output.write(
    [
      'Tasi Harness CLI',
      '',
      'Usage:',
      '  tasi chat "summarize the workspace"',
      '  tasi chat --session xxx "continue this session"',
      '  tasi chat -s xxx -e sandbox',
      '  tasi sessions',
      '',
      'Options:',
      '  -s, --session <id>       Continue an existing session.',
      '  -e, --execution <mode>   workspace or sandbox.',
      '  -k, --knowledge          Use the personal knowledge base.',
      '  -j, --json               Print the run result as JSON.',
      '  -p, --plain              Print raw Markdown instead of terminal-rendered output.',
      '      --stream             Stream raw output first, then render Markdown when complete (default).',
      '      --no-stream          Wait for the full response, then render it.',
      '  -V, --verbose            Print tool events to stderr.',
      '  -H, --home <path>        Override TASI_HARNESS_HOME.',
      '  -h, --help               Show this help.',
      '  -v, --version            Show package version.',
      '',
      'Interactive commands:',
      '  :exit                    Quit.',
      '  :new                     Start a new session.',
      '  :session <id>            Continue a session id.',
      ''
    ].join('\n')
  );
}

function packageVersion(): string {
  try {
    const pkgUrl = new URL('../../package.json', import.meta.url);
    const pkg = JSON.parse(readFileSync(pkgUrl, 'utf8')) as { version?: string };
    return pkg.version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

function normalizeExecutionMode(value: string): ExecutionMode {
  if (value === 'sandbox' || value === 'workspace') return value;
  throw new Error(`Invalid execution mode: ${value}. Expected workspace or sandbox.`);
}

export function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    command: 'chat',
    message: '',
    usePersonalKnowledgeBase: false,
    json: false,
    plain: false,
    verbose: false,
    stream: true
  };
  const rest: string[] = [];
  const args = [...argv];
  const first = args[0];
  if (first === 'chat' || first === 'sessions' || first === 'help' || first === 'version') {
    options.command = first;
    args.shift();
  }
  if (first === '--help' || first === '-h') options.command = 'help';
  if (first === '--version' || first === '-v') options.command = 'version';

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--help' || arg === '-h') {
      options.command = 'help';
      continue;
    }
    if (arg === '--version' || arg === '-v') {
      options.command = 'version';
      continue;
    }
    if (arg === '--session' || arg === '-s') {
      options.sessionId = args[++index];
      if (!options.sessionId) throw new Error(`${arg} requires a session id.`);
      continue;
    }
    if (arg === '--execution' || arg === '-e') {
      const value = args[++index];
      if (!value) throw new Error(`${arg} requires workspace or sandbox.`);
      options.executionMode = normalizeExecutionMode(value);
      continue;
    }
    if (arg === '--knowledge' || arg === '-k') {
      options.usePersonalKnowledgeBase = true;
      continue;
    }
    if (arg === '--json' || arg === '-j') {
      options.json = true;
      continue;
    }
    if (arg === '--plain' || arg === '-p') {
      options.plain = true;
      continue;
    }
    if (arg === '--stream') {
      options.stream = true;
      continue;
    }
    if (arg === '--no-stream') {
      options.stream = false;
      continue;
    }
    if (arg === '--verbose' || arg === '-V') {
      options.verbose = true;
      continue;
    }
    if (arg === '--home' || arg === '-H') {
      options.home = args[++index];
      if (!options.home) throw new Error(`${arg} requires a path.`);
      continue;
    }
    if (arg.startsWith('-')) throw new Error(`Unknown option: ${arg}`);
    rest.push(arg);
  }
  options.message = rest.join(' ').trim();
  return options;
}

async function readPipedInput(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return Buffer.concat(chunks).toString('utf8').trim();
}

function rememberApproval(context: CliContext, key: string): void {
  const cfg = context.configStore.get();
  if (cfg.safetyApproval.neverAskAgainKeys.includes(key)) return;
  context.configStore.update({
    safetyApproval: {
      ...cfg.safetyApproval,
      neverAskAgainKeys: [...cfg.safetyApproval.neverAskAgainKeys, key]
    }
  });
}

async function requestApproval(context: CliContext, rl: Interface, request: ToolApprovalRequest): Promise<ToolApprovalDecision> {
  if (!process.stdin.isTTY) return { id: request.id, approved: false };
  process.stderr.write(
    [
      '',
      `Tool approval required: ${request.toolName}`,
      request.summary,
      `Workspace: ${request.workspaceDir}`,
      ''
    ].join('\n')
  );
  const answer = (await rl.question('Approve this action? [y/N/a=approve and remember] ')).trim().toLowerCase();
  const approved = answer === 'y' || answer === 'yes' || answer === 'a';
  const neverAskAgain = approved && answer === 'a';
  if (neverAskAgain) rememberApproval(context, request.key);
  return { id: request.id, approved, neverAskAgain };
}

function normalizeMarkdownForTerminal(markdown: string): string {
  const lines = markdown.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  let fenced = false;
  return lines
    .map((line) => {
      if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
      if (fenced) return line;
      return line.replace(/^ {4,}([*+-]\s+)/, '$1').replace(/^ {4,}(\d+[.)]\s+)/, '$1');
    })
    .join('\n');
}

function applyTerminalStrongFallback(markdown: string): string {
  const boldStart = process.stdout.isTTY ? '\u001b[1m' : '';
  const boldEnd = process.stdout.isTTY ? '\u001b[22m' : '';
  const lines = markdown.split('\n');
  let fenced = false;
  return lines
    .map((line) => {
      if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
      if (fenced) return line;
      return line.replace(/\*\*([^*\n]+)\*\*/g, `${boldStart}$1${boldEnd}`);
    })
    .join('\n');
}

export function renderMarkdownForTerminal(markdown: string): string {
  const normalized = applyTerminalStrongFallback(normalizeMarkdownForTerminal(markdown.trim()));
  const rendered = marked.parse(normalized, { async: false });
  return typeof rendered === 'string' ? rendered : normalized;
}

function visibleCharWidth(char: string): number {
  if (/[\u0000-\u001f\u007f-\u009f]/.test(char)) return 0;
  if (/[\u1100-\u115f\u2329\u232a\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe10-\ufe19\ufe30-\ufe6f\uff00-\uff60\uffe0-\uffe6]/.test(char)) return 2;
  return 1;
}

class StreamedTerminalRegion {
  private rowsBelowStart = 0;
  private column = 0;
  private wrote = false;
  private readonly columns = Math.max(1, output.columns || 80);

  write(delta: string): void {
    if (!output.isTTY) return;
    this.wrote = true;
    for (const char of delta) {
      if (char === '\r') {
        this.column = 0;
        continue;
      }
      if (char === '\n') {
        this.rowsBelowStart += 1;
        this.column = 0;
        continue;
      }
      if (char === '\t') {
        this.advance(8 - (this.column % 8));
        continue;
      }
      this.advance(visibleCharWidth(char));
    }
  }

  clear(): boolean {
    if (!output.isTTY || !this.wrote) return false;
    output.write('\r');
    if (this.rowsBelowStart > 0) moveCursor(output, 0, -this.rowsBelowStart);
    clearScreenDown(output);
    return true;
  }

  private advance(width: number): void {
    if (width <= 0) return;
    if (this.column + width > this.columns) {
      this.rowsBelowStart += 1;
      this.column = width;
      return;
    }
    this.column += width;
    if (this.column > this.columns) {
      this.rowsBelowStart += 1;
      this.column %= this.columns;
    }
  }
}

function printResult(result: Awaited<ReturnType<CliContext['runChat']>>, options: Pick<CliOptions, 'json' | 'plain'>, alreadyStreamed = false): void {
  const json = options.json;
  if (json) {
    output.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  if (alreadyStreamed) {
    output.write(`\n[session: ${result.sessionId}]\n`);
    return;
  }
  const response = result.finalResponse.trim();
  output.write(`${options.plain ? response : renderMarkdownForTerminal(response).trim()}\n`);
  output.write(`\n[session: ${result.sessionId}]\n`);
}

async function runSingleMessage(context: CliContext, options: CliOptions, rl: Interface, message: string): Promise<string> {
  const controller = new AbortController();
  const onSigint = () => controller.abort();
  process.once('SIGINT', onSigint);
  let streamedContent = '';
  const streamedRegion = new StreamedTerminalRegion();
  try {
    const result = await context.runChat(
      {
        userInput: message,
        sessionId: options.sessionId,
        executionMode: options.executionMode,
        usePersonalKnowledgeBase: options.usePersonalKnowledgeBase,
        stream: options.stream
      },
      {
        signal: controller.signal,
        requestToolApproval: (request) => requestApproval(context, rl, request),
        browserLogEnabled: options.verbose,
        onToolEvent: options.verbose
          ? (_sessionId, event) => {
              process.stderr.write(`[tool:${event.toolName}] ${event.ok ? 'ok' : 'fail'} ${event.content.slice(0, 160).replace(/\s+/g, ' ')}\n`);
            }
          : undefined,
        onMessageDelta: options.stream && !options.json
          ? (_sessionId, event) => {
              if (event.type === 'content' && event.delta) {
                streamedContent += event.delta;
                streamedRegion.write(event.delta);
                output.write(event.delta);
              }
            }
          : undefined
      }
    );
    const shouldReplaceStream = options.stream && !options.json && !options.plain && streamedContent.length > 0;
    const replacedStream = shouldReplaceStream ? streamedRegion.clear() : false;
    const alreadyStreamed = options.stream && !options.json && streamedContent.length > 0 && (options.plain || !replacedStream);
    printResult(result, options, alreadyStreamed);
    return result.sessionId;
  } finally {
    process.removeListener('SIGINT', onSigint);
  }
}

async function runInteractive(context: CliContext, options: CliOptions, rl: Interface): Promise<void> {
  let sessionId = options.sessionId;
  output.write('Tasi Harness CLI. Type :exit to quit.\n');
  output.write(sessionId ? `[session: ${sessionId}]\n` : '[new session]\n');
  while (true) {
    const promptSession = sessionId ? sessionId : 'new';
    const message = (await rl.question(`You (${promptSession}) > `)).trim();
    if (!message) continue;
    if (message === ':exit' || message === ':quit') return;
    if (message === ':new') {
      sessionId = undefined;
      output.write('[new session]\n');
      continue;
    }
    if (message.startsWith(':session ')) {
      sessionId = message.slice(':session '.length).trim() || undefined;
      output.write(sessionId ? `[session: ${sessionId}]\n` : '[new session]\n');
      continue;
    }
    const nextSessionId = await runSingleMessage(context, { ...options, sessionId, json: false }, rl, message);
    sessionId = nextSessionId;
  }
}

async function main(): Promise<number> {
  const options = parseArgs(process.argv.slice(2));
  if (options.command === 'help') {
    printUsage();
    return 0;
  }
  if (options.command === 'version') {
    output.write(`${packageVersion()}\n`);
    return 0;
  }
  if (options.home) process.env.TASI_HARNESS_HOME = options.home;
  const context = new CliContext(options.home);
  try {
    if (options.command === 'sessions') {
      const sessions = context.sessionStore.list();
      if (options.json) output.write(`${JSON.stringify(sessions, null, 2)}\n`);
      else {
        for (const item of sessions) {
          output.write(`${item.id}\t${item.updatedAt}\t${item.title}\n`);
        }
      }
      return 0;
    }

    let message = options.message;
    if (!message && !process.stdin.isTTY) message = await readPipedInput();
    const rl = createInterface({ input, output });
    try {
      if (message) {
        await runSingleMessage(context, options, rl, message);
        return 0;
      }
      await runInteractive(context, options, rl);
      return 0;
    } finally {
      rl.close();
    }
  } finally {
    await context.close({ browserLogEnabled: options.verbose });
  }
}

function isMainModule(): boolean {
  if (process.env.TASI_CLI_FORCE_MAIN === '1') return true;
  const entry = process.argv[1];
  if (!entry) return false;
  return resolve(entry) === fileURLToPath(import.meta.url);
}

if (isMainModule()) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    }
  );
}
