import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
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

  it('persists the tech glass theme', () => {
    const env = tempHome();
    cleanup = env.cleanup;
    const store = new ConfigStore(env.home);

    store.update({ theme: 'tech' });

    expect(store.get().theme).toBe('tech');
    expect(store.publicConfig(false).theme).toBe('tech');
  });

  it('sanitizes and exposes text brightness', () => {
    const env = tempHome();
    cleanup = env.cleanup;
    const store = new ConfigStore(env.home);

    expect(store.publicConfig(false).textBrightness).toBe(100);

    store.update({ textBrightness: 180 });
    expect(store.get().textBrightness).toBe(150);
    expect(store.publicConfig(false).textBrightness).toBe(150);

    store.update({ textBrightness: 45 });
    expect(store.get().textBrightness).toBe(70);
  });

  it('persists an imported custom theme selection', () => {
    const env = tempHome();
    cleanup = env.cleanup;
    const store = new ConfigStore(env.home);

    store.update({
      customThemes: [
        {
          id: 'dreamskin-blue',
          name: 'DreamSkin Blue',
          source: 'dreamskin',
          tokens: {
            bgPrimary: '#06111f',
            accent: '#18f0cf',
            textPrimary: '#eef9ff'
          },
          createdAt: new Date().toISOString()
        }
      ],
      theme: 'custom:dreamskin-blue'
    });

    expect(store.get().theme).toBe('custom:dreamskin-blue');
    expect(store.publicConfig(false).customThemes[0].name).toBe('DreamSkin Blue');
  });

  it('exposes imported custom theme background images to the renderer', () => {
    const env = tempHome();
    cleanup = env.cleanup;
    const backgroundPath = join(env.home, 'theme-bg.png');
    writeFileSync(backgroundPath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const store = new ConfigStore(env.home);

    store.update({
      customThemes: [
        {
          id: 'with-bg',
          name: 'With Background',
          source: 'dreamskin',
          tokens: {
            bgPrimary: '#06111f',
            accent: '#18f0cf',
            textPrimary: '#eef9ff'
          },
          backgroundPath,
          createdAt: new Date().toISOString()
        }
      ],
      theme: 'custom:with-bg'
    });

    expect(store.publicConfig(false).customThemes[0].backgroundDataUrl).toMatch(/^data:image\/png;base64,/);
  });
});
