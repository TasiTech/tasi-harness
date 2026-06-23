const MASK = 'xxxx';

const SENSITIVE_QUERY_KEY_PATTERN = /^(access_token|auth|authorization|code|data|key|password|pwd|s|secret|session|sid|ticket|token)$/i;
const PERSON_NAME_HINT_PATTERN = /(real[-_ ]?name|full[-_ ]?name|person[-_ ]?name|contact[-_ ]?name|contact|payee|applicant|recipient|operator|handler|reviewer|approver|auditor|requester|submitter|\u59d3\u540d|\u771f\u5b9e\u59d3\u540d|\u8054\u7cfb\u4eba|\u7533\u8bf7\u4eba|\u62a5\u9500\u4eba|\u7ecf\u529e\u4eba|\u8d1f\u8d23\u4eba|\u6536\u6b3e\u4eba|\u5ba1\u6279\u4eba|\u5ba1\u6838\u4eba|\u5236\u5355\u4eba|\u586b\u62a5\u4eba|\u62a5\u8d26\u4eba|\u9886\u6b3e\u4eba|\u4ed8\u6b3e\u4eba)/i;
const SENSITIVE_HINT_PATTERN = /(password|passwd|pwd|secret|token|cookie|authorization|access[-_]?key|api[-_]?key|ticket|finger|captcha|otp|mfa|username|user[-_ ]?name|user[-_ ]?id|account|login|student[-_ ]?id|employee[-_ ]?id|work[-_ ]?id|i_user|i_pass|i_code|sm2pass|\u7528\u6237|\u7528\u6237\u540d|\u8d26\u53f7|\u8d26\u6237|\u5b66\u53f7|\u5de5\u53f7|\u5bc6\u7801|\u9a8c\u8bc1\u7801|\u8eab\u4efd)/i;
const SENSITIVE_KEY_PATTERN = /^(password|passwd|pwd|secret|token|cookie|authorization|session|access[-_]?key|api[-_]?key|ticket|finger|captcha|otp|mfa|username|user[-_]?name|user[-_]?id|account|login|student[-_]?id|employee[-_]?id|work[-_]?id|i_user|i_pass|i_code|sm2pass|real[-_]?name|full[-_]?name|person[-_]?name|contact[-_]?name|payee|applicant|recipient|operator|handler|reviewer|approver|auditor|requester|submitter)$/i;
const LONG_DIGIT_PATTERN = /(?<!\d)\d{4,19}(?!\d)/g;
const SECRET_VALUE_PATTERN = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}|(?<!\d)(?:\+?86[-\s]?)?1[3-9]\d{9}(?!\d)|(?<!\d)\d{4,19}(?!\d)/i;
const CJK_PERSON_NAME_PATTERN = /[\u4e00-\u9fff][\u4e00-\u9fff·]{1,7}/;
const FORM_FIELD_TAG_PATTERN = /^(input|textarea|select|option)$/i;
const FORM_FIELD_ROLE_PATTERN = /^(textbox|combobox|spinbutton|searchbox|checkbox|radio|switch)$/i;
const SENSITIVE_LABEL_ONLY_PATTERN = new RegExp(`^(?:${SENSITIVE_HINT_PATTERN.source}|${PERSON_NAME_HINT_PATTERN.source})$`, 'i');

export const BROWSER_REDACTION_MASK = MASK;

export function redactSensitiveUrl(value: string): string {
  try {
    const url = new URL(value);
    for (const key of [...url.searchParams.keys()]) {
      if (SENSITIVE_QUERY_KEY_PATTERN.test(key)) url.searchParams.set(key, MASK);
    }
    return url.toString();
  } catch {
    return value;
  }
}

function redactSensitiveLabeledText(value: string): string {
  let previousLineWasSensitiveLabel = false;
  return value
    .split(/\r?\n/)
    .map((line) => {
      let next = line;
      if (previousLineWasSensitiveLabel && next.trim() && next.trim().length <= 240) {
        previousLineWasSensitiveLabel = false;
        return next.replace(/[^\s,;，；|]+/g, MASK);
      }
      previousLineWasSensitiveLabel = SENSITIVE_LABEL_ONLY_PATTERN.test(next.trim());
      if (PERSON_NAME_HINT_PATTERN.test(next)) {
        next = next
          .replace(/((?:real[-_ ]?name|full[-_ ]?name|person[-_ ]?name|contact[-_ ]?name|contact|payee|applicant|recipient|operator|handler|reviewer|approver|auditor|requester|submitter|\u59d3\u540d|\u771f\u5b9e\u59d3\u540d|\u8054\u7cfb\u4eba|\u7533\u8bf7\u4eba|\u62a5\u9500\u4eba|\u7ecf\u529e\u4eba|\u8d1f\u8d23\u4eba|\u6536\u6b3e\u4eba|\u5ba1\u6279\u4eba|\u5ba1\u6838\u4eba|\u5236\u5355\u4eba|\u586b\u62a5\u4eba|\u62a5\u8d26\u4eba|\u9886\u6b3e\u4eba|\u4ed8\u6b3e\u4eba)[^\n\r\u4e00-\u9fff]{0,24})[\u4e00-\u9fff][\u4e00-\u9fff·]{1,7}/giu, `$1${MASK}`)
          .replace(/(value\s*=\s*["']?)([\u4e00-\u9fff][\u4e00-\u9fff·]{1,7})(["']?)/giu, `$1${MASK}$3`);
      }
      if (!SENSITIVE_HINT_PATTERN.test(next)) return next;
      return next
        .replace(/(value\s*=\s*["']?)([^"'\s,)}\]]{4,240})(["']?)/gi, `$1${MASK}$3`)
        .replace(LONG_DIGIT_PATTERN, MASK);
    })
    .join('\n');
}

export function redactSensitiveText(value: string): string {
  const redacted = redactSensitiveUrl(value)
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, MASK)
    .replace(/(?<!\d)(?:\+?86[-\s]?)?1[3-9]\d{9}(?!\d)/g, MASK)
    .replace(/(?<!\d)\d{6}(?:19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{3}[\dXx](?!\d)/g, MASK)
    .replace(/((?:bank\s*card|card\s*number|account|username|user\s*name|user\s*id|student\s*id|employee\s*id|work\s*id|\u94f6\u884c\u5361|\u5361\u53f7|\u8d26\u53f7|\u8d26\u6237|\u7528\u6237\u540d|\u7528\u6237|\u5b66\u53f7|\u5de5\u53f7)[^\n\r\d]{0,30})\d{4,19}/giu, `$1${MASK}`)
    .replace(/\[redacted(?:-[^\]]+)?\]/gi, MASK);
  return redactSensitiveLabeledText(redacted);
}

export function redactSensitiveSerializedText(value: string, options: { includeValues: boolean }): string {
  const trimmed = value.trim();
  if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
    try {
      const parsed = JSON.parse(value) as unknown;
      return JSON.stringify(redactSensitiveObject(parsed, options), null, value.includes('\n') ? 2 : 0);
    } catch {
      // Fall through to plain-text redaction.
    }
  }
  return redactSensitiveText(value);
}

export function redactSensitiveObject(value: unknown, options: { includeValues: boolean }): unknown {
  if (typeof value === 'string') return redactSensitiveText(value);
  if (Array.isArray(value)) return value.map((item) => redactSensitiveObject(item, options));
  if (!value || typeof value !== 'object') return value;

  const record = value as Record<string, unknown>;
  const fieldHints = ['selector', 'name', 'placeholder', 'label', 'text', 'role', 'tag', 'id', 'autocomplete']
    .map((key) => typeof record[key] === 'string' ? record[key] : '')
    .join(' ');
  const tag = typeof record.tag === 'string' ? record.tag : '';
  const role = typeof record.role === 'string' ? record.role : '';
  const isBrowserFormField = FORM_FIELD_TAG_PATTERN.test(tag) || FORM_FIELD_ROLE_PATTERN.test(role);
  const isSensitiveBrowserField = SENSITIVE_HINT_PATTERN.test(fieldHints);
  const isPersonNameField = PERSON_NAME_HINT_PATTERN.test(fieldHints);
  const out: Record<string, unknown> = {};

  for (const [key, raw] of Object.entries(record)) {
    if (key === 'value' && (isBrowserFormField || !options.includeValues || isSensitiveBrowserField || isPersonNameField)) {
      out[key] = raw ? MASK : raw;
      continue;
    }
    if (key === 'text' && isSensitiveBrowserField && typeof raw === 'string' && SECRET_VALUE_PATTERN.test(raw)) {
      out[key] = MASK;
      continue;
    }
    if ((key === 'text' || key === 'name') && isPersonNameField && typeof raw === 'string' && CJK_PERSON_NAME_PATTERN.test(raw)) {
      out[key] = redactSensitiveText(raw);
      continue;
    }
    if (SENSITIVE_KEY_PATTERN.test(key)) {
      out[key] = raw ? MASK : raw;
      continue;
    }
    if (/^(\u59d3\u540d|\u771f\u5b9e\u59d3\u540d|\u8054\u7cfb\u4eba|\u7533\u8bf7\u4eba|\u62a5\u9500\u4eba|\u7ecf\u529e\u4eba|\u8d1f\u8d23\u4eba|\u6536\u6b3e\u4eba|\u5ba1\u6279\u4eba|\u5ba1\u6838\u4eba|\u5236\u5355\u4eba|\u586b\u62a5\u4eba|\u62a5\u8d26\u4eba|\u9886\u6b3e\u4eba|\u4ed8\u6b3e\u4eba)$/.test(key)) {
      out[key] = raw ? MASK : raw;
      continue;
    }
    out[key] = redactSensitiveObject(raw, options);
  }

  return out;
}
