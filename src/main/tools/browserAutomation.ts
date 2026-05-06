export interface BrowserPageState {
  url: string;
  title: string;
}

export interface BrowserExtractResult extends BrowserPageState {
  content: string;
  format: 'html' | 'json';
  selector?: string;
}

export interface BrowserSnapshotElement {
  ref: string;
  tag: string;
  role: string;
  name: string;
  text: string;
  selector: string;
  href?: string;
  value?: string;
  placeholder?: string;
  label?: string;
  visible: boolean;
  enabled: boolean;
  checked?: boolean;
  box?: { x: number; y: number; width: number; height: number };
}

export interface BrowserSnapshotResult extends BrowserPageState {
  content: string;
  snapshot?: string;
  tree?: unknown[];
  source?: 'accessibility' | 'semantic-dom';
  elements: BrowserSnapshotElement[];
  headings: Array<{ level: number; text: string; ref?: string }>;
  links: Array<{ text: string; href: string; ref?: string }>;
  images: Array<{ alt: string; src: string; ref?: string }>;
  viewport: { width: number; height: number; scrollX: number; scrollY: number };
  truncated?: boolean;
}

export interface BrowserFindOptions {
  by: 'role' | 'text' | 'label' | 'placeholder' | 'alt' | 'title' | 'testid' | 'css';
  value: string;
  action?: 'snapshot' | 'text' | 'click' | 'type' | 'fill' | 'focus' | 'hover' | 'check' | 'uncheck' | 'select';
  text?: string;
  name?: string;
  exact?: boolean;
  index?: number;
  waitForNavigation?: boolean;
  timeoutMs?: number;
}

export interface BrowserFindResult extends BrowserPageState {
  ref?: string;
  selector?: string;
  text?: string;
  element?: BrowserSnapshotElement;
}

export interface BrowserBinaryResult extends BrowserPageState {
  data: Buffer;
  mimeType: string;
  extension: string;
}

export interface BrowserStorageResult extends BrowserPageState {
  area: 'local' | 'session';
  content: string;
}

export interface BrowserCookieResult extends BrowserPageState {
  content: string;
}

export interface BrowserDiagnosticsResult extends BrowserPageState {
  content: string;
}

export interface BrowserAutomation {
  open(url: string, options?: { timeoutMs?: number }): Promise<BrowserPageState>;
  click(selector: string, options?: { index?: number; waitForNavigation?: boolean; timeoutMs?: number }): Promise<BrowserPageState>;
  type(selector: string, text: string, options?: { clear?: boolean; submit?: boolean }): Promise<BrowserPageState>;
  scroll(options?: { direction?: 'up' | 'down' | 'left' | 'right' | 'top' | 'bottom'; amount?: number; selector?: string }): Promise<BrowserPageState>;
  wait(options?: {
    ms?: number;
    selector?: string;
    text?: string;
    url?: string;
    state?: 'attached' | 'visible' | 'hidden' | 'detached';
    loadState?: 'load' | 'domcontentloaded' | 'networkidle';
    function?: string;
    timeoutMs?: number;
  }): Promise<BrowserPageState>;
  extract(options?: { selector?: string; format?: 'html' | 'json'; maxChars?: number }): Promise<BrowserExtractResult>;
  snapshot(options?: { selector?: string; maxElements?: number; maxChars?: number }): Promise<BrowserSnapshotResult>;
  find(options: BrowserFindOptions): Promise<BrowserFindResult>;
  hover(selector: string, options?: { index?: number }): Promise<BrowserPageState>;
  select(selector: string, value: string, options?: { index?: number }): Promise<BrowserPageState>;
  check(selector: string, checked: boolean, options?: { index?: number }): Promise<BrowserPageState>;
  press(key: string, options?: { selector?: string; text?: string }): Promise<BrowserPageState>;
  screenshot(options?: { fullPage?: boolean }): Promise<BrowserBinaryResult>;
  pdf(): Promise<BrowserBinaryResult>;
  storage(options?: { area?: 'local' | 'session'; action?: 'get' | 'set' | 'clear'; key?: string; value?: string }): Promise<BrowserStorageResult>;
  cookies(options?: { action?: 'get' | 'set' | 'clear'; name?: string; value?: string; url?: string; domain?: string; path?: string }): Promise<BrowserCookieResult>;
  console(options?: { level?: 'all' | 'log' | 'info' | 'warning' | 'error'; clear?: boolean; maxItems?: number }): Promise<BrowserDiagnosticsResult>;
  network(options?: { filter?: string; type?: string; maxItems?: number; clear?: boolean }): Promise<BrowserDiagnosticsResult>;
  evaluate(script: string, options?: { maxChars?: number }): Promise<BrowserDiagnosticsResult>;
  setViewport(options: { width: number; height: number; scale?: number }): Promise<BrowserPageState>;
  state(): Promise<BrowserPageState>;
  close(): Promise<void>;
}
