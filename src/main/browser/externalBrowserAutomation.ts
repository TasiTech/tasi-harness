import type {
  BrowserAutomation,
  BrowserBinaryResult,
  BrowserClickResult,
  BrowserCookieResult,
  BrowserDiagnosticsResult,
  BrowserExtractResult,
  BrowserFindOptions,
  BrowserFindResult,
  BrowserPageState,
  BrowserSnapshotElement,
  BrowserSnapshotResult,
  BrowserStorageResult
} from '../tools/browserAutomation.js';
import type { AppConfig } from '../../shared/types.js';
import { ExternalBrowserBridge } from './externalBrowserBridge.js';
import type { BrowserExecutionLogger } from './browserExecutionLogger.js';

const DEFAULT_TIMEOUT_MS = 20000;
const DEFAULT_EXTRACT_MAX_CHARS = 8000;
const DEFAULT_SNAPSHOT_MAX_ELEMENTS = 0;
const DEFAULT_SNAPSHOT_MAX_CHARS = 100000;

interface CdpTargetInfo {
  id: string;
  type: string;
  url: string;
  title: string;
  webSocketDebuggerUrl?: string;
}

interface CdpEvaluateResult {
  result?: {
    type?: string;
    value?: unknown;
    unserializableValue?: string;
    description?: string;
  };
  exceptionDetails?: {
    text?: string;
    exception?: {
      description?: string;
      value?: unknown;
    };
  };
}

interface CdpAxNode {
  nodeId: string;
  ignored?: boolean;
  role?: { value?: string };
  name?: { value?: string };
  value?: { value?: unknown };
  description?: { value?: string };
  childIds?: string[];
  properties?: Array<{ name: string; value?: { value?: unknown } }>;
}

interface CdpSession {
  target: CdpTargetInfo;
}

interface BrowserExtractJsonLink {
  text: string;
  href: string;
}

interface ClickPageSnapshot {
  textLength: number;
  textDigest: string;
  element?: BrowserClickResult['element'];
}

interface ClickDispatchResult {
  ok: boolean;
  error?: string;
  element?: BrowserClickResult['element'];
  windowOpenCalls?: Array<{ url: string; target?: string }>;
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

function withScheme(url: string, fallbackScheme: 'http' | 'ws'): string {
  const value = url.trim();
  if (!value) return fallbackScheme === 'http' ? 'http://127.0.0.1:9222' : '';
  if (/^[a-zA-Z][a-zA-Z\d+\-.]*:\/\//.test(value)) return value.replace(/\/+$/, '');
  return `${fallbackScheme}://${value}`.replace(/\/+$/, '');
}

function endpointRoot(endpoint: string): string {
  const normalized = withScheme(endpoint, 'http');
  return normalized.endsWith('/json/version') ? normalized.slice(0, -'/json/version'.length) : normalized.replace(/\/+$/, '');
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

function clickObservationNote(result: BrowserClickResult): string {
  const observation = result.observation;
  if (!observation) return 'Click events were dispatched.';
  if (observation.currentPageNavigationDetected) return 'Click events were dispatched and current-page navigation was detected.';
  if ((observation.newTargets?.length ?? 0) > 0) return 'Click events were dispatched and a new browser target/window was detected.';
  if ((observation.windowOpenCalls?.length ?? 0) > 0) return 'Click events were dispatched and window.open was called.';
  if (observation.domTextChanged) return 'Click events were dispatched; URL/title stayed the same, but visible page text changed.';
  return 'Click events were dispatched, but no current-page navigation or visible text change was detected.';
}

async function readMessageData(data: unknown): Promise<string> {
  if (typeof data === 'string') return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8');
  if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString('utf8');
  if (typeof Blob !== 'undefined' && data instanceof Blob) return data.text();
  return String(data ?? '');
}

function normalizeKey(input: string): { key: string; code: string; modifiers: number } {
  const parts = input.split('+').map((part) => part.trim()).filter(Boolean);
  let modifiers = 0;
  const key = parts.pop() || input;
  for (const part of parts) {
    const lowered = part.toLowerCase();
    if (lowered === 'alt' || lowered === 'option') modifiers |= 1;
    else if (lowered === 'ctrl' || lowered === 'control') modifiers |= 2;
    else if (lowered === 'meta' || lowered === 'cmd' || lowered === 'command') modifiers |= 4;
    else if (lowered === 'shift') modifiers |= 8;
  }
  return { key: key.length === 1 ? key : key, code: key.length === 1 ? `Key${key.toUpperCase()}` : key, modifiers };
}

function serializeBrowserExtractJson(payload: {
  browser_preview_url: string;
  url: string;
  title: string;
  selector?: string;
  text: string;
  headings: string[];
  links: BrowserExtractJsonLink[];
}, maxChars: number): string {
  const normalized = {
    tool: 'browser_extract',
    format: 'json',
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
  const text = JSON.stringify(normalized, null, 2);
  return clipWithMarker(text, maxChars);
}

function formatSnapshotTree(nodes: unknown[]): string {
  const lines: string[] = [];
  for (const raw of nodes) {
    const node = raw as { depth?: number; role?: string; name?: string; ref?: string; state?: string; value?: string; href?: string };
    const depth = Number.isFinite(Number(node.depth)) ? Math.max(0, Number(node.depth)) : 0;
    const parts = [`${'  '.repeat(depth)}- ${node.role || 'generic'}`];
    if (node.name) parts.push(`"${node.name}"`);
    if (node.ref) parts.push(`[${node.ref}]`);
    if (node.state) parts.push(`(${node.state})`);
    if (node.value) parts.push(`value="${node.value}"`);
    if (node.href) parts.push(`href=${node.href}`);
    lines.push(parts.join(' '));
  }
  return lines.join('\n');
}

function pageHelpers(): string {
  return `
    const TasiBrowser = (() => {
      const normalizeText = (value) => String(value || "")
        .replace(/\\u00a0/g, " ")
        .replace(/[ \\t]+/g, " ")
        .replace(/\\n{3,}/g, "\\n\\n")
        .trim();
      const isVisible = (el) => {
        if (!el || !(el instanceof Element)) return false;
        const style = window.getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0;
      };
      const cssEscape = (value) => {
        if (window.CSS && typeof window.CSS.escape === "function") return window.CSS.escape(String(value));
        return String(value).replace(/["\\\\]/g, "\\\\$&");
      };
      const nthOfType = (el) => {
        let index = 1;
        let sibling = el;
        while ((sibling = sibling.previousElementSibling)) {
          if (sibling.tagName === el.tagName) index += 1;
        }
        return index;
      };
      const selectorFor = (el) => {
        if (!(el instanceof Element)) return "";
        const attrPrefs = ["data-testid", "data-test", "data-cy", "aria-label", "name", "placeholder", "title", "alt"];
        if (el.id) return "#" + cssEscape(el.id);
        for (const attr of attrPrefs) {
          const raw = el.getAttribute(attr);
          if (!raw) continue;
          const selector = el.tagName.toLowerCase() + "[" + attr + "=\\"" + cssEscape(raw) + "\\"]";
          try {
            if (document.querySelectorAll(selector).length === 1) return selector;
          } catch {}
        }
        const parts = [];
        let node = el;
        while (node && node.nodeType === 1 && node !== document.body && parts.length < 5) {
          const tag = node.tagName.toLowerCase();
          parts.unshift(tag + ":nth-of-type(" + nthOfType(node) + ")");
          node = node.parentElement;
        }
        return parts.length ? "body > " + parts.join(" > ") : el.tagName.toLowerCase();
      };
      const roleFor = (el) => {
        const explicit = el.getAttribute("role");
        if (explicit) return explicit;
        const tag = el.tagName.toLowerCase();
        const type = (el.getAttribute("type") || "").toLowerCase();
        if (tag === "a") return "link";
        if (tag === "button" || type === "button" || type === "submit" || type === "reset") return "button";
        if (tag === "input" && type === "checkbox") return "checkbox";
        if (tag === "input" && type === "radio") return "radio";
        if (tag === "select") return "combobox";
        if (tag === "textarea" || tag === "input") return "textbox";
        if (/^h[1-6]$/.test(tag)) return "heading";
        if (tag === "img") return "img";
        if (tag === "form") return "form";
        return tag;
      };
      const looksClickable = (el) => {
        if (!(el instanceof Element)) return false;
        const tag = el.tagName.toLowerCase();
        if (["a", "button", "summary"].includes(tag)) return true;
        const role = (el.getAttribute("role") || "").toLowerCase();
        if (["button", "link", "menuitem", "tab", "option", "checkbox", "radio", "switch"].includes(role)) return true;
        if (el.hasAttribute("onclick")) return true;
        if (el.hasAttribute("data-href") || el.hasAttribute("data-url") || el.hasAttribute("data-link") || el.hasAttribute("data-route")) return true;
        const tabindex = el.getAttribute("tabindex");
        if (tabindex !== null && Number(tabindex) >= 0) return true;
        const classAndId = String(el.className || "") + " " + String(el.id || "");
        if (/(^|[-_\\s])(btn|button|link|click|clickable|card|item|tile|result|guide|poi|sight|gsl)([-_\\s]|$)/i.test(classAndId)) return true;
        try {
          if (window.getComputedStyle(el).cursor === "pointer") return true;
        } catch {}
        return false;
      };
      const labelFor = (el) => {
        if (!(el instanceof Element)) return "";
        if (el.id) {
          const label = document.querySelector("label[for=\\"" + cssEscape(el.id) + "\\"]");
          if (label) return normalizeText(label.innerText || label.textContent || "");
        }
        const parentLabel = el.closest("label");
        if (parentLabel) return normalizeText(parentLabel.innerText || parentLabel.textContent || "");
        return "";
      };
      const nameFor = (el) => {
        const labelledBy = el.getAttribute("aria-labelledby");
        if (labelledBy) {
          const text = labelledBy.split(/\\s+/g).map((id) => document.getElementById(id)).filter(Boolean)
            .map((node) => normalizeText(node.innerText || node.textContent || "")).filter(Boolean).join(" ");
          if (text) return text;
        }
        return normalizeText(
          el.getAttribute("aria-label") ||
          labelFor(el) ||
          el.getAttribute("alt") ||
          el.getAttribute("title") ||
          el.getAttribute("placeholder") ||
          el.innerText ||
          el.textContent ||
          el.getAttribute("value") ||
          ""
        );
      };
      const clip = (value, max) => {
        const text = normalizeText(value);
        return text.length > max ? text.slice(0, Math.max(0, max - 15)) + "... [truncated]" : text;
      };
      const describe = (el, ref = "") => {
        const rect = el.getBoundingClientRect();
        const item = {
          ref,
          tag: el.tagName.toLowerCase(),
          role: roleFor(el),
          name: clip(nameFor(el), 220),
          text: clip(normalizeText(el.innerText || el.textContent || ""), 360),
          selector: selectorFor(el),
          visible: isVisible(el),
          enabled: !el.disabled && el.getAttribute("aria-disabled") !== "true",
          box: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) }
        };
        const href = el.getAttribute("href");
        if (href) {
          try { item.href = new URL(href, location.href).toString(); } catch { item.href = href; }
        }
        const target = el.getAttribute("target");
        if (target) item.target = target;
        const onclick = el.getAttribute("onclick");
        if (onclick) item.onclick = clip(onclick, 500);
        if ("value" in el && typeof el.value !== "undefined") item.value = clip(String(el.value || ""), 240);
        const placeholder = el.getAttribute("placeholder");
        if (placeholder) item.placeholder = placeholder;
        const label = labelFor(el);
        if (label) item.label = label;
        if ("checked" in el) item.checked = Boolean(el.checked);
        return item;
      };
      const ensureRefs = () => {
        window.__tasiBrowserRefs = window.__tasiBrowserRefs || {};
        return window.__tasiBrowserRefs;
      };
      const resolve = (selector, index = 0) => {
        const value = String(selector || "").trim();
        if (!value) return { ok: false, error: "selector is required." };
        if (/^@e\\d+$/i.test(value)) {
          const el = ensureRefs()[value];
          return el ? { ok: true, el } : { ok: false, error: "Element ref not found or stale: " + value };
        }
        const nodes = Array.from(document.querySelectorAll(value));
        if (nodes.length === 0) return { ok: false, error: "Selector not found: " + value };
        return { ok: true, el: nodes[Math.min(Math.max(index, 0), nodes.length - 1)] };
      };
      const emitInput = (el) => {
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
      };
      const setText = (el, text, clear = true) => {
        if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
          el.focus();
          if (clear) el.value = "";
          el.value = clear ? text : String(el.value || "") + text;
          emitInput(el);
          return true;
        }
        if (el instanceof HTMLElement && el.isContentEditable) {
          el.focus();
          if (clear) el.textContent = "";
          el.textContent = clear ? text : String(el.textContent || "") + text;
          emitInput(el);
          return true;
        }
        return false;
      };
      const fireMouse = (el, type) => el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
      const activate = (el) => {
        if (el && typeof el.scrollIntoView === "function") el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
        fireMouse(el, "mouseover");
        fireMouse(el, "mousedown");
        fireMouse(el, "mouseup");
        if (typeof el.click === "function") el.click();
      };
      const matchText = (candidate, query, exact) => {
        const left = normalizeText(candidate).toLowerCase();
        const right = normalizeText(query).toLowerCase();
        return exact ? left === right : left.includes(right);
      };
      const candidates = (options) => {
        const by = options.by;
        const value = String(options.value || "");
        let nodes = [];
        if (by === "css") nodes = Array.from(document.querySelectorAll(value));
        else if (by === "role") {
          nodes = Array.from(document.querySelectorAll("a[href],button,input,textarea,select,[role],h1,h2,h3,h4,h5,h6,img,form,[contenteditable=true]"))
            .filter((el) => roleFor(el).toLowerCase() === value.toLowerCase());
          if (options.name) nodes = nodes.filter((el) => matchText(nameFor(el), options.name, Boolean(options.exact)));
        } else if (by === "text") {
          nodes = Array.from(document.querySelectorAll("a,button,label,input,textarea,select,[role],h1,h2,h3,h4,h5,h6,p,li,td,th,summary,[contenteditable=true]"))
            .filter((el) => matchText(el.innerText || el.textContent || el.getAttribute("value") || "", value, Boolean(options.exact)));
        } else if (by === "label") {
          nodes = Array.from(document.querySelectorAll("input,textarea,select,button,[contenteditable=true]"))
            .filter((el) => matchText(labelFor(el), value, Boolean(options.exact)));
        } else if (by === "placeholder") {
          nodes = Array.from(document.querySelectorAll("[placeholder]"))
            .filter((el) => matchText(el.getAttribute("placeholder") || "", value, Boolean(options.exact)));
        } else if (by === "alt") {
          nodes = Array.from(document.querySelectorAll("[alt]"))
            .filter((el) => matchText(el.getAttribute("alt") || "", value, Boolean(options.exact)));
        } else if (by === "title") {
          nodes = Array.from(document.querySelectorAll("[title]"))
            .filter((el) => matchText(el.getAttribute("title") || "", value, Boolean(options.exact)));
        } else if (by === "testid") {
          nodes = Array.from(document.querySelectorAll("[data-testid],[data-test],[data-cy]"))
            .filter((el) => [el.getAttribute("data-testid"), el.getAttribute("data-test"), el.getAttribute("data-cy")].some((item) => matchText(item || "", value, true)));
        }
        return nodes;
      };
      return { normalizeText, isVisible, selectorFor, roleFor, looksClickable, labelFor, nameFor, describe, ensureRefs, resolve, setText, activate, fireMouse, candidates };
    })();
  `;
}

export class ExternalBrowserAutomation implements BrowserAutomation {
  private messageId = 0;

  constructor(
    private readonly bridge: ExternalBrowserBridge,
    private readonly getConfig: () => AppConfig,
    private readonly logger?: BrowserExecutionLogger
  ) {}

  async open(url: string, options?: { timeoutMs?: number }): Promise<BrowserPageState> {
    const target = normalizeUrl(url);
    const config = { ...this.getConfig(), externalBrowserEngine: 'cdp' as const };
    this.log('automation.open.start', {
      url: target,
      timeoutMs: options?.timeoutMs,
      endpoint: config.externalBrowserCdpEndpoint,
      profileMode: config.externalBrowserProfileMode,
      headless: config.browserHeadless
    });
    const result = await this.bridge.open(target, config);
    if (!result.ok) throw new Error(result.content);
    await this.waitForIdle(clampInt(Number(options?.timeoutMs), DEFAULT_TIMEOUT_MS, 1000, 120000));
    await this.installPageErrorCapture().catch(() => {});
    const state = await this.state();
    await this.logStorageDiagnostics(state.url);
    this.log('automation.open.done', { url: state.url, title: state.title });
    return state;
  }

  async click(selector: string, options?: { index?: number; waitForNavigation?: boolean; timeoutMs?: number; observeMs?: number }): Promise<BrowserClickResult> {
    const observeMs = clampInt(Number(options?.observeMs), options?.waitForNavigation ? 150 : 500, 0, 5000);
    const index = clampInt(Number(options?.index), 0, 0, 9999);
    const sel = selector.trim();
    if (!sel) throw new Error('selector is required.');
    const before = await this.state();
    const beforeTargets = await this.listPageTargets().catch(() => []);
    const beforeSnapshot = await this.captureClickPageSnapshot(sel, index).catch(() => null);
    const result = await this.dispatchClick(sel, index);
    if (!result.ok) throw new Error(result.error || `Failed to click selector: ${sel}`);
    if (options?.waitForNavigation) await this.waitForIdle(clampInt(Number(options.timeoutMs), DEFAULT_TIMEOUT_MS, 1000, 120000));
    else if (observeMs > 0) await sleep(observeMs);
    const after = await this.state();
    const afterTargets = await this.listPageTargets().catch(() => []);
    const afterSnapshot = await this.captureClickPageSnapshot(sel, index).catch(() => null);
    return this.buildClickResult(sel, index, before, after, beforeSnapshot, afterSnapshot, result, beforeTargets, afterTargets);
  }

  async type(selector: string, text: string, options?: { clear?: boolean; submit?: boolean }): Promise<BrowserPageState> {
    const sel = selector.trim();
    if (!sel) throw new Error('selector is required.');
    const result = await this.evalInPage<{ ok: boolean; error?: string }>(
      `(function () {
        ${pageHelpers()}
        const found = TasiBrowser.resolve(${JSON.stringify(sel)}, 0);
        if (!found.ok) return found;
        const el = found.el;
        const editable = el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || (el instanceof HTMLElement && el.isContentEditable);
        if (!editable) {
          return { ok: false, error: "Target is not an input, textarea, or contenteditable element." };
        }
        if (typeof el.focus === "function") el.focus();
        if (${options?.clear === false ? 'false' : 'true'} && typeof el.select === "function") {
          el.select();
        } else if ("setSelectionRange" in el && typeof el.value === "string") {
          const end = el.value.length;
          try { el.setSelectionRange(end, end); } catch {}
        }
        return { ok: true };
      })();`
    );
    if (!result.ok) throw new Error(result.error || `Failed to type into selector: ${sel}`);
    if (options?.clear !== false) {
      await this.cdpCommand('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', modifiers: 2 });
      await this.cdpCommand('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', modifiers: 2 });
      await this.cdpCommand('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Backspace', code: 'Backspace', modifiers: 0 });
      await this.cdpCommand('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Backspace', code: 'Backspace', modifiers: 0 });
    }
    if (text) await this.cdpCommand('Input.insertText', { text });
    if (options?.submit === true) {
      await this.cdpCommand('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', modifiers: 0 });
      await this.cdpCommand('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', modifiers: 0 });
    }
    return this.state();
  }

  async scroll(options?: { direction?: 'up' | 'down' | 'left' | 'right' | 'top' | 'bottom'; amount?: number; selector?: string }): Promise<BrowserPageState> {
    const direction = options?.direction ?? 'down';
    const amount = clampInt(Number(options?.amount), 800, 20, 10000);
    const selector = options?.selector?.trim() || '';
    await this.evalInPage(
      `(function () {
        ${pageHelpers()}
        const direction = ${JSON.stringify(direction)};
        const amount = ${amount};
        const selector = ${JSON.stringify(selector)};
        let target = window;
        if (selector) {
          const found = TasiBrowser.resolve(selector, 0);
          if (!found.ok) throw new Error(found.error);
          target = found.el;
        }
        const scrollToTarget = (left, top) => target === window ? window.scrollTo({ left, top, behavior: "instant" }) : target.scrollTo({ left, top, behavior: "instant" });
        const scrollByTarget = (left, top) => target === window ? window.scrollBy({ left, top, behavior: "instant" }) : target.scrollBy({ left, top, behavior: "instant" });
        const maxTop = target === window ? document.body.scrollHeight : target.scrollHeight;
        if (direction === "top") scrollToTarget(0, 0);
        else if (direction === "bottom") scrollToTarget(0, maxTop);
        else if (direction === "left") scrollByTarget(-amount, 0);
        else if (direction === "right") scrollByTarget(amount, 0);
        else scrollByTarget(0, direction === "up" ? -amount : amount);
      })();`
    );
    return this.state();
  }

  async wait(options?: {
    ms?: number;
    selector?: string;
    text?: string;
    url?: string;
    state?: 'attached' | 'visible' | 'hidden' | 'detached';
    loadState?: 'load' | 'domcontentloaded' | 'networkidle';
    function?: string;
    timeoutMs?: number;
  }): Promise<BrowserPageState> {
    const ms = clampInt(Number(options?.ms), 0, 0, 60000);
    if (ms > 0) await sleep(ms);
    if (options?.loadState) await this.waitForIdle(clampInt(Number(options?.timeoutMs), DEFAULT_TIMEOUT_MS, 250, 120000));
    const selector = options?.selector?.trim() ?? '';
    const text = options?.text?.trim() ?? '';
    const url = options?.url?.trim() ?? '';
    const fn = options?.function?.trim() ?? '';
    if (!selector && !text && !url && !fn) return this.state();
    const wantedState = options?.state ?? 'attached';
    const timeoutMs = clampInt(Number(options?.timeoutMs), DEFAULT_TIMEOUT_MS, 250, 120000);
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      const ok = await this.evalInPage<boolean>(
        `(function () {
          ${pageHelpers()}
          const selector = ${JSON.stringify(selector)};
          const text = ${JSON.stringify(text)};
          const url = ${JSON.stringify(url)};
          const wantedState = ${JSON.stringify(wantedState)};
          const fnSource = ${JSON.stringify(fn)};
          if (selector) {
            const node = document.querySelector(selector);
            if (wantedState === "detached") {
              if (node) return false;
            } else if (!node) return false;
            else if (wantedState === "visible" && !TasiBrowser.isVisible(node)) return false;
            else if (wantedState === "hidden" && TasiBrowser.isVisible(node)) return false;
          }
          if (text && !TasiBrowser.normalizeText(document.body ? document.body.innerText || document.body.textContent || "" : "").includes(text)) return false;
          if (url && !location.href.includes(url)) return false;
          if (fnSource) {
            try {
              if (!Function("return Boolean(" + fnSource + ")")()) return false;
            } catch {
              return false;
            }
          }
          return true;
        })();`
      );
      if (ok) return this.state();
      await sleep(150);
    }
    throw new Error(`Timed out waiting for browser condition after ${timeoutMs} ms.`);
  }

  async extract(options?: { selector?: string; format?: 'html' | 'json'; maxChars?: number }): Promise<BrowserExtractResult> {
    const selector = options?.selector?.trim() || undefined;
    const format = options?.format === 'html' ? 'html' : 'json';
    const maxChars = clampInt(Number(options?.maxChars), DEFAULT_EXTRACT_MAX_CHARS, 200, 100000);
    const extracted = await this.evalInPage<{
      ok: boolean;
      error?: string;
      content?: string;
      snapshot?: { text: string; headings: string[]; links: BrowserExtractJsonLink[] };
    }>(
      `(function () {
        ${pageHelpers()}
        const selector = ${JSON.stringify(selector ?? '')};
        const format = ${JSON.stringify(format)};
        const target = selector ? TasiBrowser.resolve(selector, 0).el : document.body;
        if (!target) return { ok: false, error: "Selector not found: " + selector };
        if (format === "html") return { ok: true, content: target.outerHTML || "" };
        const headings = Array.from(target.querySelectorAll("h1,h2,h3,h4,h5,h6")).slice(0, 20)
          .map((node) => TasiBrowser.normalizeText(node.innerText || node.textContent || "")).filter(Boolean);
        const links = Array.from(target.querySelectorAll("a[href]")).slice(0, 25).map((node) => {
          const rawHref = node.getAttribute("href") || "";
          let href = rawHref;
          try { href = new URL(rawHref, location.href).toString(); } catch {}
          return { text: TasiBrowser.normalizeText(node.innerText || node.textContent || ""), href };
        });
        return {
          ok: true,
          snapshot: {
            text: TasiBrowser.normalizeText(target.innerText || target.textContent || ""),
            headings,
            links
          }
        };
      })();`
    );
    if (!extracted.ok) throw new Error(extracted.error || 'Failed to extract page content.');
    const page = await this.state();
    const content =
      format === 'json'
        ? serializeBrowserExtractJson(
            {
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

  async snapshot(options?: { selector?: string; maxElements?: number; maxChars?: number }): Promise<BrowserSnapshotResult> {
    const selector = options?.selector?.trim() || '';
    const maxElements = Number.isFinite(Number(options?.maxElements)) && Number(options?.maxElements) > 0
      ? clampInt(Number(options?.maxElements), DEFAULT_SNAPSHOT_MAX_ELEMENTS, 1, 50000)
      : 0;
    const maxChars = clampInt(Number(options?.maxChars), DEFAULT_SNAPSHOT_MAX_CHARS, 1000, 1000000);
    const domRaw = await this.evalInPage<Omit<BrowserSnapshotResult, 'url' | 'title' | 'content'>>(
      `(function () {
        ${pageHelpers()}
        const selector = ${JSON.stringify(selector)};
        const maxElements = ${maxElements};
        const refs = TasiBrowser.ensureRefs();
        for (const key of Object.keys(refs)) delete refs[key];
        const scope = selector ? TasiBrowser.resolve(selector, 0).el : document.body;
        if (!scope) throw new Error("Selector not found: " + selector);
        const elementSelector = [
          "a", "button", "input", "textarea", "select", "option", "summary",
          "[role]", "[tabindex]", "[contenteditable=true]", "label", "h1", "h2", "h3", "h4", "h5", "h6",
          "img[alt]", "[data-testid]", "[data-test]", "[data-cy]", "[onclick]", "[data-href]", "[data-url]", "[data-link]", "[data-route]",
          "[class*='guide-main-item']", "[class*='gsl-common-card']",
          "main", "nav", "header", "footer", "section", "article", "aside", "form", "dialog", "ul", "ol", "li", "table", "tr", "th", "td"
        ].join(",");
        const candidates = Array.from(scope.querySelectorAll(elementSelector))
          .filter((el) => TasiBrowser.isVisible(el) || TasiBrowser.looksClickable(el) || ["input", "textarea", "select", "option"].includes(el.tagName.toLowerCase()));
        const snapshotRank = (el) => {
          const rect = el.getBoundingClientRect();
          const tag = el.tagName.toLowerCase();
          const chrome = el.closest("nav,header,footer,[role=navigation],[role=banner],[role=contentinfo]") ? 1000000 : 0;
          const hidden = rect.width <= 0 || rect.height <= 0 ? 500000 : 0;
          const inViewport = rect.bottom >= 0 && rect.top <= window.innerHeight && rect.right >= 0 && rect.left <= window.innerWidth ? 0 : 200000;
          const fieldBonus = ["input", "textarea", "select"].includes(tag) ? -2000 : 0;
          const resultish = /result|search|list|card|item|poi|sight|景点|搜索|结果/i.test((el.className || "") + " " + (el.id || "") + " " + (el.getAttribute("aria-label") || "")) ? -1000 : 0;
          return chrome + hidden + inViewport + fieldBonus + resultish + Math.max(0, rect.top) + Math.max(0, rect.left) / 1000;
        };
        candidates.sort((left, right) => snapshotRank(left) - snapshotRank(right));
        const elements = [];
        const elementToRef = new Map();
        let nextRef = 1;
        for (const el of candidates) {
          if (maxElements > 0 && elements.length >= maxElements) break;
          const ref = "@e" + nextRef++;
          refs[ref] = el;
          elementToRef.set(el, ref);
          elements.push(TasiBrowser.describe(el, ref));
        }
        const headings = Array.from(scope.querySelectorAll("h1,h2,h3,h4,h5,h6")).map((el) => ({
          level: Number(el.tagName.slice(1)),
          text: TasiBrowser.normalizeText(el.innerText || el.textContent || ""),
          ref: elementToRef.get(el)
        })).filter((item) => item.text);
        const links = Array.from(scope.querySelectorAll("a[href]")).sort((left, right) => snapshotRank(left) - snapshotRank(right)).map((el) => {
          let href = el.getAttribute("href") || "";
          try { href = new URL(href, location.href).toString(); } catch {}
          const item = { text: TasiBrowser.normalizeText(el.innerText || el.textContent || ""), href };
          const ref = elementToRef.get(el);
          if (ref) item.ref = ref;
          return item;
        }).filter((item) => item.href);
        const images = Array.from(scope.querySelectorAll("img")).map((el) => ({
          alt: el.getAttribute("alt") || "",
          src: el.currentSrc || el.src || "",
          ref: elementToRef.get(el)
        })).filter((item) => item.src || item.alt);
        return {
          elements,
          headings,
          links,
          images,
          viewport: { width: window.innerWidth, height: window.innerHeight, scrollX: window.scrollX, scrollY: window.scrollY },
          truncated: maxElements > 0 && candidates.length > elements.length
        };
      })();`
    );
    const axRaw = selector
      ? null
      : await this.buildAccessibilitySnapshot(maxElements, domRaw.elements).catch(() => null);
    const raw = axRaw
      ? {
          ...domRaw,
          source: 'accessibility' as const,
          tree: axRaw.tree,
          truncated: domRaw.truncated || axRaw.truncated
        }
      : {
          ...domRaw,
          source: 'semantic-dom' as const,
          tree: this.semanticTreeFromElements(domRaw.elements)
        };
    const page = await this.state();
    const snapshotText = formatSnapshotTree(raw.tree ?? []);
    const payload = { tool: 'browser_snapshot', browser_preview_url: page.url, ...page, selector: selector || undefined, snapshot: snapshotText, ...raw };
    const serialized = JSON.stringify(payload, null, 2);
    const content = clipWithMarker(serialized, maxChars);
    return { ...page, ...raw, content, truncated: raw.truncated || content.length < serialized.length };
  }

  async find(options: BrowserFindOptions): Promise<BrowserFindResult> {
    const action = options.action ?? 'snapshot';
    const index = clampInt(Number(options.index), 0, 0, 9999);
    const result = await this.evalInPage<{ ok: boolean; error?: string; ref?: string; selector?: string; text?: string; element?: BrowserSnapshotElement }>(
      `(function () {
        ${pageHelpers()}
        const options = ${JSON.stringify({ ...options, action, index })};
        const nodes = TasiBrowser.candidates(options);
        if (nodes.length === 0) return { ok: false, error: "No element found for " + options.by + ": " + options.value };
        const el = nodes[Math.min(options.index || 0, nodes.length - 1)];
        if (typeof el.scrollIntoView === "function") el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
        const refs = TasiBrowser.ensureRefs();
        const ref = "@e1";
        refs[ref] = el;
        const element = TasiBrowser.describe(el, ref);
        if (options.action === "click") TasiBrowser.activate(el);
        else if (options.action === "type" || options.action === "fill") {
          if (!TasiBrowser.setText(el, String(options.text || ""), options.action !== "type")) return { ok: false, error: "Target is not text-editable." };
        } else if (options.action === "focus") {
          if (typeof el.focus === "function") el.focus();
        } else if (options.action === "hover") {
          TasiBrowser.fireMouse(el, "mouseover");
          TasiBrowser.fireMouse(el, "mousemove");
        } else if (options.action === "check" || options.action === "uncheck") {
          if (!("checked" in el)) return { ok: false, error: "Target is not checkable." };
          const wanted = options.action === "check";
          if (Boolean(el.checked) !== wanted) TasiBrowser.activate(el);
        } else if (options.action === "select") {
          if (!(el instanceof HTMLSelectElement)) return { ok: false, error: "Target is not a select element." };
          el.value = String(options.text || "");
          el.dispatchEvent(new Event("change", { bubbles: true }));
        }
        return { ok: true, ref, selector: element.selector, text: TasiBrowser.normalizeText(el.innerText || el.textContent || el.value || ""), element };
      })();`
    );
    if (!result.ok) throw new Error(result.error || 'Find failed.');
    if (options.waitForNavigation) await this.waitForIdle(clampInt(Number(options.timeoutMs), DEFAULT_TIMEOUT_MS, 1000, 120000));
    return { ...(await this.state()), ref: result.ref, selector: result.selector, text: result.text, element: result.element };
  }

  async hover(selector: string, options?: { index?: number }): Promise<BrowserPageState> {
    await this.evalInPage(
      `(function () {
        ${pageHelpers()}
        const found = TasiBrowser.resolve(${JSON.stringify(selector.trim())}, ${clampInt(Number(options?.index), 0, 0, 9999)});
        if (!found.ok) throw new Error(found.error);
        if (typeof found.el.scrollIntoView === "function") found.el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
        TasiBrowser.fireMouse(found.el, "mouseover");
        TasiBrowser.fireMouse(found.el, "mousemove");
      })();`
    );
    return this.state();
  }

  async select(selector: string, value: string, options?: { index?: number }): Promise<BrowserPageState> {
    await this.evalInPage(
      `(function () {
        ${pageHelpers()}
        const found = TasiBrowser.resolve(${JSON.stringify(selector.trim())}, ${clampInt(Number(options?.index), 0, 0, 9999)});
        if (!found.ok) throw new Error(found.error);
        const el = found.el;
        if (!(el instanceof HTMLSelectElement)) throw new Error("Target is not a select element.");
        el.value = ${JSON.stringify(value)};
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
      })();`
    );
    return this.state();
  }

  async check(selector: string, checked: boolean, options?: { index?: number }): Promise<BrowserPageState> {
    await this.evalInPage(
      `(function () {
        ${pageHelpers()}
        const found = TasiBrowser.resolve(${JSON.stringify(selector.trim())}, ${clampInt(Number(options?.index), 0, 0, 9999)});
        if (!found.ok) throw new Error(found.error);
        const el = found.el;
        if (!("checked" in el)) throw new Error("Target is not checkable.");
        if (Boolean(el.checked) !== ${checked ? 'true' : 'false'}) TasiBrowser.activate(el);
      })();`
    );
    return this.state();
  }

  async press(key: string, options?: { selector?: string; text?: string }): Promise<BrowserPageState> {
    const selector = options?.selector?.trim() || '';
    if (selector) {
      await this.evalInPage(
        `(function () {
          ${pageHelpers()}
          const found = TasiBrowser.resolve(${JSON.stringify(selector)}, 0);
          if (!found.ok) throw new Error(found.error);
          if (typeof found.el.focus === "function") found.el.focus();
        })();`
      );
    }
    if (typeof options?.text === 'string') {
      await this.cdpCommand('Input.insertText', { text: options.text });
      return this.state();
    }
    const normalized = normalizeKey(key.trim());
    await this.cdpCommand('Input.dispatchKeyEvent', { type: 'keyDown', key: normalized.key, code: normalized.code, modifiers: normalized.modifiers });
    await this.cdpCommand('Input.dispatchKeyEvent', { type: 'keyUp', key: normalized.key, code: normalized.code, modifiers: normalized.modifiers });
    return this.state();
  }

  async screenshot(): Promise<BrowserBinaryResult> {
    const result = await this.cdpCommand('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    const data = typeof result.data === 'string' ? Buffer.from(result.data, 'base64') : Buffer.alloc(0);
    return { ...(await this.state()), data, mimeType: 'image/png', extension: 'png' };
  }

  async pdf(): Promise<BrowserBinaryResult> {
    const result = await this.cdpCommand('Page.printToPDF', { printBackground: true });
    const data = typeof result.data === 'string' ? Buffer.from(result.data, 'base64') : Buffer.alloc(0);
    return { ...(await this.state()), data, mimeType: 'application/pdf', extension: 'pdf' };
  }

  async storage(options?: { area?: 'local' | 'session'; action?: 'get' | 'set' | 'clear'; key?: string; value?: string }): Promise<BrowserStorageResult> {
    const area = options?.area === 'session' ? 'session' : 'local';
    const action = options?.action ?? 'get';
    const key = options?.key?.trim() ?? '';
    const value = options?.value ?? '';
    const content = await this.evalInPage<string>(
      `(function () {
        const store = ${JSON.stringify(area)} === "session" ? window.sessionStorage : window.localStorage;
        const action = ${JSON.stringify(action)};
        const key = ${JSON.stringify(key)};
        const value = ${JSON.stringify(value)};
        if (action === "clear") {
          store.clear();
          return JSON.stringify({ cleared: true }, null, 2);
        }
        if (action === "set") {
          if (!key) throw new Error("key is required for storage set.");
          store.setItem(key, value);
          return JSON.stringify({ [key]: value }, null, 2);
        }
        if (key) return JSON.stringify({ [key]: store.getItem(key) }, null, 2);
        const out = {};
        for (let i = 0; i < store.length; i += 1) {
          const itemKey = store.key(i);
          if (itemKey) out[itemKey] = store.getItem(itemKey);
        }
        return JSON.stringify(out, null, 2);
      })();`
    );
    return { ...(await this.state()), area, content };
  }

  async cookies(options?: { action?: 'get' | 'set' | 'clear'; name?: string; value?: string; url?: string; domain?: string; path?: string }): Promise<BrowserCookieResult> {
    const page = await this.state();
    const action = options?.action ?? 'get';
    const url = options?.url?.trim() || page.url;
    if (action === 'clear') {
      const cookies = await this.cdpCommand('Network.getCookies', { urls: [url] });
      const items = Array.isArray(cookies.cookies) ? cookies.cookies : [];
      for (const cookie of items) {
        const name = typeof cookie.name === 'string' ? cookie.name : '';
        if (name) await this.cdpCommand('Network.deleteCookies', { name, url });
      }
      return { ...page, content: JSON.stringify({ cleared: items.length }, null, 2) };
    }
    if (action === 'set') {
      const name = options?.name?.trim();
      if (!name) throw new Error('name is required for cookie set.');
      await this.cdpCommand('Network.setCookie', {
        url,
        name,
        value: options?.value ?? '',
        ...(options?.domain ? { domain: options.domain } : {}),
        path: options?.path || '/'
      });
    }
    const cookies = await this.cdpCommand('Network.getCookies', { urls: [url] });
    this.logCookieDiagnostics(url, cookies.cookies);
    return { ...(await this.state()), content: JSON.stringify(cookies.cookies ?? [], null, 2) };
  }

  async console(options?: { level?: 'all' | 'log' | 'info' | 'warning' | 'error'; clear?: boolean; maxItems?: number }): Promise<BrowserDiagnosticsResult> {
    const maxItems = clampInt(Number(options?.maxItems), 100, 1, 1000);
    if (options?.clear) {
      await this.evalInPage('(window.__tasiBrowserPageErrors = [], window.__tasiBrowserConsole = [], true);').catch(() => {});
    }
    const content = await this.evalInPage<string>(
      `(function () {
        window.__tasiBrowserPageErrors = window.__tasiBrowserPageErrors || [];
        window.__tasiBrowserConsole = window.__tasiBrowserConsole || [];
        const level = ${JSON.stringify(options?.level ?? 'all')};
        const entries = window.__tasiBrowserConsole.concat(window.__tasiBrowserPageErrors)
          .filter((entry) => level === "all" || entry.level === level)
          .slice(-${maxItems});
        return JSON.stringify(entries, null, 2);
      })();`
    );
    return { ...(await this.state()), content };
  }

  async network(options?: { filter?: string; type?: string; maxItems?: number; clear?: boolean }): Promise<BrowserDiagnosticsResult> {
    const maxItems = clampInt(Number(options?.maxItems), 100, 1, 1000);
    if (options?.clear) await this.evalInPage('performance.clearResourceTimings();').catch(() => {});
    const entries = await this.evalInPage<Array<Record<string, unknown>>>(
      `(function () {
        return performance.getEntriesByType("resource").concat(performance.getEntriesByType("navigation")).map((entry) => ({
          name: entry.name,
          type: entry.initiatorType || entry.entryType,
          startTime: Math.round(entry.startTime),
          duration: Math.round(entry.duration),
          transferSize: entry.transferSize,
          encodedBodySize: entry.encodedBodySize,
          decodedBodySize: entry.decodedBodySize
        }));
      })();`
    );
    const filter = options?.filter?.toLowerCase().trim() || '';
    const type = options?.type?.toLowerCase().trim() || '';
    const filtered = entries
      .filter((entry) => !filter || String(entry.name ?? '').toLowerCase().includes(filter))
      .filter((entry) => !type || type.split(',').map((item) => item.trim()).includes(String(entry.type ?? '').toLowerCase()))
      .slice(-maxItems);
    return { ...(await this.state()), content: JSON.stringify(filtered, null, 2) };
  }

  async evaluate(script: string, options?: { maxChars?: number }): Promise<BrowserDiagnosticsResult> {
    const source = script.trim();
    if (!source) throw new Error('script is required.');
    const maxChars = clampInt(Number(options?.maxChars), 8000, 200, 100000);
    const value = await this.evalInPage<unknown>(
      `(async function () {
        return await (async () => { return (${source}); })();
      })();`
    );
    const content = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
    return { ...(await this.state()), content: clipWithMarker(content ?? String(value), maxChars) };
  }

  async setViewport(options: { width: number; height: number; scale?: number }): Promise<BrowserPageState> {
    const width = clampInt(Number(options.width), 1280, 320, 3840);
    const height = clampInt(Number(options.height), 900, 240, 2400);
    const scale = Number.isFinite(Number(options.scale)) ? Math.max(0.25, Math.min(4, Number(options.scale))) : 1;
    await this.cdpCommand('Emulation.setDeviceMetricsOverride', {
      width,
      height,
      deviceScaleFactor: scale,
      mobile: false
    });
    return this.state();
  }

  async state(): Promise<BrowserPageState> {
    const session = await this.resolveSession();
    return { url: session.target.url || 'about:blank', title: session.target.title || '' };
  }

  async close(): Promise<void> {
    await this.bridge.close();
  }

  private async captureClickPageSnapshot(selector: string, index: number): Promise<ClickPageSnapshot> {
    return this.evalInPage<ClickPageSnapshot>(
      `(function () {
        ${pageHelpers()}
        const text = TasiBrowser.normalizeText((document.body && document.body.innerText) || (document.documentElement && document.documentElement.textContent) || "");
        let hash = 0;
        for (let i = 0; i < Math.min(text.length, 50000); i += 1) {
          hash = ((hash * 31) + text.charCodeAt(i)) >>> 0;
        }
        const found = TasiBrowser.resolve(${JSON.stringify(selector)}, ${index});
        return {
          textLength: text.length,
          textDigest: String(hash),
          element: found.ok ? TasiBrowser.describe(found.el) : undefined
        };
      })();`
    );
  }

  private async dispatchClick(selector: string, index: number): Promise<ClickDispatchResult> {
    return this.evalInPage<ClickDispatchResult>(
      `(function () {
        ${pageHelpers()}
        const found = TasiBrowser.resolve(${JSON.stringify(selector)}, ${index});
        if (!found.ok) return found;
        const calls = [];
        const originalOpen = window.open;
        window.open = function (url, target, features) {
          calls.push({ url: String(url || ""), target: target == null ? undefined : String(target) });
          return originalOpen.apply(window, arguments);
        };
        try {
          TasiBrowser.activate(found.el);
          return { ok: true, element: TasiBrowser.describe(found.el), windowOpenCalls: calls };
        } finally {
          window.open = originalOpen;
        }
      })();`
    );
  }

  private buildClickResult(
    selector: string,
    index: number,
    before: BrowserPageState,
    after: BrowserPageState,
    beforeSnapshot: ClickPageSnapshot | null,
    afterSnapshot: ClickPageSnapshot | null,
    dispatch: ClickDispatchResult,
    beforeTargets: CdpTargetInfo[],
    afterTargets: CdpTargetInfo[]
  ): BrowserClickResult {
    const urlChanged = before.url !== after.url;
    const titleChanged = before.title !== after.title;
    const domTextChanged = beforeSnapshot && afterSnapshot
      ? beforeSnapshot.textDigest !== afterSnapshot.textDigest || beforeSnapshot.textLength !== afterSnapshot.textLength
      : undefined;
    const beforeTargetIds = new Set(beforeTargets.map((target) => target.id));
    const newTargets = afterTargets
      .filter((target) => !beforeTargetIds.has(target.id))
      .filter((target) => target.url && target.url !== 'about:blank')
      .slice(0, 5)
      .map((target) => ({ id: target.id, url: target.url, title: target.title || '' }));
    const result: BrowserClickResult = {
      ...after,
      action: 'dispatched_click_events',
      selector,
      index,
      element: dispatch.element || beforeSnapshot?.element,
      before,
      after,
      observation: {
        urlChanged,
        titleChanged,
        currentPageNavigationDetected: urlChanged || titleChanged,
        domTextChanged,
        beforeTextLength: beforeSnapshot?.textLength,
        afterTextLength: afterSnapshot?.textLength,
        windowOpenCalls: dispatch.windowOpenCalls?.slice(0, 5),
        newTargets,
        note: ''
      }
    };
    result.observation!.note = clickObservationNote(result);
    return result;
  }

  private async installPageErrorCapture(): Promise<void> {
    await this.evalInPage(
      `(function () {
        if (window.__tasiBrowserErrorCaptureInstalled) return true;
        window.__tasiBrowserErrorCaptureInstalled = true;
        window.__tasiBrowserPageErrors = window.__tasiBrowserPageErrors || [];
        window.__tasiBrowserConsole = window.__tasiBrowserConsole || [];
        const originalConsole = {};
        for (const level of ["log", "info", "warning", "error"]) {
          const consoleLevel = level === "warning" ? "warn" : level;
          originalConsole[consoleLevel] = console[consoleLevel];
          console[consoleLevel] = function (...args) {
            window.__tasiBrowserConsole.push({ level, message: args.map((arg) => {
              try { return typeof arg === "string" ? arg : JSON.stringify(arg); } catch { return String(arg); }
            }).join(" "), at: new Date().toISOString() });
            return originalConsole[consoleLevel].apply(console, args);
          };
        }
        window.addEventListener("error", (event) => {
          window.__tasiBrowserPageErrors.push({
            level: "error",
            message: event.message || String(event.error || "error"),
            sourceId: event.filename || "",
            line: event.lineno || 0,
            at: new Date().toISOString()
          });
        });
        window.addEventListener("unhandledrejection", (event) => {
          window.__tasiBrowserPageErrors.push({
            level: "error",
            message: event.reason && event.reason.message ? event.reason.message : String(event.reason || "unhandledrejection"),
            at: new Date().toISOString()
          });
        });
        return true;
      })();`
    );
  }

  private async buildAccessibilitySnapshot(
    maxElements: number,
    elements: Array<{ ref: string; role: string; name: string; text: string; href?: string; value?: string; checked?: boolean; enabled: boolean }>
  ): Promise<{ tree: unknown[]; truncated: boolean }> {
    const result = await this.cdpCommand('Accessibility.getFullAXTree', {});
    const nodes = Array.isArray(result.nodes) ? (result.nodes as CdpAxNode[]) : [];
    const byId = new Map(nodes.map((node) => [node.nodeId, node]));
    const childIdSet = new Set<string>();
    for (const node of nodes) {
      for (const child of node.childIds ?? []) childIdSet.add(child);
    }
    const roots = nodes.filter((node) => !childIdSet.has(node.nodeId));
    const out: Array<Record<string, unknown>> = [];
    const usedRefs = new Set<string>();
    const findRef = (role: string, name: string): string | undefined => {
      const normalizedRole = role.toLowerCase();
      const normalizedName = name.toLowerCase();
      const match = elements.find((element) => {
        if (usedRefs.has(element.ref)) return false;
        if (element.role.toLowerCase() !== normalizedRole) return false;
        const candidate = (element.name || element.text || '').toLowerCase();
        return candidate === normalizedName || (normalizedName && candidate.includes(normalizedName)) || (candidate && normalizedName.includes(candidate));
      });
      if (!match) return undefined;
      usedRefs.add(match.ref);
      return match.ref;
    };
    const visit = (node: CdpAxNode, depth: number): void => {
      if (maxElements > 0 && out.length >= maxElements * 3) return;
      if (!node || node.ignored) return;
      const role = String(node.role?.value || 'generic');
      const name = String(node.name?.value || '');
      const value = node.value?.value == null ? '' : String(node.value.value);
      const stateParts: string[] = [];
      for (const prop of node.properties ?? []) {
        if (!['checked', 'disabled', 'expanded', 'selected', 'focused', 'pressed'].includes(prop.name)) continue;
        stateParts.push(`${prop.name}=${String(prop.value?.value ?? true)}`);
      }
      const meaningful = depth === 0 || name || value || stateParts.length > 0 || !['generic', 'none', 'ignored'].includes(role.toLowerCase());
      if (meaningful) {
        const item: Record<string, unknown> = { depth, role };
        if (name) item.name = clipWithMarker(name, 240);
        if (value) item.value = clipWithMarker(value, 240);
        const ref = findRef(role, name);
        if (ref) item.ref = ref;
        if (stateParts.length > 0) item.state = stateParts.join(',');
        out.push(item);
      }
      for (const childId of node.childIds ?? []) {
        const child = byId.get(childId);
        if (child) visit(child, meaningful ? depth + 1 : depth);
      }
    };
    for (const root of roots.length > 0 ? roots : nodes.slice(0, 1)) visit(root, 0);
    return { tree: out, truncated: maxElements > 0 && out.length >= maxElements * 3 };
  }

  private semanticTreeFromElements(elements: Array<{ ref: string; role: string; name: string; text: string; href?: string; value?: string; checked?: boolean; enabled: boolean }>): unknown[] {
    return elements.map((element) => ({
      depth: 0,
      role: element.role,
      name: element.name || element.text,
      ref: element.ref,
      ...(element.value ? { value: element.value } : {}),
      ...(element.checked != null ? { state: element.checked ? 'checked' : 'unchecked' } : {}),
      ...(element.href ? { href: element.href } : {})
    }));
  }

  private async waitForIdle(timeoutMs: number): Promise<void> {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      const ready = await this.evalInPage<boolean>(
        `(function () {
          return document.readyState === "complete" || document.readyState === "interactive";
        })();`
      ).catch(() => false);
      if (ready) {
        await sleep(150);
        return;
      }
      await sleep(150);
    }
    throw new Error(`External browser page did not finish loading within ${timeoutMs} ms.`);
  }

  private async evalInPage<T>(expression: string): Promise<T> {
    const result = await this.cdpCommand('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true
    }) as CdpEvaluateResult;
    if (result.exceptionDetails) {
      const message = result.exceptionDetails.exception?.description || result.exceptionDetails.text || 'Runtime.evaluate failed.';
      throw new Error(message);
    }
    return (result.result?.value ?? result.result?.unserializableValue ?? result.result?.description ?? null) as T;
  }

  private async cdpCommand(method: string, params: Record<string, unknown>): Promise<Record<string, any>> {
    const session = await this.resolveSession();
    if (!session.target.webSocketDebuggerUrl) throw new Error(`External browser target has no CDP websocket URL: ${session.target.id}`);
    this.log('automation.cdp.command', {
      method,
      targetId: session.target.id,
      targetUrl: session.target.url,
      targetTitle: session.target.title
    });
    return this.sendCdpCommand(session.target.webSocketDebuggerUrl, method, params);
  }

  private async resolveSession(): Promise<CdpSession> {
    const endpoint = endpointRoot(this.bridge.cdpEndpointHint(this.getConfig()));
    this.log('automation.resolveSession.start', { endpoint });
    const pages = await this.listPageTargets(endpoint);
    if (pages.length === 0) throw new Error('No attachable CDP page target is available.');
    const activeId = this.bridge.activeCdpTargetId();
    const target = (activeId ? pages.find((item) => item.id === activeId) : undefined)
      ?? pages.find((item) => item.url && item.url !== 'about:blank')
      ?? pages[0];
    this.log('automation.resolveSession.done', {
      endpoint,
      activeId,
      targetId: target.id,
      targetUrl: target.url,
      targetTitle: target.title,
      pageCount: pages.length
    });
    return { target };
  }

  private async listPageTargets(endpoint = endpointRoot(this.bridge.cdpEndpointHint(this.getConfig()))): Promise<CdpTargetInfo[]> {
    const response = await fetch(`${endpoint}/json/list`, { method: 'GET' });
    if (!response.ok) throw new Error(`CDP target list unavailable (${response.status}) at ${endpoint}/json/list`);
    const targets = (await response.json()) as CdpTargetInfo[];
    return targets.filter((target) => target.type === 'page' && target.webSocketDebuggerUrl);
  }

  private async sendCdpCommand(wsUrl: string, method: string, params: Record<string, unknown>): Promise<Record<string, any>> {
    return new Promise<Record<string, any>>((resolve, reject) => {
      const id = ++this.messageId;
      const started = Date.now();
      this.log('automation.cdp.send.start', { id, method });
      let settled = false;
      const ws = new WebSocket(withScheme(wsUrl, 'ws'));
      const fail = (message: string) => {
        if (settled) return;
        settled = true;
        try {
          ws.close();
        } catch {
          // Ignore socket close errors.
        }
        this.log('automation.cdp.send.done', { id, method, ok: false, durationMs: Date.now() - started, message });
        reject(new Error(message));
      };
      const done = (result: Record<string, any>) => {
        if (settled) return;
        settled = true;
        try {
          ws.close();
        } catch {
          // Ignore socket close errors.
        }
        this.log('automation.cdp.send.done', { id, method, ok: true, durationMs: Date.now() - started });
        resolve(result);
      };
      const timeout = setTimeout(() => fail(`CDP timeout for ${method} on ${wsUrl}`), 8000);
      ws.addEventListener('open', () => {
        try {
          ws.send(JSON.stringify({ id, method, params }));
        } catch (error) {
          clearTimeout(timeout);
          fail(error instanceof Error ? error.message : String(error));
        }
      });
      ws.addEventListener('error', (event) => {
        clearTimeout(timeout);
        fail(`CDP socket error: ${String((event as unknown as { message?: string }).message || 'unknown')}`);
      });
      ws.addEventListener('message', (event) => {
        void (async () => {
          const text = await readMessageData((event as MessageEvent).data);
          let payload: Record<string, any>;
          try {
            payload = JSON.parse(text) as Record<string, any>;
          } catch {
            return;
          }
          if (payload.id !== id) return;
          clearTimeout(timeout);
          if (payload.error) {
            const error = payload.error as { message?: string } | undefined;
            fail(error?.message ? `CDP ${method} failed: ${error.message}` : `CDP ${method} failed.`);
            return;
          }
          done((payload.result as Record<string, any>) || {});
        })();
      });
      ws.addEventListener('close', () => {
        clearTimeout(timeout);
        if (!settled) fail(`CDP socket closed before response for ${method}.`);
      });
    });
  }

  private log(event: string, details: Record<string, unknown> = {}): void {
    this.logger?.log(event, details);
  }

  private async logStorageDiagnostics(url: string): Promise<void> {
    try {
      const cookies = await this.cdpCommand('Network.getCookies', { urls: [url] });
      this.logCookieDiagnostics(url, cookies.cookies);
    } catch (error) {
      this.log('diagnostic.cookies.failed', { url, error: error instanceof Error ? error.message : String(error) });
    }
    try {
      const storage = await this.evalInPage<{ localStorageKeys: number; sessionStorageKeys: number }>(
        `(function () {
          return { localStorageKeys: localStorage.length, sessionStorageKeys: sessionStorage.length };
        })();`
      );
      this.log('diagnostic.storage', { url, ...storage });
    } catch (error) {
      this.log('diagnostic.storage.failed', { url, error: error instanceof Error ? error.message : String(error) });
    }
  }

  private logCookieDiagnostics(url: string, rawCookies: unknown): void {
    const cookies = Array.isArray(rawCookies) ? rawCookies : [];
    this.log('diagnostic.cookies', {
      url,
      cookieCount: cookies.length,
      cookies: cookies.map((cookie: any) => ({
        name: typeof cookie?.name === 'string' ? cookie.name : '',
        domain: typeof cookie?.domain === 'string' ? cookie.domain : '',
        path: typeof cookie?.path === 'string' ? cookie.path : '',
        session: Boolean(cookie?.session),
        expires: typeof cookie?.expires === 'number' ? cookie.expires : undefined
      }))
    });
  }
}
