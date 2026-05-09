import { ipcRenderer } from 'electron';

type CoachEventType = 'click' | 'input' | 'change' | 'submit' | 'keydown';

interface CoachPayload {
  type: CoachEventType;
  url: string;
  title: string;
  selector?: string;
  tag?: string;
  role?: string;
  name?: string;
  text?: string;
  value?: string;
  key?: string;
}

function clip(input: string | undefined, max = 160): string {
  const text = (input ?? '').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 3)}...` : text;
}

function cssEscape(value: string): string {
  const css = (globalThis as { CSS?: { escape?: (input: string) => string } }).CSS;
  if (typeof css?.escape === 'function') return css.escape(value);
  return value.replace(/["\\]/g, '\\$&');
}

function elementSelector(element: Element): string {
  const id = element.getAttribute('id');
  if (id) return `#${cssEscape(id)}`;
  const testId = element.getAttribute('data-testid') || element.getAttribute('data-test') || element.getAttribute('data-cy');
  if (testId) return `[data-testid="${cssEscape(testId)}"]`;
  const name = element.getAttribute('name');
  if (name) return `${element.tagName.toLowerCase()}[name="${cssEscape(name)}"]`;
  const aria = element.getAttribute('aria-label');
  if (aria) return `${element.tagName.toLowerCase()}[aria-label="${cssEscape(aria)}"]`;
  const parts: string[] = [];
  let current: Element | null = element;
  while (current && current !== document.body && parts.length < 4) {
    const tag = current.tagName.toLowerCase();
    const parent: Element | null = current.parentElement;
    if (!parent) {
      parts.unshift(tag);
      break;
    }
    const siblings = Array.from(parent.children).filter((item) => item.tagName === current?.tagName);
    const index = siblings.indexOf(current);
    parts.unshift(siblings.length > 1 ? `${tag}:nth-of-type(${index + 1})` : tag);
    current = parent;
  }
  return parts.join(' > ') || element.tagName.toLowerCase();
}

function elementName(element: Element): string {
  const direct = element.getAttribute('aria-label') ||
    element.getAttribute('title') ||
    element.getAttribute('placeholder') ||
    element.getAttribute('alt') ||
    element.getAttribute('name');
  if (direct) return clip(direct, 120);
  const id = element.getAttribute('id');
  if (id) {
    const label = document.querySelector(`label[for="${cssEscape(id)}"]`);
    if (label?.textContent) return clip(label.textContent, 120);
  }
  return clip(element.textContent ?? '', 120);
}

function elementValue(element: Element): string | undefined {
  if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement)) return undefined;
  if (element instanceof HTMLInputElement && element.type === 'password') return '[masked]';
  return clip(element.value, 180);
}

function payloadFor(type: CoachEventType, element: Element, extra: Partial<CoachPayload> = {}): CoachPayload {
  return {
    type,
    url: location.href,
    title: document.title,
    selector: elementSelector(element),
    tag: element.tagName.toLowerCase(),
    role: element.getAttribute('role') ?? undefined,
    name: elementName(element) || undefined,
    text: clip(element.textContent ?? '', 160) || undefined,
    value: elementValue(element),
    ...extra
  };
}

function send(payload: CoachPayload): void {
  ipcRenderer.send('browser-coach:event', payload);
}

const inputTimers = new Map<string, number>();

window.addEventListener('click', (event) => {
  const element = event.target instanceof Element ? event.target.closest('a,button,input,textarea,select,[role],label,[tabindex]') ?? event.target : null;
  if (!element) return;
  send(payloadFor('click', element));
}, true);

window.addEventListener('input', (event) => {
  const element = event.target instanceof Element ? event.target : null;
  if (!element) return;
  const selector = elementSelector(element);
  const existing = inputTimers.get(selector);
  if (existing) window.clearTimeout(existing);
  const timer = window.setTimeout(() => {
    inputTimers.delete(selector);
    send(payloadFor('input', element));
  }, 600);
  inputTimers.set(selector, timer);
}, true);

window.addEventListener('change', (event) => {
  const element = event.target instanceof Element ? event.target : null;
  if (!element) return;
  send(payloadFor('change', element));
}, true);

window.addEventListener('submit', (event) => {
  const element = event.target instanceof Element ? event.target : document.body;
  send(payloadFor('submit', element));
}, true);

window.addEventListener('keydown', (event) => {
  if (!['Enter', 'Tab', 'Escape'].includes(event.key)) return;
  const element = event.target instanceof Element ? event.target : document.body;
  send(payloadFor('keydown', element, { key: event.key }));
}, true);
