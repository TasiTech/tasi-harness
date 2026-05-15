import { describe, expect, it } from 'vitest';
import {
  normalizeProviderKind,
  providerApiStyle,
  providerDefaultBaseUrl,
  providerDefaultModel,
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
});
