import { describe, expect, it, vi } from 'vitest';
import { generateFollowUpQuestions } from '../src/main/agent/followUpQuestions.js';
import { defaultConfig } from '../src/main/storage/pathUtils.js';
import type { LlmClient } from '../src/main/agent/llmClient.js';

describe('followUpQuestions', () => {
  it('returns user-voice Chinese fallback questions', async () => {
    const result = await generateFollowUpQuestions(
      () =>
        ({
          complete: vi.fn()
        }) as unknown as LlmClient,
      defaultConfig(),
      {
        userInput: '\u5e2e\u6211\u505a\u4e00\u4e2a\u53d1\u5e03\u8ba1\u5212',
        finalResponse: ''
      }
    );

    expect(result).toEqual([
      '\u4f60\u80fd\u5e2e\u6211\u628a\u4e0a\u9762\u7684\u5185\u5bb9\u6574\u7406\u6210\u4e00\u4e2a\u5206\u6b65\u6e05\u5355\u5417\uff1f',
      '\u6211\u5982\u679c\u73b0\u5728\u5f00\u59cb\uff0c\u7b2c\u4e00\u6b65\u5e94\u8be5\u5148\u505a\u4ec0\u4e48\uff1f',
      '\u7ed3\u5408\u6211\u7684\u60c5\u51b5\uff0c\u6700\u9700\u8981\u6ce8\u610f\u7684\u98ce\u9669\u3001\u9650\u5236\u6216\u524d\u63d0\u662f\u4ec0\u4e48\uff1f'
    ]);
  });

  it('filters service-style and prompt-style suggestions, then backfills with user-voice questions', async () => {
    const complete = vi.fn().mockResolvedValue({
      message: {
        role: 'assistant',
        content: JSON.stringify([
          '\u4f60\u53ef\u4ee5\u7ee7\u7eed\u95ee\uff1a\u6211\u63a5\u4e0b\u6765\u5e94\u8be5\u5148\u51c6\u5907\u4ec0\u4e48\uff1f',
          '\u9700\u8981\u6211\u5e2e\u4f60\u6574\u7406\u6210\u8868\u683c\u5417\uff1f',
          'Would you like me to draft the email for you?'
        ])
      }
    });

    const result = await generateFollowUpQuestions(
      () =>
        ({
          complete
        }) as unknown as LlmClient,
      {
        ...defaultConfig(),
        apiKey: 'test-key'
      },
      {
        userInput: '\u8bf7\u5e2e\u6211\u5206\u6790\u8fd9\u4e24\u4e2a\u65b9\u6848',
        finalResponse: '\u6211\u5df2\u7ecf\u5bf9\u8fd9\u4e24\u4e2a\u65b9\u6848\u505a\u4e86\u521d\u6b65\u5bf9\u6bd4\u3002'
      }
    );

    expect(result).toEqual([
      '\u6211\u63a5\u4e0b\u6765\u5e94\u8be5\u5148\u51c6\u5907\u4ec0\u4e48\uff1f',
      '\u4f60\u80fd\u5e2e\u6211\u628a\u4e0a\u9762\u7684\u5185\u5bb9\u6574\u7406\u6210\u4e00\u4e2a\u5206\u6b65\u6e05\u5355\u5417\uff1f',
      '\u6211\u5982\u679c\u73b0\u5728\u5f00\u59cb\uff0c\u7b2c\u4e00\u6b65\u5e94\u8be5\u5148\u505a\u4ec0\u4e48\uff1f'
    ]);
    expect(result.every((item) => !/^(Would you like me to|Need me to)/i.test(item))).toBe(true);
  });
});
