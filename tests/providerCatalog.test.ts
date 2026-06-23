import { describe, expect, it } from 'vitest';
import {
  normalizeProviderKind,
  providerApiStyle,
  providerDefaultBaseUrl,
  providerDefaultModel,
  providerModelOptions,
  providerRequiresApiKey
} from '../src/shared/providerCatalog.js';

describe('providerCatalog', () => {
  it('supports vLLM as an OpenAI-compatible local provider', () => {
    expect(normalizeProviderKind('vllm')).toBe('vllm');
    expect(providerApiStyle('vllm')).toBe('openai');
    expect(providerDefaultBaseUrl('vllm')).toBe('http://127.0.0.1:8000/v1');
    expect(providerDefaultModel('vllm')).toBe('local-model');
    expect(providerRequiresApiKey('vllm')).toBe(false);
  });

  it('supports SoildAPI qwen models as an OpenAI-compatible provider', () => {
    expect(normalizeProviderKind('soildapi')).toBe('soildapi');
    expect(providerApiStyle('soildapi')).toBe('openai');
    expect(providerDefaultBaseUrl('soildapi')).toBe('https://soildapi.com/v1');
    expect(providerDefaultModel('soildapi')).toBe('qwen3.6-plus');
    expect(providerModelOptions('soildapi')).toEqual([
      'qwen3.6-plus',
      'qwen3.6-flash',
      'qwen3.5-plus',
      'qwen3.5-flash',
      'deepseek-v4-flash',
      'deepseek-v4-pro'
    ]);
    expect(providerRequiresApiKey('soildapi')).toBe(true);
  });
});
