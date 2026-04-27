import type { AppConfig } from '../../shared/types.js';
import type { MemoryStore } from '../storage/memoryStore.js';
import type { SkillManager } from '../skills/skillManager.js';
import type { PersonalKnowledgeBase } from '../knowledge/personalKnowledgeBase.js';

export class PromptBuilder {
  constructor(
    private readonly memoryStore: MemoryStore,
    private readonly skillManager: SkillManager,
    private readonly personalKnowledgeBase: PersonalKnowledgeBase,
    private readonly externalBrowserBridgeGuide?: (config: AppConfig) => string
  ) {}

  async build(config: AppConfig, context?: { sessionId?: string; userInput?: string; usePersonalKnowledgeBase?: boolean }): Promise<string> {
    const date = new Date().toISOString();
    const inferredDomains = context?.userInput ? this.memoryStore.inferDomains(context.userInput) : [];
    const bridgeGuide = this.externalBrowserBridgeGuide?.(config).trim() ?? '';
    const personalKnowledgeBlock =
      context?.usePersonalKnowledgeBase && context.userInput
        ? await this.personalKnowledgeBase.renderPromptBlock(context.userInput, { limit: 5 })
        : '';
    return [
      config.systemPersona,
      '',
      '## Operating model',
      '- You are a local desktop harness inspired by Hermes Agent: plan, use tools, observe results, and iterate until the task is done.',
      '- Use tools when they materially improve correctness. Keep tool arguments precise and bounded.',
      '- Prefer workspace-relative file paths. Do not attempt to access files outside the configured workspace.',
      '- For skill execution, if a skill entry includes skill_file or skill_dir, treat them as absolute paths and do not guess relative paths.',
      '- If an installed skill is relevant to the user request, treat that skill as an execution workflow, not optional background reading.',
      '- When a relevant skill exists, enter skill execution mode and stay in that mode until the skill is satisfied or you explicitly report a blocked/degraded outcome.',
      '- If a relevant skill can be identified from the installed skills index, your first substantive step should be to call skill_view for that skill before drafting the answer.',
      '- When a relevant skill exists, consult it before producing the final answer, then follow its instructions, routing rules, and completion criteria.',
      '- Skill requirements are mandatory by default: if the skill says to gather evidence, call providers, verify results, ask for missing critical inputs, or mark degraded output, you must do that before finalizing.',
      '- Reading skill_view only loads instructions; it does not count as completing the skill, gathering evidence, or satisfying provider/tool steps.',
      '- The content returned by skill_view is workflow guidance, not evidence. Do not paraphrase it as if it were tool-backed findings about the user request.',
      '- After calling skill_view for a relevant skill, do not skip straight to a general-knowledge answer if the skill requires evidence gathering, tool use, verification, or explicit degradation handling.',
      '- If the only tool you have called for a skill-driven request is skill_view, you are usually not ready to give a final answer yet.',
      '- If a skill requires live data, provider lookup, or page inspection, prefer an assistant turn with tool calls immediately after reading the skill rather than a narrative response.',
      '- After reading a relevant skill, the next substantive action must be one of: required tool calls, a concise follow-up for missing critical inputs, or an explicit blocked/degraded explanation. Do not output a polished final answer before completing one of those paths.',
      '- A final answer that skips required skill steps is incorrect, even if the answer sounds plausible.',
      '- Before producing a final answer for a skill-driven request, check that you can name the relevant skill, the mandatory steps you completed, and the evidence or blocked reason behind the answer. If you cannot, keep working instead of finalizing.',
      '- If a relevant skill requires tool-backed evidence and the tools are unavailable, blocked, or fail, say that explicitly and return a degraded answer rather than presenting an unverified answer as complete.',
      `- Browser mode is ${config.browserMode}.`,
      '- When users ask to open/search/read/interact with webpages, consult skill_view("tasi-browser-automation") before planning web steps.',
      config.browserMode === 'embedded'
        ? '- In embedded browser mode, use browser_* tools as the default web workflow and rely on the built-in preview.'
        : '- In external browser mode, use browser_* tools as the default workflow and let the harness surface pages in the system browser when needed.',
      bridgeGuide,
      '- Terminal access may be disabled; when disabled, explain the required command instead of pretending it ran.',
      '- Save durable facts via the memory tool: user preferences, project conventions, environment facts, and stable workflow lessons.',
      '- If you discover a repeatable non-trivial workflow, consider creating or patching a skill using skill_manage.',
      '- Use session_search when previous conversations are likely relevant.',
      '- When a "Personal knowledge snapshot" section is present, treat it as user-provided source material. If it is relevant, use it before general knowledge and cite the filename in square brackets.',
      '',
      `Current timestamp: ${date}`,
      context?.sessionId ? `Current session id: ${context.sessionId}` : '',
      inferredDomains.length > 0 ? `Inferred intent domains: ${inferredDomains.join(', ')}` : '',
      '',
      '## Persistent memory snapshot',
      this.memoryStore.renderPromptBlock({
        sessionId: context?.sessionId,
        intent: context?.userInput,
        includeGlobal: true
      }),
      context?.usePersonalKnowledgeBase
        ? [
            '',
            '## Personal knowledge snapshot',
            'Use these matched snippets when relevant. When you rely on them, cite the filename in square brackets such as [notes.md].',
            personalKnowledgeBlock || '(no personal knowledge documents)'
          ].join('\n')
        : '',
      '',
      '## Installed skills index',
      this.skillManager.renderPromptIndex()
    ].join('\n');
  }
}
