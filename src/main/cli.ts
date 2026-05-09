#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createInterface, type Interface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { fileURLToPath } from 'node:url';
import { marked } from 'marked';
import { markedTerminal } from 'marked-terminal';
import type { ExecutionMode, ToolApprovalDecision, ToolApprovalRequest } from '../shared/types.js';
import { CliContext } from './cliContext.js';

marked.use(markedTerminal());

export interface CliOptions {
  command: 'chat' | 'sessions' | 'help' | 'version';
  message: string;
  sessionId?: string;
  executionMode?: ExecutionMode;
  usePersonalKnowledgeBase: boolean;
  json: boolean;
  plain: boolean;
  verbose: boolean;
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
    verbose: false
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

function renderMarkdownForTerminal(markdown: string): string {
  const rendered = marked.parse(markdown.trim(), { async: false });
  return typeof rendered === 'string' ? rendered : markdown.trim();
}

function printResult(result: Awaited<ReturnType<CliContext['runChat']>>, options: Pick<CliOptions, 'json' | 'plain'>): void {
  const json = options.json;
  if (json) {
    output.write(`${JSON.stringify(result, null, 2)}\n`);
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
  try {
    const result = await context.runChat(
      {
        userInput: message,
        sessionId: options.sessionId,
        executionMode: options.executionMode,
        usePersonalKnowledgeBase: options.usePersonalKnowledgeBase
      },
      {
        signal: controller.signal,
        requestToolApproval: (request) => requestApproval(context, rl, request),
        browserLogEnabled: options.verbose,
        onToolEvent: options.verbose
          ? (_sessionId, event) => {
              process.stderr.write(`[tool:${event.toolName}] ${event.ok ? 'ok' : 'fail'} ${event.content.slice(0, 160).replace(/\s+/g, ' ')}\n`);
            }
          : undefined
      }
    );
    printResult(result, options);
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
