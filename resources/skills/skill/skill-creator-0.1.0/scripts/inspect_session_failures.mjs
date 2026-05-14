#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const args = parseArgs(process.argv.slice(2));
const scriptDir = dirname(fileURLToPath(import.meta.url));
const harnessHome = args['harness-home'] ? resolve(args['harness-home']) : join(homedir(), '.tasi-harness');
const sessionsDir = args['sessions-dir'] ? resolve(args['sessions-dir']) : join(harnessHome, 'sessions');
const repoSkillsDir = args['repo-skills-dir'] ? resolve(args['repo-skills-dir']) : resolve(scriptDir, '..', '..', '..');
const installedSkillsDir = args['skills-dir'] ? resolve(args['skills-dir']) : join(harnessHome, 'skills');
const limit = Number(args.limit ?? 10);

if (args.help || (!args.list && !args.session)) {
  printHelp();
  process.exit(args.help ? 0 : 1);
}

if (args.list) {
  const sessions = listSessions(sessionsDir).slice(0, Number.isFinite(limit) ? limit : 10);
  if (args.json) console.log(JSON.stringify(sessions, null, 2));
  else printSessionList(sessions);
  process.exit(0);
}

const sessionFile = resolveSessionFile(String(args.session), sessionsDir);
const record = readJson(sessionFile);
const installedSkills = parseInstalledSkills(record);
const discoveredSkills = [
  ...discoverSkills(repoSkillsDir, 'repo'),
  ...discoverSkills(installedSkillsDir, 'installed')
];
const skills = mergeSkills([...installedSkills, ...discoveredSkills]);
const report = analyzeSession(record, sessionFile, skills);

if (args.json) console.log(JSON.stringify(report, null, 2));
else printReport(report);

function parseArgs(argv) {
  const parsed = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2);
    if (key === 'list' || key === 'json' || key === 'help') {
      parsed[key] = true;
    } else {
      parsed[key] = argv[i + 1];
      i += 1;
    }
  }
  return parsed;
}

function printHelp() {
  console.log(`Usage:
  node scripts/inspect_session_failures.mjs --list [--limit 20]
  node scripts/inspect_session_failures.mjs --session <session-id|path> [--json]

Options:
  --sessions-dir <dir>      Defaults to ~/.tasi-harness/sessions
  --skills-dir <dir>        Defaults to ~/.tasi-harness/skills
  --repo-skills-dir <dir>   Defaults to ./resources/skills
  --harness-home <dir>      Defaults to ~/.tasi-harness`);
}

function listSessions(dir) {
  if (!existsSync(dir)) throw new Error(`Sessions directory not found: ${dir}`);
  return readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .map((name) => {
      const file = join(dir, name);
      const fallback = statSync(file);
      try {
        const record = readJson(file);
        return {
          id: record.id ?? name.slice(0, -5),
          title: singleLine(record.title ?? ''),
          updatedAt: record.updatedAt ?? fallback.mtime.toISOString(),
          createdAt: record.createdAt ?? fallback.birthtime.toISOString(),
          messageCount: Array.isArray(record.messages) ? record.messages.length : 0,
          domain: record.domain ?? '',
          file
        };
      } catch {
        return {
          id: name.slice(0, -5),
          title: '(unreadable session json)',
          updatedAt: fallback.mtime.toISOString(),
          createdAt: fallback.birthtime.toISOString(),
          messageCount: 0,
          domain: '',
          file
        };
      }
    })
    .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
}

function printSessionList(sessions) {
  console.log('| updatedAt | id | messages | title |');
  console.log('| --- | --- | ---: | --- |');
  for (const session of sessions) {
    console.log(`| ${session.updatedAt} | ${session.id} | ${session.messageCount} | ${escapePipes(session.title).slice(0, 90)} |`);
  }
}

function resolveSessionFile(input, dir) {
  const direct = resolve(input);
  if (existsSync(direct)) return direct;
  const withExt = input.endsWith('.json') ? input : `${input}.json`;
  const candidate = join(dir, withExt.replace(/[\\/]/g, ''));
  if (existsSync(candidate)) return candidate;
  throw new Error(`Session not found: ${input}`);
}

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

function parseInstalledSkills(record) {
  const prompts = Array.isArray(record.systemPromptHistory)
    ? record.systemPromptHistory.map((entry) => String(entry?.prompt ?? ''))
    : [];
  const skills = [];
  const re = /^- ([^\s\[]+).*?\|\s*skill_file=([^|]+?)\s*\|\s*skill_dir=(.+)$/gm;
  for (const prompt of prompts) {
    let match;
    while ((match = re.exec(prompt))) {
      skills.push({
        name: match[1].trim(),
        file: match[2].trim(),
        dir: match[3].trim(),
        source: 'session-index'
      });
    }
  }
  return skills;
}

function discoverSkills(root, source) {
  if (!existsSync(root)) return [];
  const result = [];
  for (const category of safeDirs(root)) {
    for (const skillDir of safeDirs(category.path)) {
      const skillFile = join(skillDir.path, 'SKILL.md');
      if (!existsSync(skillFile)) continue;
      const frontmatter = readFrontmatter(skillFile);
      result.push({
        name: frontmatter.name || skillDir.name,
        description: frontmatter.description || '',
        file: skillFile,
        dir: skillDir.path,
        source
      });
    }
  }
  return result;
}

function safeDirs(root) {
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => ({ name: entry.name, path: join(root, entry.name) }));
  } catch {
    return [];
  }
}

function readFrontmatter(file) {
  const text = readFileSync(file, 'utf8').slice(0, 6000);
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return {};
  const data = {};
  for (const line of match[1].split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (kv) data[kv[1]] = kv[2].trim().replace(/^['"]|['"]$/g, '');
  }
  return data;
}

function mergeSkills(skills) {
  const byName = new Map();
  for (const skill of skills) {
    const key = skill.name.toLowerCase();
    const previous = byName.get(key);
    if (!previous || previous.source === 'session-index') byName.set(key, skill);
  }
  return [...byName.values()];
}

function analyzeSession(record, sessionFile, skills) {
  const messages = Array.isArray(record.messages) ? record.messages : [];
  const intentCorpus = [
    record.title ?? '',
    ...messages
      .filter((message) => message.role === 'user' || message.role === 'assistant')
      .map((message) => `${message.role ?? ''} ${message.content ?? ''}`)
  ].join('\n');
  const failures = detectFailures(messages);
  const evidenceCorpus = [intentCorpus, ...failures.map((failure) => failure.snippet)].join('\n');
  const candidates = rankSkills(skills, evidenceCorpus);
  return {
    session: {
      id: record.id ?? basename(sessionFile, '.json'),
      title: singleLine(record.title ?? ''),
      file: sessionFile,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      messageCount: messages.length
    },
    failureCount: failures.length,
    failures,
    candidateSkills: candidates,
    nextActions: buildNextActions(candidates, failures)
  };
}

function detectFailures(messages) {
  const patterns = [
    { code: 'repeated_skill_patch', re: /"action"\s*:\s*"patch"[\s\S]{0,500}"old_?string"[\s\S]{0,3000}"new_?string"/i },
    { code: 'overbroad_skill_optimization', re: /"action"\s*:\s*"patch"[\s\S]{0,2500}(all skills|every skill|every workflow|global|universal|generic|always|never|所有|全部|全局|通用|一律)[\s\S]{0,2500}(browser|draw\.?io|diagram|docx|pptx|xlsx|chart|travel|office|screenshot)/i },
    { code: 'failure_signal_whitelist', re: /(image_or_diagram_integrity|validator|validation|openability|corrupt|repair|missing|cropped|connector|screenshot|failure|failed|error)[\s\S]{0,1200}(routine signal|not a failure|non-failure|safe to ignore|can be ignored|whitelist|allowlist|白名单|不是失败|忽略)|(routine signal|not a failure|non-failure|safe to ignore|can be ignored|whitelist|allowlist|白名单|不是失败|忽略)[\s\S]{0,1200}(image_or_diagram_integrity|validator|validation|openability|corrupt|repair|missing|cropped|connector|screenshot|failure|failed|error)/i },
    { code: 'skill_responsibility_pollution', re: /"name"\s*:\s*"[^"]*(browser|automation|orchestrat|general|common)[^"]*"[\s\S]{0,2500}(draw\.?io|diagram[- ]export|formal diagram|document figure|docx|pptx|xlsx|office package|word repair|powerpoint|excel)/i },
    { code: 'validator_failed', re: /"ok"\s*:\s*false|\bok\s*:\s*false/i },
    { code: 'tool_exit_nonzero', re: /\bexit\s*=\s*(?!0\b)\d+/i },
    { code: 'exception_or_error', re: /\b(error|exception|traceback|stack trace|fatal|failed|failure|invalid|corrupt|unreadable|broken)\b/i },
    { code: 'dependency_or_command_missing', re: /exit=9009|not recognized|command not found|ENOENT|MODULE_NOT_FOUND|Cannot find module/i },
    { code: 'office_openability', re: /打开有问题|仍然打开|还是打开|无法打开|打开失败|修复|损坏|Word.*repair|PowerPoint.*repair|Excel.*repair/i },
    { code: 'image_or_diagram_integrity', re: /丢失|不完整|截.*不完整|截图|连线|连接线|cropped|missing|screenshot|connector|blank image|near blank/i }
  ];
  const failures = [];
  messages.forEach((message, index) => {
    const toolName = String(message.name ?? '');
    const isReferenceTool = message.role === 'tool' && /^(file_list|file_read|skill_view)$/i.test(toolName);
    if (isReferenceTool) return;
    const content = String(message.content ?? '');
    if (!content.trim()) return;
    const matched = patterns.filter((pattern) => pattern.re.test(content)).map((pattern) => pattern.code);
    const userCorrection = message.role === 'user' && /问题|失败|不行|仍然|还是|丢失|不需要|需要|优化|检查|校验/.test(content);
    if (matched.length === 0 && !userCorrection) return;
    failures.push({
      index,
      role: message.role ?? '',
      tool: message.name ?? '',
      codes: [...new Set(userCorrection ? ['user_correction', ...matched] : matched)],
      snippet: snippet(content)
    });
  });
  return failures.slice(0, 40);
}

function rankSkills(skills, corpus) {
  const lower = corpus.toLowerCase();
  const scored = [];
  for (const skill of skills) {
    const reasons = [];
    let score = 0;
    const name = String(skill.name ?? '');
    const dirName = basename(String(skill.dir ?? '')).toLowerCase();
    if (name && lower.includes(name.toLowerCase())) {
      score += 6;
      reasons.push(`session mentions ${name}`);
    }
    if (dirName && lower.includes(dirName)) {
      score += 4;
      reasons.push(`session mentions ${dirName}`);
    }
    for (const rule of skillRules(name)) {
      if (rule.re.test(corpus)) {
        score += rule.score;
        reasons.push(rule.reason);
      }
    }
    if (score > 0) {
      scored.push({
        name: skill.name,
        score,
        source: skill.source,
        file: skill.file,
        dir: skill.dir,
        reasons: [...new Set(reasons)].slice(0, 5)
      });
    }
  }
  return scored
    .sort((a, b) => b.score - a.score || String(a.name).localeCompare(String(b.name)))
    .slice(0, 12);
}

function skillRules(name) {
  const n = String(name ?? '').toLowerCase();
  const rules = [];
  if (n === 'docx') rules.push({ re: /\.docx|Word|打开有问题|无法打开|修复|页码|wp:docPr|pic:cNvPr|ImageRun/i, score: 8, reason: 'DOCX/Word/openability signal' });
  if (n === 'pptx') rules.push({ re: /\.pptx|PowerPoint|slide|presentation/i, score: 7, reason: 'PPTX/presentation signal' });
  if (n === 'xlsx') rules.push({ re: /\.xlsx|Excel|workbook|worksheet|spreadsheet|公式|表格/i, score: 7, reason: 'XLSX/spreadsheet signal' });
  if (n.includes('diagram')) rules.push({ re: /\.drawio|drawio|\.svg|\.png|截图|连线|连接线|cropped|screenshot|connector|diagram/i, score: 9, reason: 'diagram/image integrity signal' });
  if (n.includes('chart')) rules.push({ re: /chart|csv|plot|图表|可视化/i, score: 6, reason: 'chart/visualization signal' });
  if (n === 'document') rules.push({ re: /方案|报告|文档|设计文档|proposal|report|document/i, score: 5, reason: 'document-generation signal' });
  if (n.includes('skill')) rules.push({ re: /skill|技能|优化相关技能|更新技能|创建技能/i, score: 8, reason: 'skill maintenance signal' });
  return rules;
}

function buildNextActions(candidates, failures) {
  const actions = [];
  actions.push('Open the selected session JSON and read the full messages around each failure signal before editing any skill.');
  actions.push('Map each failure to the narrowest affected skill; one session can require multiple skill updates.');
  actions.push('For repeatable structural failures, add or extend a script/validator in the affected skill and test it against the failing artifact when available.');
  if (failures.some((failure) => failure.codes.includes('repeated_skill_patch'))) {
    actions.push('Repeated skill patch attempts were detected. Re-read the target skill before patching, check whether the proposed new_string is already present, and skip duplicate patches instead of retrying the same replacement.');
  }
  if (failures.some((failure) => failure.codes.includes('overbroad_skill_optimization'))) {
    actions.push('Potential overbroad skill optimization was detected. Reduce the change to the smallest owner skill and avoid adding global cross-domain rules from one session failure.');
  }
  if (failures.some((failure) => failure.codes.includes('failure_signal_whitelist'))) {
    actions.push('Potential failure-signal whitelisting was detected. Do not mark validation, screenshot, image/diagram integrity, or openability failures as routine or ignorable; add a narrower condition and verification instead.');
  }
  if (failures.some((failure) => failure.codes.includes('skill_responsibility_pollution'))) {
    actions.push('Potential skill responsibility pollution was detected. Move domain-specific export/openability rules out of broad/browser/orchestration skills and into the diagram, DOCX, PPTX, or XLSX owner skill.');
  }
  if (candidates.length > 0) {
    actions.push(`Start with: ${candidates.slice(0, 5).map((skill) => skill.name).join(', ')}.`);
  }
  if (failures.some((failure) => failure.codes.includes('user_correction'))) {
    actions.push('Treat user correction messages as the strongest evidence of what the previous skill workflow missed.');
  }
  return actions;
}

function snippet(text) {
  return singleLine(text).slice(0, 220);
}

function singleLine(text) {
  return String(text).replace(/\s+/g, ' ').trim();
}

function escapePipes(text) {
  return String(text).replace(/\|/g, '\\|');
}

function printReport(report) {
  console.log(`# Session Failure Report`);
  console.log(`- id: ${report.session.id}`);
  console.log(`- title: ${report.session.title}`);
  console.log(`- updatedAt: ${report.session.updatedAt ?? ''}`);
  console.log(`- file: ${report.session.file}`);
  console.log(`- messages: ${report.session.messageCount}`);
  console.log('');
  console.log(`## Failure Signals (${report.failureCount})`);
  if (report.failures.length === 0) {
    console.log('- No obvious failure keywords were detected. Read the session manually before changing skills.');
  } else {
    for (const failure of report.failures) {
      const actor = failure.tool ? `${failure.role}/${failure.tool}` : failure.role;
      console.log(`- #${failure.index} ${actor} [${failure.codes.join(', ')}]: ${failure.snippet}`);
    }
  }
  console.log('');
  console.log('## Candidate Skills');
  if (report.candidateSkills.length === 0) {
    console.log('- No candidate skills were detected automatically.');
  } else {
    console.log('| score | skill | source | reasons | file |');
    console.log('| ---: | --- | --- | --- | --- |');
    for (const skill of report.candidateSkills) {
      console.log(`| ${skill.score} | ${skill.name} | ${skill.source} | ${escapePipes(skill.reasons.join('; '))} | ${escapePipes(skill.file ?? '')} |`);
    }
  }
  console.log('');
  console.log('## Next Actions');
  for (const action of report.nextActions) console.log(`- ${action}`);
}
