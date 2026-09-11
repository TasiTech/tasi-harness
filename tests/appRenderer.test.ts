import { describe, expect, it } from 'vitest';
import { extractCitationLinks, normalizeCitationHref } from '../src/renderer/citations';
import { normalizeMarkdownForRender, renderMarkdownToHtml } from '../src/renderer/markdown';
import { reasoningPanelText } from '../src/shared/reasoningPreview';
import { assignToolEventsToVisibleMessages, artifactSelectionContextPrompt, artifactSelectionQuestionPrompt, assistantContentListView, assistantLiveContentPreviewText, currentTurnPendingToolEvents, decodeLikelyPercentEncodedChineseText, externalMessageDisplay, findPluginMentionTrigger, isVisibleChatMessage, mergeMessageDelta, pluginMentionItems, pluginMentionToken } from '../src/renderer/appHelpers';
import type { AgentArtifactRef, DshSidecarRuntimeStatus } from '../src/shared/types';

function escapeAttr(value: string): string {
  return value.replaceAll('&', '&amp;');
}

describe('renderMarkdownToHtml', () => {
  it('auto-links bare URLs in assistant text', () => {
    const url = 'https://kyfw.12306.cn/otn/leftTicket/init?linktypeid=dc&fs=%E5%8C%97%E4%BA%AC,BJP&ts=%E6%B5%8E%E5%8D%97,JNK&date=2026-05-20&flag=N,N,Y';
    const html = renderMarkdownToHtml(normalizeMarkdownForRender(`12306 official entry ${url}`));

    expect(html).toContain('<a');
    expect(html).toContain(`href="${escapeAttr(url)}"`);
    expect(html).toContain(`>${escapeAttr(url)}</a>`);
  });

  it('keeps trailing punctuation outside bare URL links', () => {
    const url = 'https://example.com/path?x=1&y=2';
    const html = renderMarkdownToHtml(normalizeMarkdownForRender(`Open ${url}.`));

    expect(html).toContain(`href="${escapeAttr(url)}"`);
    expect(html).not.toContain(`href="${escapeAttr(`${url}.`)}"`);
    expect(html).toContain(`>${escapeAttr(url)}</a>.`);
  });

  it('renders numeric markdown links as circular superscript citations', () => {
    const url = 'https://example.com/source';
    const html = renderMarkdownToHtml(normalizeMarkdownForRender(`Claim[3](${url}) and [source](${url}).`));

    expect(html).toContain(`<sup class="msg-cite-ref"><a href="${url}" target="_blank" rel="noreferrer" title="${url}">3</a></sup>`);
    expect(html).toContain(`<a href="${url}" target="_blank" rel="noreferrer">source</a>`);
  });

  it('normalizes double-encoded search URLs before rendering links', () => {
    const rawUrl = 'https://www.baidu.com/s?wd=%25E5%258C%2597%25E4%25BA%25AC%25E4%25BB%258A%25E5%25A4%25A9%25E5%25A4%25A9%25E6%25B0%2594';
    const normalizedUrl = 'https://www.baidu.com/s?wd=%E5%8C%97%E4%BA%AC%E4%BB%8A%E5%A4%A9%E5%A4%A9%E6%B0%94';
    const html = renderMarkdownToHtml(normalizeMarkdownForRender(`[baidu weather](${rawUrl})`));

    expect(normalizeCitationHref(rawUrl)).toBe(normalizedUrl);
    expect(html).toContain(`href="${normalizedUrl}"`);
    expect(html).not.toContain('%25E5');
  });

  it('renders citation badges for raw Chinese URLs containing spaces', () => {
    const rawUrl = 'https://baike.baidu.com/item/5·4 三亚海鲜店皮皮虾价格过高事件/67742287';
    const encodedUrl = normalizeCitationHref(rawUrl);
    const html = renderMarkdownToHtml(normalizeMarkdownForRender(`事件引发关注[1](${rawUrl})。`));

    expect(html).toContain(`<sup class="msg-cite-ref"><a href="${escapeAttr(encodedUrl)}" target="_blank" rel="noreferrer" title="${escapeAttr(encodedUrl)}">1</a></sup>`);
  });

  it('extracts referenced pages and excerpts from raw Chinese citation URLs', () => {
    const rawUrl = 'https://baike.baidu.com/item/5·4 三亚海鲜店皮皮虾价格过高事件/67742287';
    const citations = extractCitationLinks(`4 只皮皮虾花费 1035 元[1](${rawUrl})。后续说明。`);

    expect(citations).toHaveLength(1);
    expect(citations[0]).toMatchObject({
      label: '1',
      href: normalizeCitationHref(rawUrl),
      host: 'baike.baidu.com'
    });
    expect(citations[0]?.excerpt).toContain('1035 元[1]');
  });
});

describe('extractCitationLinks fallback links', () => {
  it('auto-numbers named markdown source links for the referenced pages panel', () => {
    const citations = extractCitationLinks([
      'Useful sources:',
      '[American Physiological Society Journal](https://journals.physiology.org/doi/full/10.1152/jappl.1948.1.2.93)',
      '[Frontiers in Physics](https://www.frontiersin.org/journals/physics/articles/10.3389/fphy.2019.00189/full)'
    ].join('\n'));

    expect(citations.map((citation) => citation.label)).toEqual(['1', '2']);
    expect(citations.map((citation) => citation.host)).toEqual(['journals.physiology.org', 'frontiersin.org']);
  });
});

describe('assistantContentListView', () => {
  it('splits assistant content into display items without splitting fenced code blanks', () => {
    const view = assistantContentListView([
      '第一段回复。',
      '',
      '```ts',
      'const value = 1;',
      '',
      'console.log(value);',
      '```',
      '',
      '- 后续条目'
    ].join('\n'));

    expect(view.clipped).toBe(false);
    expect(view.items).toHaveLength(3);
    expect(view.items[0]).toBe('第一段回复。');
    expect(view.items[1]).toContain('const value = 1;\n\nconsole.log(value);');
    expect(view.items[2]).toBe('- 后续条目');
  });
});

describe('decodeLikelyPercentEncodedChineseText', () => {
  it('decodes pasted URL-encoded Chinese in user-visible text', () => {
    const raw = 'c:\\Users\\hujuntao\\.tasi-harness\\sessions\\session_mtfoi7vl_lfndcngk.json %E7%BB%93%E5%90%88session %E8%AE%B0%E5%BD%95%E5%88%86%E6%9E%90';

    expect(decodeLikelyPercentEncodedChineseText(raw)).toBe(
      'c:\\Users\\hujuntao\\.tasi-harness\\sessions\\session_mtfoi7vl_lfndcngk.json 结合session 记录分析'
    );
  });

  it('leaves non-Chinese percent encodings unchanged', () => {
    expect(decodeLikelyPercentEncodedChineseText('progress 100% and file%20name')).toBe('progress 100% and file%20name');
  });
});

describe('assistantLiveContentPreviewText', () => {
  it('clips live assistant content to the latest text as a single preview block', () => {
    const view = assistantLiveContentPreviewText(`start-marker\n${'older content '.repeat(600)}\nlatest answer`);

    expect(view.clipped).toBe(true);
    expect(view.text).toContain('latest answer');
    expect(view.text).not.toContain('start-marker');
    expect(view.text.length).toBeLessThanOrEqual(5000);
  });
});

describe('artifact selection prompt helpers', () => {
  const artifact: AgentArtifactRef = {
    id: 'artifact_py',
    name: 'demo.py',
    path: 'demo.py',
    absPath: 'D:\\workspace\\demo.py',
    ext: '.py',
    kind: 'text',
    previewMode: 'code',
    mimeType: 'text/x-python',
    sizeBytes: 120,
    source: 'assistant-link'
  };

  it('builds a question prompt with selected file context', () => {
    const prompt = artifactSelectionQuestionPrompt(artifact, 'def hello():\n    return "world"');

    expect(prompt).toContain('文件：demo.py');
    expect(prompt).toContain('路径：D:\\workspace\\demo.py');
    expect(prompt).toContain('```text\ndef hello():\n    return "world"\n```');
    expect(prompt.endsWith('问题：')).toBe(true);
  });

  it('builds an add-context prompt for selected file content', () => {
    const prompt = artifactSelectionContextPrompt(artifact, 'print("ok")');

    expect(prompt).toContain('文件预览中选中的内容');
    expect(prompt).toContain('print("ok")');
  });
});

describe('reasoningPanelText', () => {
  it('clips live reasoning from the newest reasoning parts', () => {
    const parts = [
      'old reasoning '.repeat(400),
      'middle reasoning '.repeat(300),
      'latest reasoning'
    ];
    const view = reasoningPanelText(parts.join('\n'), parts, true);

    expect(view.clippedText).toBe(true);
    expect(view.text).toContain('latest reasoning');
    expect(view.text).not.toContain('old reasoning old reasoning');
    expect(view.text.length).toBeLessThanOrEqual(3000);
  });
});

describe('isVisibleChatMessage', () => {
  it('hides internal user followup messages', () => {
    expect(isVisibleChatMessage({
      id: 'msg_hidden_user',
      role: 'user',
      hidden: true,
      content: '/agent-teams hidden followup',
      createdAt: '2026-09-02T00:00:00.000Z'
    })).toBe(false);
  });

  it('keeps the streamed assistant bubble visible when only prior iteration content remains', () => {
    expect(isVisibleChatMessage({
      id: 'msg_visible',
      role: 'assistant',
      content: '',
      reasoning_content: '',
      content_parts: ['I will inspect first.'],
      createdAt: '2026-08-28T00:00:00.000Z'
    })).toBe(true);
  });
});

describe('assignToolEventsToVisibleMessages', () => {
  it('attaches tool events to the next assistant reply by timestamp', () => {
    const groups = assignToolEventsToVisibleMessages([
      { id: 'u1', role: 'user', content: 'one', createdAt: '2026-09-05T00:00:00.000Z' },
      { id: 'a1', role: 'assistant', content: 'answer one', createdAt: '2026-09-05T00:00:10.000Z' },
      { id: 'u2', role: 'user', content: 'two', createdAt: '2026-09-05T00:01:00.000Z' },
      { id: 'a2', role: 'assistant', content: 'answer two', createdAt: '2026-09-05T00:01:10.000Z' }
    ], [
      { id: 't1', toolName: 'file_read', args: { path: 'a.txt' }, ok: true, content: 'a', createdAt: '2026-09-05T00:00:05.000Z' },
      { id: 't2', toolName: 'terminal', args: { command: 'npm test' }, ok: true, content: 'ok', createdAt: '2026-09-05T00:01:05.000Z' }
    ]);

    expect(groups.map((group) => group.map((event) => event.id))).toEqual([[], ['t1'], [], ['t2']]);
  });

  it('keeps only the newest live tool events while a run is streaming', () => {
    const events = Array.from({ length: 5 }, (_, index) => ({
      id: `t${index}`,
      toolName: 'terminal',
      args: {},
      ok: true,
      content: String(index),
      createdAt: `2026-09-05T00:00:0${index}.000Z`
    }));

    const groups = assignToolEventsToVisibleMessages([
      { id: 'a1', role: 'assistant', content: 'streaming', createdAt: '2026-09-05T00:00:10.000Z' }
    ], events, true, 2);

    expect(groups[0]?.map((event) => event.id)).toEqual(['t3', 't4']);
  });
});

describe('currentTurnPendingToolEvents', () => {
  it('returns live tool events after the latest user when no assistant bubble exists yet', () => {
    const events = [
      { id: 'old', toolName: 'terminal', args: {}, ok: true, content: 'old', createdAt: '2026-09-05T00:00:05.000Z' },
      { id: 'new', toolName: 'terminal', args: {}, ok: true, content: 'new', createdAt: '2026-09-05T00:01:05.000Z' }
    ];

    expect(currentTurnPendingToolEvents([
      { id: 'u1', role: 'user', content: 'one', createdAt: '2026-09-05T00:00:00.000Z' },
      { id: 'a1', role: 'assistant', content: 'answer one', createdAt: '2026-09-05T00:00:10.000Z' },
      { id: 'u2', role: 'user', content: 'two', createdAt: '2026-09-05T00:01:00.000Z' }
    ], events, true).map((event) => event.id)).toEqual(['new']);
  });
});

describe('externalMessageDisplay', () => {
  it('does not expose the dsh-im bridge name as the visible sender', () => {
    expect(externalMessageDisplay({
      provider: 'dsh-im',
      pluginId: '@xmanrui/dsh-im',
      externalConversationId: 'conv-1'
    })).toEqual({
      channelLabel: 'IM',
      senderLabel: 'IM / conv-1',
      avatarLabel: 'IM'
    });
  });

  it('shows the channel and sender name when both are available', () => {
    expect(externalMessageDisplay({
      provider: 'wechat',
      externalConversationId: 'group-1',
      displayName: '项目群',
      senderName: '张三'
    })).toEqual({
      channelLabel: 'WeChat',
      senderLabel: 'WeChat / 项目群 / 张三',
      avatarLabel: '张三'
    });
  });
});

describe('mergeMessageDelta', () => {
  it('preserves streamed assistant display section order', () => {
    const withContentFirst = mergeMessageDelta([], {
      sessionId: 'session_test',
      messageId: 'msg_streamed',
      role: 'assistant',
      type: 'content',
      delta: 'Answer first.',
      displaySectionOrder: ['content'],
      createdAt: '2026-09-02T09:17:55.000Z'
    });
    const withReasoningNext = mergeMessageDelta(withContentFirst, {
      sessionId: 'session_test',
      messageId: 'msg_streamed',
      role: 'assistant',
      type: 'reasoning_content',
      delta: 'Then thinking.',
      displaySectionOrder: ['content', 'reasoning_content'],
      createdAt: '2026-09-02T09:17:55.000Z'
    });

    expect(withReasoningNext[0]?.displaySectionOrder).toEqual(['content', 'reasoning_content']);
  });

  it('merges streamed assistant timeline entries instead of replacing earlier entries', () => {
    const withContentFirst = mergeMessageDelta([], {
      sessionId: 'session_test',
      messageId: 'msg_streamed',
      role: 'assistant',
      type: 'content',
      delta: 'Visible update.',
      displaySectionOrder: ['content'],
      displayTimeline: [{ type: 'content', index: 0 }],
      createdAt: '2026-09-02T09:17:55.000Z'
    });
    const withReasoningNext = mergeMessageDelta(withContentFirst, {
      sessionId: 'session_test',
      messageId: 'msg_streamed',
      role: 'assistant',
      type: 'reasoning_content',
      delta: 'Later reasoning.',
      displaySectionOrder: ['reasoning_content'],
      displayTimeline: [{ type: 'reasoning_content', index: 0 }],
      createdAt: '2026-09-02T09:17:55.000Z'
    });

    expect(withReasoningNext[0]?.displaySectionOrder).toEqual(['content', 'reasoning_content']);
    expect(withReasoningNext[0]?.displayTimeline).toEqual([
      { type: 'content', index: 0 },
      { type: 'reasoning_content', index: 0 }
    ]);
  });

  it('coalesces a late done delta with the final persisted assistant message', () => {
    const messages = mergeMessageDelta([
      {
        id: 'msg_user',
        role: 'user',
        content: '@nanmicoder/dsh-agent-teams 介绍一下天气预报的原理',
        createdAt: '2026-09-02T09:17:54.000Z'
      },
      {
        id: 'msg_persisted',
        role: 'assistant',
        content: '天气预报的核心是用观测数据和物理模型推算大气变化。',
        createdAt: '2026-09-02T09:17:55.000Z'
      }
    ], {
      sessionId: 'session_test',
      messageId: 'msg_streamed',
      role: 'assistant',
      type: 'done',
      content: '天气预报的核心是用观测数据和物理模型推算大气变化。',
      createdAt: '2026-09-02T09:17:55.000Z'
    });

    expect(messages.filter((message) => message.role === 'assistant')).toHaveLength(1);
    expect(messages.at(-1)?.id).toBe('msg_persisted');
  });
});

describe('plugin mention helpers', () => {
  const runtimeStatus: DshSidecarRuntimeStatus = {
    status: {
      available: true,
      running: true,
      protocolVersion: 1,
      home: 'home',
      profileName: 'default',
      profileDir: 'profile'
    },
    plugins: [{
      id: 'nanmicoder-dsh-agent-teams',
      packageName: '@nanmicoder/dsh-agent-teams',
      version: '0.1.15',
      enabled: true,
      status: 'partial',
      tools: ['agent_teams_view'],
      commands: ['/agent-teams'],
      settingsEntries: ['Agent Teams']
    }, {
      id: 'xmanrui-dsh-im',
      packageName: '@xmanrui/dsh-im',
      enabled: false,
      status: 'skipped',
      tools: []
    }, {
      id: 'superdesign-dsh',
      packageName: 'superdesign-dsh',
      version: '0.6.0',
      enabled: true,
      status: 'loaded',
      tools: [],
      commands: []
    }],
    tools: []
  };

  it('detects the active @ query before the cursor', () => {
    expect(findPluginMentionTrigger('use @dsh', 8)).toEqual({ start: 4, end: 8, query: 'dsh' });
    expect(findPluginMentionTrigger('email a@b.com', 13)).toBeNull();
  });

  it('filters installed plugins by alias and creates insert tokens', () => {
    const items = pluginMentionItems(runtimeStatus, 'agent');

    expect(items).toHaveLength(1);
    expect(items[0]?.label).toBe('@nanmicoder/dsh-agent-teams');
    expect(pluginMentionToken(items[0]!.plugin)).toBe('nanmicoder/dsh-agent-teams');
  });

  it('only lists enabled and runtime-available plugins', () => {
    const items = pluginMentionItems(runtimeStatus, '');

    expect(items.map((item) => item.label)).toEqual(['@nanmicoder/dsh-agent-teams', 'superdesign-dsh']);
  });

  it('lists skills-only plugins as skill providers in @ suggestions', () => {
    const items = pluginMentionItems(runtimeStatus, 'superdesign');

    expect(items).toHaveLength(1);
    expect(items[0]?.label).toBe('superdesign-dsh');
    expect(items[0]?.detail).toContain('skill provider');
  });
});
