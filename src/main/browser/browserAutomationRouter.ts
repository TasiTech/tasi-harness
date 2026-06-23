import type { BrowserAutomation } from '../tools/browserAutomation.js';
import type { AppConfig } from '../../shared/types.js';

export class BrowserAutomationRouter implements BrowserAutomation {
  constructor(
    private readonly getConfig: () => AppConfig,
    private readonly embedded: BrowserAutomation,
    private readonly external: BrowserAutomation
  ) {}

  private current(): BrowserAutomation {
    return this.getConfig().browserMode === 'external' ? this.external : this.embedded;
  }

  open(...args: Parameters<BrowserAutomation['open']>): ReturnType<BrowserAutomation['open']> {
    return this.current().open(...args);
  }

  click(...args: Parameters<BrowserAutomation['click']>): ReturnType<BrowserAutomation['click']> {
    return this.current().click(...args);
  }

  type(...args: Parameters<BrowserAutomation['type']>): ReturnType<BrowserAutomation['type']> {
    return this.current().type(...args);
  }

  scroll(...args: Parameters<BrowserAutomation['scroll']>): ReturnType<BrowserAutomation['scroll']> {
    return this.current().scroll(...args);
  }

  wait(...args: Parameters<BrowserAutomation['wait']>): ReturnType<BrowserAutomation['wait']> {
    return this.current().wait(...args);
  }

  extract(...args: Parameters<BrowserAutomation['extract']>): ReturnType<BrowserAutomation['extract']> {
    return this.current().extract(...args);
  }

  snapshot(...args: Parameters<BrowserAutomation['snapshot']>): ReturnType<BrowserAutomation['snapshot']> {
    return this.current().snapshot(...args);
  }

  find(...args: Parameters<BrowserAutomation['find']>): ReturnType<BrowserAutomation['find']> {
    return this.current().find(...args);
  }

  hover(...args: Parameters<BrowserAutomation['hover']>): ReturnType<BrowserAutomation['hover']> {
    return this.current().hover(...args);
  }

  select(...args: Parameters<BrowserAutomation['select']>): ReturnType<BrowserAutomation['select']> {
    return this.current().select(...args);
  }

  check(...args: Parameters<BrowserAutomation['check']>): ReturnType<BrowserAutomation['check']> {
    return this.current().check(...args);
  }

  press(...args: Parameters<BrowserAutomation['press']>): ReturnType<BrowserAutomation['press']> {
    return this.current().press(...args);
  }

  uploadFile(...args: Parameters<BrowserAutomation['uploadFile']>): ReturnType<BrowserAutomation['uploadFile']> {
    return this.current().uploadFile(...args);
  }

  screenshot(...args: Parameters<BrowserAutomation['screenshot']>): ReturnType<BrowserAutomation['screenshot']> {
    return this.current().screenshot(...args);
  }

  pdf(...args: Parameters<BrowserAutomation['pdf']>): ReturnType<BrowserAutomation['pdf']> {
    return this.current().pdf(...args);
  }

  storage(...args: Parameters<BrowserAutomation['storage']>): ReturnType<BrowserAutomation['storage']> {
    return this.current().storage(...args);
  }

  cookies(...args: Parameters<BrowserAutomation['cookies']>): ReturnType<BrowserAutomation['cookies']> {
    return this.current().cookies(...args);
  }

  console(...args: Parameters<BrowserAutomation['console']>): ReturnType<BrowserAutomation['console']> {
    return this.current().console(...args);
  }

  network(...args: Parameters<BrowserAutomation['network']>): ReturnType<BrowserAutomation['network']> {
    return this.current().network(...args);
  }

  evaluate(...args: Parameters<BrowserAutomation['evaluate']>): ReturnType<BrowserAutomation['evaluate']> {
    return this.current().evaluate(...args);
  }

  setViewport(...args: Parameters<BrowserAutomation['setViewport']>): ReturnType<BrowserAutomation['setViewport']> {
    return this.current().setViewport(...args);
  }

  state(...args: Parameters<BrowserAutomation['state']>): ReturnType<BrowserAutomation['state']> {
    return this.current().state(...args);
  }

  close(...args: Parameters<BrowserAutomation['close']>): ReturnType<BrowserAutomation['close']> {
    return this.current().close(...args);
  }
}
