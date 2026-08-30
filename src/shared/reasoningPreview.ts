import type { AgentMessageDeltaStream } from './types.js';

export const REASONING_STREAM_PREVIEW_CHARS = 3000;
export const CONTENT_STREAM_PREVIEW_CHARS = 5000;
const CONTENT_PART_PREVIEW_CHARS = 2000;
const CONTENT_PART_PREVIEW_ITEMS = 8;
const STREAM_DELTA_PREVIEW_CHARS = 1000;

export function latestTextFromParts(parts: string[], maxChars: number): { text: string; parts: string[]; clipped: boolean; length: number } {
  const normalizedParts = parts.map((part) => part.trim()).filter(Boolean);
  const fullLength = normalizedParts.reduce((total, part, index) => total + part.length + (index > 0 ? 1 : 0), 0);
  const chunks: string[] = [];
  let length = 0;
  let index = normalizedParts.length - 1;
  for (; index >= 0 && length < maxChars; index -= 1) {
    const part = normalizedParts[index];
    chunks.push(part);
    length += part.length + (chunks.length > 1 ? 1 : 0);
  }

  const ordered = chunks.reverse();
  const text = ordered.join('\n').slice(-maxChars).trimStart();
  return {
    text,
    parts: text === ordered.join('\n') ? ordered : [text],
    clipped: fullLength > maxChars || index >= 0,
    length: fullLength
  };
}

export function reasoningPanelText(content: string, parts: string[] | undefined, livePreview: boolean): { text: string; clippedText: boolean } {
  if (livePreview) {
    const partsPreview = parts && parts.length > 0 ? latestTextFromParts(parts, REASONING_STREAM_PREVIEW_CHARS) : undefined;
    const sourceText = partsPreview?.text
      ?? content.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim().slice(-REASONING_STREAM_PREVIEW_CHARS).trimStart();
    return {
      text: sourceText,
      clippedText: partsPreview?.clipped ?? content.length > REASONING_STREAM_PREVIEW_CHARS
    };
  }

  const fullText = (parts?.map((part) => part.trim()).filter(Boolean).join('\n') || content)
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .trim();
  if (!fullText) return { text: '', clippedText: false };
  return { text: fullText, clippedText: false };
}

export function clipReasoningForDisplay(
  content: string | undefined,
  parts: string[] | undefined,
  maxChars = REASONING_STREAM_PREVIEW_CHARS
): Pick<AgentMessageDeltaStream, 'reasoning_content' | 'reasoning_parts' | 'reasoningOmitted' | 'reasoningLength'> {
  const hasContentField = typeof content === 'string';
  const hasPartsField = Array.isArray(parts);
  const normalizedContent = hasContentField ? content.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim() : '';
  const normalizedParts = hasPartsField ? parts.map((part) => part.trim()).filter(Boolean) : [];

  if (normalizedParts.length > 0) {
    const preview = latestTextFromParts(normalizedParts, maxChars);
    return {
      reasoning_content: preview.text,
      reasoning_parts: preview.parts,
      reasoningOmitted: preview.clipped,
      reasoningLength: preview.clipped ? preview.length : undefined
    };
  }

  if (!normalizedContent) {
    return {
      reasoning_content: hasContentField ? '' : undefined,
      reasoning_parts: hasPartsField ? [] : undefined,
      reasoningOmitted: false
    };
  }

  const clipped = normalizedContent.length > maxChars;
  const text = clipped ? normalizedContent.slice(-maxChars).trimStart() : normalizedContent;
  return {
    reasoning_content: text,
    reasoning_parts: hasPartsField ? (text ? [text] : []) : undefined,
    reasoningOmitted: clipped,
    reasoningLength: clipped ? normalizedContent.length : undefined
  };
}

export function prepareReasoningDeltaForDisplay(payload: AgentMessageDeltaStream): AgentMessageDeltaStream {
  return prepareMessageDeltaForDisplay(payload);
}

function clipContentForDisplay(content: string | undefined): Pick<AgentMessageDeltaStream, 'content' | 'contentOmitted' | 'contentLength'> {
  if (typeof content !== 'string') return {};
  const normalized = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const clipped = normalized.length > CONTENT_STREAM_PREVIEW_CHARS;
  return {
    content: clipped ? normalized.slice(-CONTENT_STREAM_PREVIEW_CHARS).trimStart() : normalized,
    contentOmitted: clipped,
    contentLength: clipped ? normalized.length : undefined
  };
}

function clipContentPartsForDisplay(parts: string[] | undefined): string[] | undefined {
  if (!Array.isArray(parts)) return undefined;
  return parts
    .map((part) => part.trim())
    .filter(Boolean)
    .slice(-CONTENT_PART_PREVIEW_ITEMS)
    .map((part) => part.length > CONTENT_PART_PREVIEW_CHARS ? `${part.slice(0, CONTENT_PART_PREVIEW_CHARS).trimEnd()}\n[preview only]` : part);
}

function clipDeltaForDisplay(delta: string | undefined, type: AgentMessageDeltaStream['type']): string | undefined {
  if (typeof delta !== 'string') return delta;
  const maxChars = type === 'content' ? CONTENT_STREAM_PREVIEW_CHARS : STREAM_DELTA_PREVIEW_CHARS;
  if (delta.length <= maxChars) return delta;
  return delta.slice(-maxChars).trimStart();
}

export function prepareMessageDeltaForDisplay(payload: AgentMessageDeltaStream): AgentMessageDeltaStream {
  const reasoningPayload = payload.reasoning_content !== undefined || payload.reasoning_parts !== undefined
    ? clipReasoningForDisplay(payload.reasoning_content, payload.reasoning_parts)
    : {};
  const contentPayload = clipContentForDisplay(payload.content);
  return {
    ...payload,
    delta: clipDeltaForDisplay(payload.delta, payload.type),
    ...reasoningPayload,
    ...contentPayload,
    content_parts: clipContentPartsForDisplay(payload.content_parts)
  };
}
