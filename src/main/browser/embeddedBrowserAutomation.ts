import { app, BrowserWindow, type WebContents } from 'electron';
import type { BrowserAutomation, BrowserExtractResult, BrowserPageState } from '../tools/browserAutomation.js';
import { EMBEDDED_BROWSER_PARTITION } from '../../shared/browserConstants.js';
import { resolveAppWindowIconPath } from '../appIcon.js';

const DEFAULT_TIMEOUT_MS = 20000;
const DEFAULT_EXTRACT_MAX_CHARS = 8000;

interface BrowserExtractJsonLink {
  text: string;
  href: string;
}

interface BrowserExtractJsonPayload {
  tool: 'browser_extract';
  format: 'json';
  browser_preview_url: string;
  url: string;
  title: string;
  selector?: string;
  text: string;
  headings: string[];
  links: BrowserExtractJsonLink[];
  truncated?: boolean;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeUrl(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) throw new Error('url is required.');
  if (/^[a-zA-Z][a-zA-Z\d+\-.]*:/.test(trimmed)) return trimmed;
  return `https://${trimmed}`;
}

function clampInt(value: number, fallback: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.round(value)));
}

function clipWithMarker(value: string, maxChars: number): string {
  if (maxChars <= 0) return '';
  if (value.length <= maxChars) return value;
  const marker = '... [truncated]';
  if (maxChars <= marker.length) return value.slice(0, maxChars);
  return `${value.slice(0, maxChars - marker.length)}${marker}`;
}

function serializeBrowserExtractJson(payload: BrowserExtractJsonPayload, maxChars: number): string {
  const normalized: BrowserExtractJsonPayload = {
    ...payload,
    browser_preview_url: clipWithMarker(payload.browser_preview_url, 500),
    url: clipWithMarker(payload.url, 500),
    title: clipWithMarker(payload.title, 200),
    ...(payload.selector ? { selector: clipWithMarker(payload.selector, 200) } : {}),
    text: clipWithMarker(payload.text, 6000),
    headings: payload.headings.slice(0, 20).map((item) => clipWithMarker(item, 200)),
    links: payload.links.slice(0, 25).map((item) => ({
      text: clipWithMarker(item.text, 160),
      href: clipWithMarker(item.href, 320)
    }))
  };

  const serialize = (text: string, headings: string[], links: BrowserExtractJsonLink[], truncated: boolean): string =>
    JSON.stringify(
      {
        ...normalized,
        text,
        headings,
        links,
        ...(truncated ? { truncated: true } : {})
      },
      null,
      2
    );

  let text = normalized.text;
  let headings = normalized.headings;
  let links = normalized.links;
  let serialized = serialize(text, headings, links, false);
  if (serialized.length <= maxChars) return serialized;

  while (links.length > 10 && serialized.length > maxChars) {
    links = links.slice(0, Math.max(10, links.length - 5));
    serialized = serialize(text, headings, links, true);
  }

  while (headings.length > 6 && serialized.length > maxChars) {
    headings = headings.slice(0, Math.max(6, headings.length - 2));
    serialized = serialize(text, headings, links, true);
  }

  const fitText = (nextHeadings: string[], nextLinks: BrowserExtractJsonLink[]): string => {
    let low = 0;
    let high = text.length;
    let best = serialize('', nextHeadings, nextLinks, true);
    while (low <= high) {
      const mid = Math.floor((low + high) / 2);
      const candidate = serialize(clipWithMarker(text, mid), nextHeadings, nextLinks, true);
      if (candidate.length <= maxChars) {
        best = candidate;
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }
    return best;
  };

  serialized = fitText(headings, links);
  if (serialized.length <= maxChars) return serialized;

  return fitText([], []);
}

export class EmbeddedBrowserAutomation implements BrowserAutomation {
  private window: BrowserWindow | null = null;
  private readonly partition = EMBEDDED_BROWSER_PARTITION;
  private sharedWebContentsResolver?: () => WebContents | null;

  setSharedWebContentsResolver(resolver: () => WebContents | null): void {
    this.sharedWebContentsResolver = resolver;
  }

  async open(url: string, options?: { timeoutMs?: number }): Promise<BrowserPageState> {
    const timeoutMs = clampInt(Number(options?.timeoutMs), DEFAULT_TIMEOUT_MS, 1000, 120000);
    const target = normalizeUrl(url);
    const wc = this.getTargetWebContents();
    await Promise.race([
      wc.loadURL(target),
      sleep(timeoutMs).then(() => {
        throw new Error(`Timed out opening ${target} after ${timeoutMs} ms.`);
      })
    ]);
    await this.waitForIdle(timeoutMs, wc);
    return this.stateFrom(wc);
  }

  async click(selector: string, options?: { index?: number; waitForNavigation?: boolean; timeoutMs?: number }): Promise<BrowserPageState> {
    const timeoutMs = clampInt(Number(options?.timeoutMs), DEFAULT_TIMEOUT_MS, 1000, 120000);
    const index = clampInt(Number(options?.index), 0, 0, 9999);
    const sel = selector.trim();
    if (!sel) throw new Error('selector is required.');
    const result = await this.evalInPage<{ ok: boolean; error?: string }>(
      `(function () {
        const selector = ${JSON.stringify(sel)};
        const index = ${index};
        const nodes = Array.from(document.querySelectorAll(selector));
        if (nodes.length === 0) return { ok: false, error: "Selector not found: " + selector };
        const target = nodes[Math.min(index, nodes.length - 1)];
        if (target && typeof target.scrollIntoView === "function") {
          target.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
        }
        const eventInit = { bubbles: true, cancelable: true, view: window };
        target.dispatchEvent(new MouseEvent("mouseover", eventInit));
        target.dispatchEvent(new MouseEvent("mousedown", eventInit));
        target.dispatchEvent(new MouseEvent("mouseup", eventInit));
        if (typeof target.click === "function") target.click();
        return { ok: true };
      })();`
    );
    if (!result.ok) throw new Error(result.error || `Failed to click selector: ${sel}`);
    if (options?.waitForNavigation) await this.waitForIdle(timeoutMs, this.getTargetWebContents());
    return this.state();
  }

  async type(selector: string, text: string, options?: { clear?: boolean; submit?: boolean }): Promise<BrowserPageState> {
    const sel = selector.trim();
    if (!sel) throw new Error('selector is required.');
    const value = text ?? '';
    const clear = options?.clear !== false;
    const submit = options?.submit === true;
    const result = await this.evalInPage<{ ok: boolean; error?: string }>(
      `(function () {
        const selector = ${JSON.stringify(sel)};
        const text = ${JSON.stringify(value)};
        const clear = ${clear ? 'true' : 'false'};
        const submit = ${submit ? 'true' : 'false'};
        const el = document.querySelector(selector);
        if (!el) return { ok: false, error: "Selector not found: " + selector };
        const emit = (node, type) => node.dispatchEvent(new Event(type, { bubbles: true }));
        if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
          el.focus();
          if (clear) el.value = "";
          el.value = clear ? text : String(el.value || "") + text;
          emit(el, "input");
          emit(el, "change");
          if (submit) {
            const enterInit = { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true };
            el.dispatchEvent(new KeyboardEvent("keydown", enterInit));
            el.dispatchEvent(new KeyboardEvent("keyup", enterInit));
            if (el.form) {
              if (typeof el.form.requestSubmit === "function") el.form.requestSubmit();
              else el.form.submit();
            }
          }
          return { ok: true };
        }
        if (el instanceof HTMLElement && el.isContentEditable) {
          el.focus();
          if (clear) el.textContent = "";
          el.textContent = clear ? text : String(el.textContent || "") + text;
          emit(el, "input");
          if (submit) {
            const enterInit = { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true };
            el.dispatchEvent(new KeyboardEvent("keydown", enterInit));
            el.dispatchEvent(new KeyboardEvent("keyup", enterInit));
          }
          return { ok: true };
        }
        return { ok: false, error: "Target is not an input, textarea, or contenteditable element." };
      })();`
    );
    if (!result.ok) throw new Error(result.error || `Failed to type into selector: ${sel}`);
    return this.state();
  }

  async scroll(options?: { direction?: 'up' | 'down' | 'top' | 'bottom'; amount?: number }): Promise<BrowserPageState> {
    const direction = options?.direction ?? 'down';
    const amount = clampInt(Number(options?.amount), 800, 20, 5000);
    await this.evalInPage(
      `(function () {
        const direction = ${JSON.stringify(direction)};
        const amount = ${amount};
        if (direction === "top") {
          window.scrollTo({ top: 0, behavior: "instant" });
          return;
        }
        if (direction === "bottom") {
          window.scrollTo({ top: document.body.scrollHeight, behavior: "instant" });
          return;
        }
        const delta = direction === "up" ? -amount : amount;
        window.scrollBy({ top: delta, behavior: "instant" });
      })();`
    );
    return this.state();
  }

  async wait(options?: { ms?: number; selector?: string; timeoutMs?: number }): Promise<BrowserPageState> {
    const ms = clampInt(Number(options?.ms), 0, 0, 60000);
    const selector = options?.selector?.trim() ?? '';
    const timeoutMs = clampInt(Number(options?.timeoutMs), DEFAULT_TIMEOUT_MS, 250, 120000);
    if (!selector && ms <= 0) throw new Error('Provide ms or selector.');
    if (ms > 0) await sleep(ms);
    if (selector) {
      const started = Date.now();
      while (Date.now() - started < timeoutMs) {
        const found = await this.evalInPage<boolean>(
          `(function () {
            return Boolean(document.querySelector(${JSON.stringify(selector)}));
          })();`
        );
        if (found) return this.state();
        await sleep(150);
      }
      throw new Error(`Timed out waiting for selector "${selector}" after ${timeoutMs} ms.`);
    }
    return this.state();
  }

  async extract(options?: { selector?: string; format?: 'html' | 'json'; maxChars?: number }): Promise<BrowserExtractResult> {
    const selector = options?.selector?.trim() || undefined;
    const format = options?.format === 'html' ? 'html' : 'json';
    const maxChars = clampInt(Number(options?.maxChars), DEFAULT_EXTRACT_MAX_CHARS, 200, 100000);
    const extracted = await this.evalInPage<{
      ok: boolean;
      error?: string;
      content?: string;
      snapshot?: {
        text: string;
        headings: string[];
        links: BrowserExtractJsonLink[];
      };
    }>(
      `(function () {
        const selector = ${JSON.stringify(selector ?? '')};
        const format = ${JSON.stringify(format)};
        const target = selector ? document.querySelector(selector) : document.body;
        if (!target) return { ok: false, error: "Selector not found: " + selector };
        const normalizeText = (value) => String(value || "")
          .replace(/\\u00a0/g, " ")
          .replace(/[ \\t]+/g, " ")
          .replace(/\\n{3,}/g, "\\n\\n")
          .trim();
        let content = "";
        if (format === "html") {
          content = target.outerHTML || "";
        } else {
          const headingSeen = new Set();
          const headings = [];
          for (const node of Array.from(target.querySelectorAll("h1,h2,h3,h4,h5,h6"))) {
            const text = normalizeText(node.innerText || node.textContent || "");
            if (!text || headingSeen.has(text)) continue;
            headingSeen.add(text);
            headings.push(text);
            if (headings.length >= 20) break;
          }

          const linkSeen = new Set();
          const links = [];
          for (const node of Array.from(target.querySelectorAll("a[href]"))) {
            const rawHref = node.getAttribute("href") || "";
            if (!rawHref) continue;
            let href = rawHref;
            try {
              href = new URL(rawHref, location.href).toString();
            } catch {}
            const text = normalizeText(node.innerText || node.textContent || "");
            const key = href + "|" + text;
            if (linkSeen.has(key)) continue;
            linkSeen.add(key);
            links.push({ text, href });
            if (links.length >= 25) break;
          }

          return {
            ok: true,
            snapshot: {
              text: normalizeText(target.innerText || target.textContent || ""),
              headings,
              links
            }
          };
        }
        return { ok: true, content };
      })();`
    );
    if (!extracted.ok) throw new Error(extracted.error || 'Failed to extract page content.');
    const page = await this.state();
    const content =
      format === 'json'
        ? serializeBrowserExtractJson(
            {
              tool: 'browser_extract',
              format: 'json',
              browser_preview_url: page.url,
              url: page.url,
              title: page.title,
              ...(selector ? { selector } : {}),
              text: extracted.snapshot?.text ?? '',
              headings: extracted.snapshot?.headings ?? [],
              links: extracted.snapshot?.links ?? []
            },
            maxChars
          )
        : (extracted.content ?? '').slice(0, maxChars);
    return { ...page, content, selector, format };
  }

  async state(): Promise<BrowserPageState> {
    return this.stateFrom(this.getTargetWebContents());
  }

  async close(): Promise<void> {
    const shared = this.resolveSharedWebContents();
    if (shared) {
      await shared.loadURL('about:blank');
      return;
    }
    if (!this.window || this.window.isDestroyed()) {
      this.window = null;
      return;
    }
    this.window.close();
    this.window = null;
  }

  private ensureWindow(): BrowserWindow {
    if (!app.isReady()) throw new Error('Electron app is not ready yet.');
    if (this.window && !this.window.isDestroyed()) return this.window;
    const appIconPath = resolveAppWindowIconPath();
    const win = new BrowserWindow({
      show: false,
      width: 1280,
      height: 900,
      ...(appIconPath ? { icon: appIconPath } : {}),
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        partition: this.partition,
        backgroundThrottling: false
      }
    });
    win.on('closed', () => {
      this.window = null;
    });
    this.window = win;
    return win;
  }

  private getTargetWebContents(): WebContents {
    return this.resolveSharedWebContents() ?? this.ensureWindow().webContents;
  }

  private resolveSharedWebContents(): WebContents | null {
    try {
      const wc = this.sharedWebContentsResolver?.();
      if (!wc || wc.isDestroyed()) return null;
      return wc;
    } catch {
      return null;
    }
  }

  private stateFrom(wc: WebContents): BrowserPageState {
    return {
      url: wc.getURL() || 'about:blank',
      title: wc.getTitle() || ''
    };
  }

  private async evalInPage<T>(script: string): Promise<T> {
    const wc = this.getTargetWebContents();
    if (wc.isLoadingMainFrame()) {
      await this.waitForIdle(DEFAULT_TIMEOUT_MS, wc).catch(() => {});
    }
    return wc.executeJavaScript(script, true) as Promise<T>;
  }

  private async waitForIdle(timeoutMs: number, wc: WebContents): Promise<void> {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      if (wc.isDestroyed()) throw new Error('Embedded browser target was destroyed.');
      if (!wc.isLoadingMainFrame() && !wc.isWaitingForResponse()) {
        await sleep(100);
        if (!wc.isLoadingMainFrame() && !wc.isWaitingForResponse()) return;
      }
      await sleep(100);
    }
    throw new Error(`Page did not finish loading within ${timeoutMs} ms.`);
  }
}
