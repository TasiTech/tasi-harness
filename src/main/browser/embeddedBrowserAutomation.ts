import { app, BrowserWindow, type WebContents } from 'electron';
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
  BrowserStorageResult,
  BrowserUploadFileResult
} from '../tools/browserAutomation.js';
import { EMBEDDED_BROWSER_PARTITION } from '../../shared/browserConstants.js';
import { resolveAppWindowIconPath } from '../appIcon.js';

const DEFAULT_TIMEOUT_MS = 60000;
const MAX_TIMEOUT_MS = 300000;
const DEFAULT_EXTRACT_MAX_CHARS = 8000;
const DEFAULT_SNAPSHOT_MAX_ELEMENTS = 0;
const DEFAULT_SNAPSHOT_MAX_CHARS = 100000;

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

interface ConsoleEntry {
  level: string;
  message: string;
  sourceId?: string;
  line?: number;
  at: string;
}

interface NetworkEntry {
  name: string;
  type: string;
  startTime: number;
  duration: number;
  transferSize?: number;
  encodedBodySize?: number;
  decodedBodySize?: number;
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

export function pageHelpers(): string {
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
      const describe = (el, ref = "") => {
        const rect = el.getBoundingClientRect();
        const tag = el.tagName.toLowerCase();
        const item = {
          ref,
          tag,
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
        if ("value" in el && typeof el.value !== "undefined") {
          const type = String(el.getAttribute("type") || "").toLowerCase();
          item.value = type === "password" ? (el.value ? "[password filled]" : "") : clip(String(el.value || ""), 240);
        }
        const placeholder = el.getAttribute("placeholder");
        if (placeholder) item.placeholder = placeholder;
        const label = labelFor(el);
        if (label) item.label = label;
        if ("checked" in el) item.checked = Boolean(el.checked);
        return item;
      };
      const clip = (value, max) => {
        const text = normalizeText(value);
        return text.length > max ? text.slice(0, Math.max(0, max - 15)) + "... [truncated]" : text;
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

function normalizeKey(input: string): { keyCode: string; modifiers: Array<'shift' | 'control' | 'alt' | 'meta'> } {
  const parts = input.split('+').map((part) => part.trim()).filter(Boolean);
  const modifiers: Array<'shift' | 'control' | 'alt' | 'meta'> = [];
  const key = parts.pop() || input;
  for (const part of parts) {
    const lowered = part.toLowerCase();
    if (lowered === 'cmd' || lowered === 'command' || lowered === 'meta') modifiers.push('meta');
    else if (lowered === 'ctrl' || lowered === 'control') modifiers.push('control');
    else if (lowered === 'alt' || lowered === 'option') modifiers.push('alt');
    else if (lowered === 'shift') modifiers.push('shift');
  }
  return { keyCode: key.length === 1 ? key.toUpperCase() : key, modifiers };
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

export class EmbeddedBrowserAutomation implements BrowserAutomation {
  private window: BrowserWindow | null = null;
  private readonly partition = EMBEDDED_BROWSER_PARTITION;
  private sharedWebContentsResolver?: () => WebContents | null;
  private readonly consoleEntries: ConsoleEntry[] = [];
  private trackedWebContentsId: number | null = null;

  setSharedWebContentsResolver(resolver: () => WebContents | null): void {
    this.sharedWebContentsResolver = resolver;
  }

  async open(url: string, options?: { timeoutMs?: number }): Promise<BrowserPageState> {
    const timeoutMs = clampInt(Number(options?.timeoutMs), DEFAULT_TIMEOUT_MS, 1000, MAX_TIMEOUT_MS);
    const target = normalizeUrl(url);
    const wc = this.getTargetWebContents();
    await Promise.race([
      wc.loadURL(target),
      sleep(timeoutMs).then(() => {
        throw new Error(`Timed out opening ${target} after ${timeoutMs} ms.`);
      })
    ]);
    await this.waitForIdle(timeoutMs, wc);
    this.installPageErrorCapture().catch(() => {});
    return this.stateFrom(wc);
  }

  async click(selector: string, options?: { index?: number; waitForNavigation?: boolean; timeoutMs?: number; observeMs?: number }): Promise<BrowserClickResult> {
    const timeoutMs = clampInt(Number(options?.timeoutMs), DEFAULT_TIMEOUT_MS, 1000, MAX_TIMEOUT_MS);
    const observeMs = clampInt(Number(options?.observeMs), options?.waitForNavigation ? 150 : 500, 0, 5000);
    const index = clampInt(Number(options?.index), 0, 0, 9999);
    const sel = selector.trim();
    if (!sel) throw new Error('selector is required.');
    const before = await this.state();
    const beforeSnapshot = await this.captureClickPageSnapshot(sel, index).catch(() => null);
    const result = await this.dispatchClick(sel, index);
    if (!result.ok) throw new Error(result.error || `Failed to click selector: ${sel}`);
    if (options?.waitForNavigation) await this.waitForIdle(timeoutMs, this.getTargetWebContents());
    else if (observeMs > 0) await sleep(observeMs);
    const after = await this.state();
    const afterSnapshot = await this.captureClickPageSnapshot(sel, index).catch(() => null);
    return this.buildClickResult(sel, index, before, after, beforeSnapshot, afterSnapshot, result);
  }

  async type(selector: string, text: string, options?: { clear?: boolean; submit?: boolean }): Promise<BrowserPageState> {
    const sel = selector.trim();
    if (!sel) throw new Error('selector is required.');
    const value = text ?? '';
    const clear = options?.clear !== false;
    const submit = options?.submit === true;
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
        if (${clear ? 'true' : 'false'} && typeof el.select === "function") {
          el.select();
        } else if ("setSelectionRange" in el && typeof el.value === "string") {
          const end = el.value.length;
          try { el.setSelectionRange(end, end); } catch {}
        }
        return { ok: true };
      })();`
    );
    if (!result.ok) throw new Error(result.error || `Failed to type into selector: ${sel}`);
    const wc = this.getTargetWebContents();
    if (clear) {
      wc.sendInputEvent({ type: 'keyDown', keyCode: 'A', modifiers: ['control'] });
      wc.sendInputEvent({ type: 'keyUp', keyCode: 'A', modifiers: ['control'] });
      wc.sendInputEvent({ type: 'keyDown', keyCode: 'Backspace' });
      wc.sendInputEvent({ type: 'keyUp', keyCode: 'Backspace' });
    }
    if (value) wc.insertText(value);
    if (submit) {
      wc.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' });
      wc.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' });
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
        const scrollToTarget = (left, top) => {
          if (target === window) window.scrollTo({ left, top, behavior: "instant" });
          else target.scrollTo({ left, top, behavior: "instant" });
        };
        const scrollByTarget = (left, top) => {
          if (target === window) window.scrollBy({ left, top, behavior: "instant" });
          else target.scrollBy({ left, top, behavior: "instant" });
        };
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
    untilChanged?: boolean;
    untilLoggedIn?: boolean;
    timeoutMs?: number;
  }): Promise<BrowserPageState> {
    const ms = clampInt(Number(options?.ms), 0, 0, MAX_TIMEOUT_MS);
    const selector = options?.selector?.trim() ?? '';
    const text = options?.text?.trim() ?? '';
    const url = options?.url?.trim() ?? '';
    const state = options?.state ?? 'attached';
    const loadState = options?.loadState;
    const fn = options?.function?.trim() ?? '';
    const untilChanged = options?.untilChanged === true;
    const untilLoggedIn = options?.untilLoggedIn === true;
    const timeoutMs = clampInt(Number(options?.timeoutMs), DEFAULT_TIMEOUT_MS, 250, MAX_TIMEOUT_MS);
    if (!selector && !text && !url && !loadState && !fn && !untilChanged && !untilLoggedIn && ms <= 0) throw new Error('Provide ms, selector, text, url, load_state, function, until_changed, or until_logged_in.');
    const initialSignature = untilChanged ? await this.pageChangeSignature().catch(() => '') : '';
    if (ms > 0) await sleep(ms);
    if (loadState) await this.waitForIdle(timeoutMs, this.getTargetWebContents());
    if (!selector && !text && !url && !fn && !untilChanged && !untilLoggedIn) return this.state();

    const hasPredicate = Boolean(selector || text || url || fn);
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      const ok = await this.evalInPage<boolean>(
        `(function () {
          ${pageHelpers()}
          const globToRegex = (pattern) => {
            const specials = new Set([".", "+", "^", "$", "{", "}", "(", ")", "|", "[", "]", "\\\\"]);
            const escapeRe = (value) => String(value).replace(/./g, (ch) => specials.has(ch) ? "\\\\" + ch : ch);
            return new RegExp("^" + String(pattern).split("**").map((part) => part.split("*").map(escapeRe).join("[^/]*")).join(".*") + "$");
          };
          const selector = ${JSON.stringify(selector)};
          const wantedText = ${JSON.stringify(text)};
          const wantedUrl = ${JSON.stringify(url)};
          const wantedState = ${JSON.stringify(state)};
          const fnSource = ${JSON.stringify(fn)};
          if (selector) {
            const node = document.querySelector(selector);
            if (wantedState === "detached") {
              if (node) return false;
            } else if (!node) {
              return false;
            } else if (wantedState === "visible" && !TasiBrowser.isVisible(node)) {
              return false;
            } else if (wantedState === "hidden" && TasiBrowser.isVisible(node)) {
              return false;
            }
          }
          if (wantedText && !TasiBrowser.normalizeText(document.body ? document.body.innerText || document.body.textContent || "" : "").includes(wantedText)) return false;
          if (wantedUrl) {
            const current = location.href;
            if (wantedUrl.includes("*")) {
              if (!globToRegex(wantedUrl).test(current)) return false;
            } else if (!current.includes(wantedUrl)) return false;
          }
          if (fnSource) {
            try {
              const result = Function("return Boolean(" + fnSource + ")")();
              if (!result) return false;
            } catch {
              return false;
            }
          }
          return true;
        })();`
      );
      if (hasPredicate && ok) return this.state();
      if (untilChanged) {
        const currentSignature = await this.pageChangeSignature().catch(() => '');
        if (currentSignature && currentSignature !== initialSignature) return this.state();
      }
      if (untilLoggedIn && await this.loginCompletionDetected().catch(() => false)) return this.state();
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
      snapshot?: {
        text: string;
        headings: string[];
        links: BrowserExtractJsonLink[];
      };
    }>(
      `(function () {
        ${pageHelpers()}
        const selector = ${JSON.stringify(selector ?? '')};
        const format = ${JSON.stringify(format)};
        const target = selector ? TasiBrowser.resolve(selector, 0).el : document.body;
        if (!target) return { ok: false, error: "Selector not found: " + selector };
        if (format === "html") return { ok: true, content: target.outerHTML || "" };
        const headingSeen = new Set();
        const headings = [];
        for (const node of Array.from(target.querySelectorAll("h1,h2,h3,h4,h5,h6"))) {
          const text = TasiBrowser.normalizeText(node.innerText || node.textContent || "");
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
          try { href = new URL(rawHref, location.href).toString(); } catch {}
          const text = TasiBrowser.normalizeText(node.innerText || node.textContent || "");
          const key = href + "|" + text;
          if (linkSeen.has(key)) continue;
          linkSeen.add(key);
          links.push({ text, href });
          if (links.length >= 25) break;
        }
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

  async snapshot(options?: { selector?: string; maxElements?: number; maxChars?: number }): Promise<BrowserSnapshotResult> {
    const selector = options?.selector?.trim() || '';
    const maxElements = Number.isFinite(Number(options?.maxElements)) && Number(options?.maxElements) > 0
      ? clampInt(Number(options?.maxElements), DEFAULT_SNAPSHOT_MAX_ELEMENTS, 1, 50000)
      : 0;
    const maxChars = clampInt(Number(options?.maxChars), DEFAULT_SNAPSHOT_MAX_CHARS, 1000, 1000000);
    const raw = await this.evalInPage<Omit<BrowserSnapshotResult, 'url' | 'title' | 'content'>>(
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
        const allCandidates = Array.from(scope.querySelectorAll(elementSelector));
        const candidates = allCandidates
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
          if (maxElements > 0 && elements.length >= maxElements) {
            const ref = "@e" + nextRef++;
            refs[ref] = el;
            elementToRef.set(el, ref);
            continue;
          }
          const ref = "@e" + nextRef++;
          refs[ref] = el;
          elementToRef.set(el, ref);
          const description = TasiBrowser.describe(el, ref);
          elements.push(description);
        }
        const roleByTag = (el) => TasiBrowser.roleFor(el);
        const tree = [];
        const walk = (node, depth) => {
          if (!(node instanceof Element)) return;
          if (!TasiBrowser.isVisible(node) && node !== scope && !["input", "textarea", "select", "option"].includes(node.tagName.toLowerCase())) return;
          const role = roleByTag(node);
          const name = TasiBrowser.nameFor(node);
          const tag = node.tagName.toLowerCase();
          const meaningful = node === scope || elementToRef.has(node) || name || /^h[1-6]$/.test(tag) || ["main", "nav", "header", "footer", "section", "article", "aside", "form", "dialog", "ul", "ol", "li", "table", "tr", "th", "td"].includes(tag);
          const ref = elementToRef.get(node);
          if (meaningful) {
            const item = { depth, role, name: name || "", tag };
            if (ref) item.ref = ref;
            if ("checked" in node) item.state = node.checked ? "checked" : "unchecked";
            if (node.getAttribute("aria-expanded")) item.state = "expanded=" + node.getAttribute("aria-expanded");
            if ("value" in node && node.value) {
              const type = String(node.getAttribute("type") || "").toLowerCase();
              item.value = type === "password" ? "[password filled]" : String(node.value).slice(0, 160);
            }
            const href = node.getAttribute("href");
            if (href) {
              try { item.href = new URL(href, location.href).toString(); } catch { item.href = href; }
            }
            tree.push(item);
          }
          if (maxElements > 0 && tree.length >= maxElements * 3) return;
          for (const child of Array.from(node.children)) walk(child, meaningful ? depth + 1 : depth);
        };
        walk(scope, 0);
        const headings = Array.from(scope.querySelectorAll("h1,h2,h3,h4,h5,h6")).map((el) => {
          const item = { level: Number(el.tagName.slice(1)), text: TasiBrowser.normalizeText(el.innerText || el.textContent || "") };
          const ref = elementToRef.get(el);
          if (ref) item.ref = ref;
          return item;
        }).filter((item) => item.text);
        const links = Array.from(scope.querySelectorAll("a[href]")).sort((left, right) => snapshotRank(left) - snapshotRank(right)).map((el) => {
          let href = el.getAttribute("href") || "";
          try { href = new URL(href, location.href).toString(); } catch {}
          const item = { text: TasiBrowser.normalizeText(el.innerText || el.textContent || ""), href };
          const ref = elementToRef.get(el);
          if (ref) item.ref = ref;
          return item;
        }).filter((item) => item.href);
        const images = Array.from(scope.querySelectorAll("img")).map((el) => {
          const item = { alt: el.getAttribute("alt") || "", src: el.currentSrc || el.src || "" };
          const ref = elementToRef.get(el);
          if (ref) item.ref = ref;
          return item;
        }).filter((item) => item.src || item.alt);
        return {
          source: "semantic-dom",
          tree,
          elements,
          headings,
          links,
          images,
          viewport: { width: window.innerWidth, height: window.innerHeight, scrollX: window.scrollX, scrollY: window.scrollY },
          truncated: (maxElements > 0 && candidates.length > elements.length) || (maxElements > 0 && tree.length >= maxElements * 3)
        };
      })();`
    );
    const page = await this.state();
    const snapshotText = formatSnapshotTree(raw.tree ?? []);
    const payload = {
      tool: 'browser_snapshot',
      source: raw.source ?? 'semantic-dom',
      browser_preview_url: page.url,
      ...page,
      selector: selector || undefined,
      snapshot: snapshotText,
      ...raw
    };
    const content = clipWithMarker(JSON.stringify(payload, null, 2), maxChars);
    return { ...page, ...raw, content, truncated: raw.truncated || content.length < JSON.stringify(payload, null, 2).length };
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
          if (!TasiBrowser.setText(el, String(options.text || ""), options.action !== "type")) {
            return { ok: false, error: "Target is not text-editable." };
          }
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
    if (options.waitForNavigation) await this.waitForIdle(clampInt(Number(options.timeoutMs), DEFAULT_TIMEOUT_MS, 1000, MAX_TIMEOUT_MS), this.getTargetWebContents());
    return { ...(await this.state()), ref: result.ref, selector: result.selector, text: result.text, element: result.element };
  }

  async hover(selector: string, options?: { index?: number }): Promise<BrowserPageState> {
    const sel = selector.trim();
    if (!sel) throw new Error('selector is required.');
    const index = clampInt(Number(options?.index), 0, 0, 9999);
    const result = await this.evalInPage<{ ok: boolean; error?: string }>(
      `(function () {
        ${pageHelpers()}
        const found = TasiBrowser.resolve(${JSON.stringify(sel)}, ${index});
        if (!found.ok) return found;
        if (typeof found.el.scrollIntoView === "function") found.el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
        TasiBrowser.fireMouse(found.el, "mouseover");
        TasiBrowser.fireMouse(found.el, "mousemove");
        return { ok: true };
      })();`
    );
    if (!result.ok) throw new Error(result.error || `Failed to hover selector: ${sel}`);
    return this.state();
  }

  async select(selector: string, value: string, options?: { index?: number }): Promise<BrowserPageState> {
    const sel = selector.trim();
    if (!sel) throw new Error('selector is required.');
    const index = clampInt(Number(options?.index), 0, 0, 9999);
    const result = await this.evalInPage<{ ok: boolean; error?: string }>(
      `(function () {
        ${pageHelpers()}
        const found = TasiBrowser.resolve(${JSON.stringify(sel)}, ${index});
        if (!found.ok) return found;
        const el = found.el;
        if (!(el instanceof HTMLSelectElement)) return { ok: false, error: "Target is not a select element." };
        el.value = ${JSON.stringify(value)};
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
        return { ok: true };
      })();`
    );
    if (!result.ok) throw new Error(result.error || `Failed to select value for selector: ${sel}`);
    return this.state();
  }

  async check(selector: string, checked: boolean, options?: { index?: number }): Promise<BrowserPageState> {
    const sel = selector.trim();
    if (!sel) throw new Error('selector is required.');
    const index = clampInt(Number(options?.index), 0, 0, 9999);
    const result = await this.evalInPage<{ ok: boolean; error?: string }>(
      `(function () {
        ${pageHelpers()}
        const found = TasiBrowser.resolve(${JSON.stringify(sel)}, ${index});
        if (!found.ok) return found;
        const el = found.el;
        if (!("checked" in el)) return { ok: false, error: "Target is not checkable." };
        const wanted = ${checked ? 'true' : 'false'};
        if (Boolean(el.checked) !== wanted) TasiBrowser.activate(el);
        return { ok: true };
      })();`
    );
    if (!result.ok) throw new Error(result.error || `Failed to ${checked ? 'check' : 'uncheck'} selector: ${sel}`);
    return this.state();
  }

  async press(key: string, options?: { selector?: string; text?: string }): Promise<BrowserPageState> {
    const wc = this.getTargetWebContents();
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
      wc.insertText(options.text);
      return this.state();
    }
    const normalized = normalizeKey(key.trim());
    if (!normalized.keyCode) throw new Error('key is required.');
    wc.sendInputEvent({ type: 'keyDown', keyCode: normalized.keyCode, modifiers: normalized.modifiers });
    wc.sendInputEvent({ type: 'keyUp', keyCode: normalized.keyCode, modifiers: normalized.modifiers });
    return this.state();
  }

  async uploadFile(selector: string, files: string[], options?: { index?: number }): Promise<BrowserUploadFileResult> {
    const sel = selector.trim();
    if (!sel) throw new Error('selector is required.');
    if (files.length === 0) throw new Error('At least one file path is required.');
    const index = clampInt(Number(options?.index), 0, 0, 9999);
    const wc = this.getTargetWebContents();
    const objectId = await this.resolveElementObjectId(wc, sel, index);
    await this.sendDebuggerCommand(wc, 'DOM.setFileInputFiles', { objectId, files });
    const result = await this.evalInPage<{ multiple: boolean }>(
      `(function () {
        ${pageHelpers()}
        const found = TasiBrowser.resolve(${JSON.stringify(sel)}, ${index});
        if (!found.ok) throw new Error(found.error);
        const el = found.el;
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
        return { multiple: Boolean(el.multiple) };
      })();`
    );
    return { ...(await this.state()), selector: sel, files, multiple: result.multiple };
  }

  async screenshot(): Promise<BrowserBinaryResult> {
    const wc = this.getTargetWebContents();
    const image = await wc.capturePage();
    return { ...(await this.state()), data: image.toPNG(), mimeType: 'image/png', extension: 'png' };
  }

  async pdf(): Promise<BrowserBinaryResult> {
    const wc = this.getTargetWebContents();
    const data = await wc.printToPDF({ printBackground: true });
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
    const wc = this.getTargetWebContents();
    const action = options?.action ?? 'get';
    const page = this.stateFrom(wc);
    const url = options?.url?.trim() || page.url;
    if (action === 'clear') {
      const cookies = await wc.session.cookies.get({ url });
      for (const cookie of cookies) await wc.session.cookies.remove(url, cookie.name);
      return { ...page, content: JSON.stringify({ cleared: cookies.length }, null, 2) };
    }
    if (action === 'set') {
      const name = options?.name?.trim();
      if (!name) throw new Error('name is required for cookie set.');
      await wc.session.cookies.set({
        url,
        name,
        value: options?.value ?? '',
        ...(options?.domain ? { domain: options.domain } : {}),
        path: options?.path || '/'
      });
    }
    const cookies = await wc.session.cookies.get({ url });
    return { ...page, content: JSON.stringify(cookies, null, 2) };
  }

  async console(options?: { level?: 'all' | 'log' | 'info' | 'warning' | 'error'; clear?: boolean; maxItems?: number }): Promise<BrowserDiagnosticsResult> {
    this.trackWebContents(this.getTargetWebContents());
    if (options?.clear) this.consoleEntries.length = 0;
    const level = options?.level ?? 'all';
    const maxItems = clampInt(Number(options?.maxItems), 100, 1, 1000);
    const entries = this.consoleEntries
      .filter((entry) => level === 'all' || entry.level === level)
      .slice(-maxItems);
    const pageErrors = await this.evalInPage<ConsoleEntry[]>(
      `(function () {
        window.__tasiBrowserPageErrors = window.__tasiBrowserPageErrors || [];
        return window.__tasiBrowserPageErrors.slice(-${maxItems});
      })();`
    ).catch(() => []);
    return { ...(await this.state()), content: JSON.stringify({ console: entries, pageErrors }, null, 2) };
  }

  async network(options?: { filter?: string; type?: string; maxItems?: number; clear?: boolean }): Promise<BrowserDiagnosticsResult> {
    const maxItems = clampInt(Number(options?.maxItems), 100, 1, 1000);
    if (options?.clear) {
      await this.evalInPage('performance.clearResourceTimings();');
    }
    const entries = await this.evalInPage<NetworkEntry[]>(
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
      .filter((entry) => !filter || entry.name.toLowerCase().includes(filter))
      .filter((entry) => !type || type.split(',').map((item) => item.trim()).includes(String(entry.type || '').toLowerCase()))
      .slice(-maxItems);
    return { ...(await this.state()), content: JSON.stringify(filtered, null, 2) };
  }

  async evaluate(script: string, options?: { maxChars?: number }): Promise<BrowserDiagnosticsResult> {
    const source = script.trim();
    if (!source) throw new Error('script is required.');
    const maxChars = clampInt(Number(options?.maxChars), 8000, 200, 100000);
    const value = await this.evalInPage<unknown>(
      `(async function () {
        const result = await (async () => { return (${source}); })();
        return result;
      })();`
    );
    const content = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
    return { ...(await this.state()), content: clipWithMarker(content ?? String(value), maxChars) };
  }

  async setViewport(options: { width: number; height: number; scale?: number }): Promise<BrowserPageState> {
    const width = clampInt(Number(options.width), 1280, 320, 3840);
    const height = clampInt(Number(options.height), 900, 240, 2400);
    const scale = Number.isFinite(Number(options.scale)) ? Math.max(0.25, Math.min(4, Number(options.scale))) : 1;
    const wc = this.getTargetWebContents();
    const win = BrowserWindow.fromWebContents(wc) ?? this.window;
    if (win && !win.isDestroyed()) win.setContentSize(width, height);
    wc.setZoomFactor(scale);
    return this.state();
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
    dispatch: ClickDispatchResult
  ): BrowserClickResult {
    const urlChanged = before.url !== after.url;
    const titleChanged = before.title !== after.title;
    const domTextChanged = beforeSnapshot && afterSnapshot
      ? beforeSnapshot.textDigest !== afterSnapshot.textDigest || beforeSnapshot.textLength !== afterSnapshot.textLength
      : undefined;
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
        note: ''
      }
    };
    result.observation!.note = clickObservationNote(result);
    return result;
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
    const wc = this.resolveSharedWebContents() ?? this.ensureWindow().webContents;
    this.trackWebContents(wc);
    return wc;
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

  private trackWebContents(wc: WebContents): void {
    if (this.trackedWebContentsId === wc.id) return;
    this.trackedWebContentsId = wc.id;
    wc.on('console-message' as any, ((_event: unknown, level: unknown, message: unknown, line: unknown, sourceId: unknown) => {
      const normalizedLevel = typeof level === 'string' ? level : typeof level === 'number' && level >= 3 ? 'error' : 'log';
      this.consoleEntries.push({
        level: normalizedLevel,
        message: String(message ?? ''),
        sourceId: typeof sourceId === 'string' ? sourceId : undefined,
        line: typeof line === 'number' ? line : undefined,
        at: new Date().toISOString()
      });
      while (this.consoleEntries.length > 1000) this.consoleEntries.shift();
    }) as any);
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

  private async resolveElementObjectId(wc: WebContents, selector: string, index: number): Promise<string> {
    const result = await this.sendDebuggerCommand(wc, 'Runtime.evaluate', {
      expression: `(function () {
        ${pageHelpers()}
        const found = TasiBrowser.resolve(${JSON.stringify(selector)}, ${index});
        if (!found.ok) throw new Error(found.error);
        const el = found.el;
        if (!(el instanceof HTMLInputElement) || String(el.type || "").toLowerCase() !== "file") throw new Error("Target is not a file input.");
        if (typeof el.scrollIntoView === "function") el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
        return el;
      })();`,
      awaitPromise: true,
      returnByValue: false
    }) as { result?: { objectId?: string }; exceptionDetails?: { text?: string; exception?: { description?: string } } };
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text || 'Runtime.evaluate failed.');
    }
    const objectId = result.result?.objectId;
    if (!objectId) throw new Error(`Could not resolve file input for selector: ${selector}`);
    return objectId;
  }

  private async sendDebuggerCommand(wc: WebContents, method: string, params: Record<string, unknown>): Promise<unknown> {
    const wasAttached = wc.debugger.isAttached();
    if (!wasAttached) wc.debugger.attach('1.3');
    try {
      return await wc.debugger.sendCommand(method, params);
    } finally {
      if (!wasAttached && wc.debugger.isAttached()) {
        try {
          wc.debugger.detach();
        } catch {
          // Ignore detach races when the page closes.
        }
      }
    }
  }

  private async installPageErrorCapture(): Promise<void> {
    await this.evalInPage(
      `(function () {
        if (window.__tasiBrowserErrorCaptureInstalled) return;
        window.__tasiBrowserErrorCaptureInstalled = true;
        window.__tasiBrowserPageErrors = window.__tasiBrowserPageErrors || [];
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
      })();`
    );
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

  private async pageChangeSignature(): Promise<string> {
    return this.evalInPage<string>(
      `(function () {
        const text = String((document.body && (document.body.innerText || document.body.textContent)) || "")
          .replace(/\\s+/g, " ")
          .trim();
        let hash = 0;
        for (let i = 0; i < Math.min(text.length, 50000); i += 1) {
          hash = ((hash * 31) + text.charCodeAt(i)) >>> 0;
        }
        return [location.href, document.title || "", text.length, hash].join("\\n");
      })();`
    );
  }

  private async loginCompletionDetected(): Promise<boolean> {
    return this.evalInPage<boolean>(
      `(function () {
        ${pageHelpers()}
        const visible = (el) => el && TasiBrowser.isVisible(el);
        const visiblePasswords = Array.from(document.querySelectorAll('input[type="password"]')).filter(visible);
        const filledPassword = visiblePasswords.some((el) => String(el.value || "").length > 0);
        const filledAccount = Array.from(document.querySelectorAll('input:not([type]),input[type="text"],input[type="email"],input[type="tel"],input[type="number"]'))
          .filter(visible)
          .some((el) => String(el.value || "").trim().length > 0);
        if (filledPassword && (filledAccount || visiblePasswords.length === 1)) return true;
        if (visiblePasswords.length > 0) return false;
        const text = TasiBrowser.normalizeText((document.body && (document.body.innerText || document.body.textContent)) || "");
        const loweredUrl = location.href.toLowerCase();
        const loweredTitle = String(document.title || "").toLowerCase();
        const looksLikeLoginUrl = /\\/login\\b|\\/auth\\b|sso|cas|oauth|signin|logon/.test(loweredUrl);
        const continuation = /(即将登录|确认登录|继续登录|授权|允许访问|同意授权|继续|进入系统|进入门户|continue|authorize|allow access|consent)/i.test(text);
        const signedIn = /(退出登录|注销|个人中心|用户中心|我的|控制台|工作台|首页|信息门户|dashboard|portal|logout|sign out|my account)/i.test(text + " " + loweredTitle);
        if (continuation || signedIn) return true;
        return !looksLikeLoginUrl && text.length > 0;
      })();`
    );
  }
}
