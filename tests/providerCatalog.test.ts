import { describe, expect, it } from 'vitest';
import {
  OMNI_PROVIDER_PRESETS,
  normalizeProviderKind,
  omniProviderDefaultBaseUrl,
  omniProviderDefaultModel,
  omniProviderModelOptions,
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

  it('exposes OpenAI Realtime WebSocket models for omni configuration', () => {
    expect(OMNI_PROVIDER_PRESETS.map((preset) => preset.kind)).toEqual(['openai', 'qwen-bailian']);
    expect(omniProviderDefaultBaseUrl('openai')).toBe('wss://api.openai.com/v1/realtime');
    expect(omniProviderDefaultModel('openai')).toBe('gpt-realtime-2.1');
    expect(omniProviderModelOptions('openai')).toEqual([
      'gpt-realtime-2.1',
      'gpt-realtime-2.1-mini',
      'gpt-realtime',
      'gpt-realtime-mini'
    ]);
  });

  it('exposes Qwen Omni Realtime WebSocket models for omni configuration', () => {
    expect(omniProviderDefaultBaseUrl('qwen-bailian')).toBe('wss://dashscope.aliyuncs.com/api-ws/v1/realtime');
    expect(omniProviderDefaultModel('qwen-bailian')).toBe('qwen3.5-omni-flash-realtime');
    expect(omniProviderModelOptions('qwen-bailian')).toEqual([
      'qwen3.5-omni-plus-realtime',
      'qwen3.5-omni-plus-realtime-2026-03-15',
      'qwen3.5-omni-flash-realtime',
      'qwen3.5-omni-flash-realtime-2026-03-15',
      'qwen3-omni-flash-realtime'
    ]);
  });
});
