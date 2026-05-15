import type { ProviderKind } from './types.js';

export type ProviderApiStyle = 'openai' | 'anthropic' | 'ollama' | 'mock';

export interface ProviderPreset {
  kind: Exclude<ProviderKind, 'anthropic-compatible'>;
  label: string;
  apiStyle: ProviderApiStyle;
  defaultBaseUrl: string;
  defaultModel: string;
  models: string[];
  requiresApiKey: boolean;
}

export const PROVIDER_PRESETS: ProviderPreset[] = [
  {
    kind: 'openai',
    label: 'OpenAI',
    apiStyle: 'openai',
    defaultBaseUrl: 'https://api.openai.com/v1',
    defaultModel: 'gpt-5.4',
    models: ['gpt-5.4', 'gpt-5.4-mini', 'gpt-5.4-pro', 'gpt-5.3-codex', 'gpt-5.3-codex-spark'],
    requiresApiKey: true
  },
  {
    kind: 'deepseek',
    label: 'DeepSeek',
    apiStyle: 'openai',
    defaultBaseUrl: 'https://api.deepseek.com/v1',
    defaultModel: 'deepseek-chat',
    models: ['deepseek-chat', 'deepseek-reasoner', 'deepseek-v4-flash', 'deepseek-v4-pro'],
    requiresApiKey: true
  },
  {
    kind: 'qwen-bailian',
    label: 'Qwen / Bailian',
    apiStyle: 'openai',
    defaultBaseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    defaultModel: 'qwen3.6-plus',
    models: ['qwen3-max', 'qwen3-max-preview', 'qwen3.6-plus', 'qwen3.5-flash', 'qwen3-coder-next', 'qwen3-coder-plus', 'qwen3-coder-flash'],
    requiresApiKey: true
  },
  {
    kind: 'minimax',
    label: 'MiniMax',
    apiStyle: 'openai',
    defaultBaseUrl: 'https://api.minimaxi.com/v1',
    defaultModel: 'MiniMax-M2.7',
    models: ['MiniMax-M2.7', 'MiniMax-M2.7-highspeed', 'MiniMax-M2.5', 'MiniMax-M2.5-highspeed', 'MiniMax-M2'],
    requiresApiKey: true
  },
  {
    kind: 'kimi',
    label: 'Kimi',
    apiStyle: 'openai',
    defaultBaseUrl: 'https://api.moonshot.cn/v1',
    defaultModel: 'kimi-k2.5',
    models: ['kimi-k2.5', 'kimi-k2-thinking', 'kimi-k2-thinking-turbo', 'kimi-k2-0905-preview', 'kimi-k2-turbo-preview'],
    requiresApiKey: true
  },
  {
    kind: 'anthropic',
    label: 'Anthropic',
    apiStyle: 'anthropic',
    defaultBaseUrl: 'https://api.anthropic.com/v1',
    defaultModel: 'claude-sonnet-4-20250514',
    models: ['claude-opus-4-1-20250805', 'claude-opus-4-20250514', 'claude-sonnet-4-20250514', 'claude-3-7-sonnet-latest', 'claude-3-5-haiku-latest'],
    requiresApiKey: true
  },
  {
    kind: 'openai-compatible',
    label: 'OpenAI-compatible',
    apiStyle: 'openai',
    defaultBaseUrl: 'https://api.openai.com/v1',
    defaultModel: 'gpt-5.4',
    models: ['gpt-5.4', 'gpt-5.4-mini', 'gpt-5.4-pro', 'gpt-5.3-codex', 'gpt-5.3-codex-spark'],
    requiresApiKey: true
  },
  {
    kind: 'vllm',
    label: 'vLLM',
    apiStyle: 'openai',
    defaultBaseUrl: 'http://127.0.0.1:8000/v1',
    defaultModel: 'local-model',
    models: ['local-model', 'Qwen/Qwen3-8B', 'meta-llama/Llama-3.1-8B-Instruct', 'mistralai/Mistral-7B-Instruct-v0.3'],
    requiresApiKey: false
  },
  {
    kind: 'ollama',
    label: 'Ollama',
    apiStyle: 'ollama',
    defaultBaseUrl: 'http://127.0.0.1:11434',
    defaultModel: 'qwen3:8b',
    models: ['qwen3:8b', 'deepseek-r1:8b', 'llama3.1:8b', 'gemma3:12b'],
    requiresApiKey: false
  },
  {
    kind: 'mock',
    label: 'Mock',
    apiStyle: 'mock',
    defaultBaseUrl: 'mock://local',
    defaultModel: 'mock-assistant',
    models: ['mock-assistant'],
    requiresApiKey: false
  }
];

const PRESET_BY_KIND = new Map<ProviderKind, ProviderPreset>();
for (const preset of PROVIDER_PRESETS) {
  PRESET_BY_KIND.set(preset.kind, preset);
  if (preset.kind === 'anthropic') {
    PRESET_BY_KIND.set('anthropic-compatible', preset);
  }
}

export function normalizeProviderKind(value: string | undefined | null): ProviderKind {
  if (!value) return 'openai';
  if (value === 'anthropic-compatible') return 'anthropic';
  if (PRESET_BY_KIND.has(value as ProviderKind)) return value as ProviderKind;
  return 'openai';
}

export function providerPreset(kind: ProviderKind): ProviderPreset {
  return PRESET_BY_KIND.get(kind) ?? PRESET_BY_KIND.get('openai')!;
}

export function providerApiStyle(kind: ProviderKind): ProviderApiStyle {
  return providerPreset(kind).apiStyle;
}

export function providerRequiresApiKey(kind: ProviderKind): boolean {
  return providerPreset(kind).requiresApiKey;
}

export function providerDefaultBaseUrl(kind: ProviderKind): string {
  return providerPreset(kind).defaultBaseUrl;
}

export function providerDefaultModel(kind: ProviderKind): string {
  return providerPreset(kind).defaultModel;
}

export function providerModelOptions(kind: ProviderKind): string[] {
  return providerPreset(kind).models;
}
