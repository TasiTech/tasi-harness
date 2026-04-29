export interface BrowserPageState {
  url: string;
  title: string;
}

export interface BrowserExtractResult extends BrowserPageState {
  content: string;
  format: 'html' | 'json';
  selector?: string;
}

export interface BrowserAutomation {
  open(url: string, options?: { timeoutMs?: number }): Promise<BrowserPageState>;
  click(selector: string, options?: { index?: number; waitForNavigation?: boolean; timeoutMs?: number }): Promise<BrowserPageState>;
  type(selector: string, text: string, options?: { clear?: boolean; submit?: boolean }): Promise<BrowserPageState>;
  scroll(options?: { direction?: 'up' | 'down' | 'top' | 'bottom'; amount?: number }): Promise<BrowserPageState>;
  wait(options?: { ms?: number; selector?: string; timeoutMs?: number }): Promise<BrowserPageState>;
  extract(options?: { selector?: string; format?: 'html' | 'json'; maxChars?: number }): Promise<BrowserExtractResult>;
  state(): Promise<BrowserPageState>;
  close(): Promise<void>;
}
