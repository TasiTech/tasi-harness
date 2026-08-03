import { afterEach, describe, expect, it } from 'vitest';
import { ConfigStore } from '../src/main/storage/configStore.js';
import { DEFAULT_OMNI_SYSTEM_PROMPT } from '../src/shared/defaultPrompts.js';
import { tempHome } from './helpers.js';

let cleanup = () => {};
afterEach(() => cleanup());

describe('ConfigStore', () => {
  it('persists omni model settings without exposing the omni API key publicly', () => {
    const env = tempHome();
    cleanup = env.cleanup;
    const store = new ConfigStore(env.home);

    store.update({
      omniProvider: 'openai',
      omniBaseUrl: 'wss://example.test/v1/realtime',
      omniApiKey: 'omni-secret',
      omniModel: 'gpt-realtime-2.1'
    });

    const publicConfig = store.publicConfig(false);
    expect(publicConfig.omniProvider).toBe('openai');
    expect(publicConfig.omniBaseUrl).toBe('wss://example.test/v1/realtime');
    expect(publicConfig.omniModel).toBe('gpt-realtime-2.1');
    expect(publicConfig.omniApiKeyConfigured).toBe(true);
    expect(publicConfig.omniApiKey).toBeUndefined();
  });

  it('keeps the existing omni API key when updates omit it', () => {
    const env = tempHome();
    cleanup = env.cleanup;
    const store = new ConfigStore(env.home);

    store.update({ omniApiKey: 'omni-secret' });
    store.update({ omniModel: 'gpt-realtime' });

    const config = store.get();
    expect(config.omniApiKey).toBe('omni-secret');
    expect(config.omniModel).toBe('gpt-realtime');
  });

  it('persists Qwen Realtime omni settings', () => {
    const env = tempHome();
    cleanup = env.cleanup;
    const store = new ConfigStore(env.home);

    store.update({
      omniProvider: 'qwen-bailian',
      omniBaseUrl: 'wss://workspace-id.cn-beijing.maas.aliyuncs.com/api-ws/v1/realtime',
      omniApiKey: 'dashscope-secret',
      omniModel: 'qwen3.5-omni-plus-realtime'
    });

    const config = store.get();
    expect(config.omniProvider).toBe('qwen-bailian');
    expect(config.omniBaseUrl).toBe('wss://workspace-id.cn-beijing.maas.aliyuncs.com/api-ws/v1/realtime');
    expect(config.omniApiKey).toBe('dashscope-secret');
    expect(config.omniModel).toBe('qwen3.5-omni-plus-realtime');
  });

  it('provides and persists the omni realtime system prompt', () => {
    const env = tempHome();
    cleanup = env.cleanup;
    const store = new ConfigStore(env.home);

    expect(store.publicConfig(false).omniSystemPrompt).toBe(DEFAULT_OMNI_SYSTEM_PROMPT);

    store.update({ omniSystemPrompt: 'Speak briefly and queue complex work.' });

    expect(store.get().omniSystemPrompt).toBe('Speak briefly and queue complex work.');
    expect(store.publicConfig(false).omniSystemPrompt).toBe('Speak briefly and queue complex work.');
  });
});
