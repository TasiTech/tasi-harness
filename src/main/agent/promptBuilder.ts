import type { AppConfig, MemoryDomain } from '../../shared/types.js';
import type { MemoryStore } from '../storage/memoryStore.js';
import type { SkillManager } from '../skills/skillManager.js';
import type { PersonalKnowledgeBase } from '../knowledge/personalKnowledgeBase.js';
import type { SessionDocumentContextStore } from '../knowledge/sessionDocumentContextStore.js';

export interface PromptMessageBuild {
  systemPrompt: string;
  runtimeContext: string;
  displayPrompt: string;
}

export class PromptBuilder {
  constructor(
    private readonly memoryStore: MemoryStore,
    private readonly skillManager: SkillManager,
    private readonly personalKnowledgeBase: PersonalKnowledgeBase,
    private readonly externalBrowserBridgeGuide?: (config: AppConfig) => string,
    private readonly sessionDocumentContextStore?: SessionDocumentContextStore
  ) {}

  async build(
    config: AppConfig,
    context?: {
      sessionId?: string;
      userInput?: string;
      usePersonalKnowledgeBase?: boolean;
      useMemory?: boolean;
      memoryDomains?: MemoryDomain[];
      useSkills?: boolean;
      enabledSkillNames?: string[];
    }
  ): Promise<string> {
    return (await this.buildForMessages(config, context)).displayPrompt;
  }

  async buildForMessages(
    config: AppConfig,
    context?: {
      sessionId?: string;
      userInput?: string;
      usePersonalKnowledgeBase?: boolean;
      useMemory?: boolean;
      memoryDomains?: MemoryDomain[];
      useSkills?: boolean;
      enabledSkillNames?: string[];
    }
  ): Promise<PromptMessageBuild> {
    const date = new Date().toISOString();
    const memoryEnabled = context?.useMemory !== false;
    const skillsEnabled = context?.useSkills !== false;
    const explicitMemoryDomains = [...new Set(context?.memoryDomains ?? [])];
    const inferredDomains = explicitMemoryDomains.length > 0
      ? explicitMemoryDomains
      : (context?.userInput ? this.memoryStore.inferDomains(context.userInput) : []);
    const bridgeGuide = this.externalBrowserBridgeGuide?.(config).trim() ?? '';
    const personalKnowledgeBlock =
      context?.usePersonalKnowledgeBase && context.userInput
        ? await this.personalKnowledgeBase.renderPromptBlock(context.userInput, { limit: 5 })
        : '';
    const sessionDocumentBlock = this.sessionDocumentContextStore?.renderPromptBlock(context?.sessionId, {
      maxDocs: config.sessionDocumentMaxDocs,
      maxChars: 40_000
    }) ?? '';
    const systemPrompt = [
      config.systemPersona,
      '',
      '## Operating model',
      '- You are a local desktop harness inspired by Hermes Agent: plan, use tools, observe results, and iterate until the task is done.',
      '- Use tools when they materially improve correctness. Keep tool arguments precise and bounded.',
      '- When tool use is needed, call the tool directly without first telling the user you are about to do it. Only the final assistant answer should be user-facing.',
      '- Prefer workspace-relative file paths in tool arguments. Do not attempt to access files outside the configured workspace.',
      '- When your final answer mentions generated or modified local files, write each file as a full absolute path wrapped in inline code so the desktop UI can make it clickable for preview/open.',
      '- Keep internal reasoning compact and non-repetitive. Make one short plan when helpful, then act or report the blocker.',
      '- After a failed or blocked attempt, change strategy or explain the blocker instead of repeating the same reasoning.',
      '- Progress rule: once the next action is clear, the next assistant message must contain a tool call or visible deliverable content.',
      '- For document-generation tasks, after one outline either write the content, create/update the target file, or ask for the single missing input.',
      ...(skillsEnabled
        ? [
            '- If an installed skill is relevant to the user request, treat it as a mandatory execution workflow, not optional background reading.',
            '- If a relevant skill can be identified from the installed skills index, your first substantive step should be to call skill_view for that skill before drafting the answer.',
            '- After skill_view, follow the skill instructions, routing rules, references, tool requirements, and completion criteria before finalizing.',
            '- skill_view loads workflow guidance only; it is not evidence and does not by itself complete evidence gathering or provider/tool steps.',
            '- If the skill requires live data, page inspection, provider lookup, or verification, do those steps or clearly return a blocked/degraded answer.',
            '- If SKILL.md references supporting files, load only the relevant references with skill_view(name + ref_path).'
          ]
        : ['- Skill execution is disabled for this run; do not call skill_view or skill_manage.']),
      `- Browser mode is ${config.browserMode}.`,
      skillsEnabled
        ? '- When users ask to open/search/read/interact with webpages, consult the relevant browser automation skill from the installed skills index before planning web steps.'
        : '- When users ask to open/search/read/interact with webpages, use available browser_* tools directly when they are enabled.',
      config.browserMode === 'embedded'
        ? '- In embedded browser mode, use browser_* tools as the default web workflow and rely on the built-in preview.'
        : '- In external browser mode, use browser_* tools as the default workflow and let the harness surface pages in the system browser when needed.',
      '- For webpage file uploads, locate the target input[type=file] with browser_snapshot or browser_find, then use browser_upload_file with a workspace-relative path.',
      '- Use bounded browser snapshots/extracts for token efficiency, keep sensitive data redacted, and ask the user to complete captcha/MFA/secret entry in the visible browser when needed.',
      '- Browser close policy: keep the browser open for form submissions, approvals, account changes, or workflows where the user should review the final state; read-only lookup can auto-close.',
      bridgeGuide,
      '- When a final answer relies on browser/search/webpage evidence, cite important sourced claims with numbered inline Markdown links like [1](https://example.com), placed near the supported claim.',
      '- Reuse citation numbers per URL, cite only opened/inspected or trusted source material, and keep evidence links separate from action links.',
      '- Important live or retrieved facts need citations near the value: dates, prices, counts, rankings, policies, named findings, quotes, and data-heavy table rows.',
      '- If a value is estimated, inferred, generated from parameters, or not directly visible in a source, label it as [estimated], [inferred], or [unverified].',
      '- Terminal access may be disabled; when disabled, explain the required command instead of pretending it ran.',
      memoryEnabled
        ? '- Save durable facts via the memory tool: user preferences, project conventions, environment facts, and stable workflow lessons.'
        : '- Persistent memory is disabled for this run; do not call the memory tool or rely on stored memory snapshots.',
      skillsEnabled ? '- If you discover a repeatable non-trivial workflow, consider creating or patching a skill using skill_manage.' : '',
      '- Use session_search when previous conversations are likely relevant.',
      '- When a Personal knowledge snapshot section is present, treat it as user-provided source material. If it is relevant, use it before general knowledge and cite the filename in square brackets.',
      '',
      '## Installed skills index',
      skillsEnabled ? this.skillManager.renderPromptIndex(context?.enabledSkillNames) : 'Skills disabled for this run.',
      context?.sessionId
        ? [
            '',
            '## Session context',
            `Current session id: ${context.sessionId}`
          ].join('\n')
        : ''
    ].filter((part) => part !== '').join('\n');
    const runtimeContext = [
      '## Runtime context',
      `Current timestamp: ${date}`,
      explicitMemoryDomains.length > 0
        ? `Requested memory domains: ${explicitMemoryDomains.join(', ')}`
        : (inferredDomains.length > 0 ? `Inferred intent domains: ${inferredDomains.join(', ')}` : ''),
      '',
      '## Persistent memory snapshot',
      memoryEnabled
        ? this.renderMemoryPromptBlock(context?.sessionId, context?.userInput, explicitMemoryDomains)
        : '(memory disabled for this run)',
      context?.usePersonalKnowledgeBase
        ? [
            '',
            '## Personal knowledge snapshot',
            'Use these matched snippets when relevant. When you rely on them, cite the filename in square brackets such as [notes.md].',
            personalKnowledgeBlock || '(no personal knowledge documents)'
          ].join('\n')
        : '',
      context?.sessionId
        ? [
            '',
            '## Session document XML snapshot',
            'When this section contains XML, treat it as user-uploaded source material for the current session.',
            sessionDocumentBlock || '(no session document)'
          ].join('\n')
        : '',
      '',
    ].join('\n').trim();
    return {
      systemPrompt,
      runtimeContext,
      displayPrompt: [systemPrompt, runtimeContext].filter(Boolean).join('\n\n')
    };
  }

  private renderMemoryPromptBlock(sessionId?: string, intent?: string, domains: MemoryDomain[] = []): string {
    if (domains.length === 0) {
      return this.memoryStore.renderPromptBlock({
        sessionId,
        intent,
        includeGlobal: true
      });
    }
    return domains
      .map((domain) => this.memoryStore.renderPromptBlock({
        sessionId,
        intent,
        domain,
        includeGlobal: true
      }))
      .join('\n\n');
  }
}
