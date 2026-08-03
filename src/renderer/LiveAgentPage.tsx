import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import type { AgentMessage, AgentMessageAttachment, LiveAgentTask, LiveRealtimeClientEvent, PublicAppConfig, SessionDocumentContext, SessionRecord } from '../shared/types.js';
import { renderMarkdownToHtml, normalizeMarkdownForRender } from './markdown.js';
import { bytesToBase64, PcmStreamPlayer, startLiveMic, type LiveMicCapture } from './liveAudio.js';

type TranslateFn = (en: string, zh: string) => string;
type LiveStatus = 'idle' | 'connecting' | 'connected' | 'closed' | 'error';

interface LiveMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  createdAt: string;
}

interface AudioInputOption {
  deviceId: string;
  label: string;
}

export interface LiveAgentOutboundMessage {
  id: string;
  text: string;
  attachments: AgentMessageAttachment[];
  documents: SessionDocumentContext[];
}

function localId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function eventType(event?: LiveRealtimeClientEvent): string {
  return String(event?.type || '');
}

function textFromEvent(event: LiveRealtimeClientEvent, keys: string[]): string {
  for (const key of keys) {
    const value = event[key];
    if (typeof value === 'string' && value) return value;
  }
  return '';
}

function responseIdFromEvent(event: LiveRealtimeClientEvent): string {
  const direct = String(event.response_id || event.responseId || '');
  if (direct) return direct;
  const response = event.response && typeof event.response === 'object' ? event.response as Record<string, unknown> : null;
  return String(response?.id || '');
}

function isActiveResponseError(message: string): boolean {
  return /conversation.*active response|active response/i.test(message);
}

function functionCallFromRealtimeEvent(event: LiveRealtimeClientEvent, bufferedArgs: Map<string, string>): { callId: string; name: string; argumentsText: string } | null {
  const type = eventType(event);
  if (type === 'response.function_call_arguments.delta') {
    const callId = String(event.call_id || '');
    if (callId) bufferedArgs.set(callId, `${bufferedArgs.get(callId) || ''}${String(event.delta || '')}`);
    return null;
  }
  if (type === 'response.function_call_arguments.done') {
    const callId = String(event.call_id || '');
    const name = String(event.name || '');
    const argumentsText = String(event.arguments || bufferedArgs.get(callId) || '{}');
    if (callId) bufferedArgs.delete(callId);
    return callId && name ? { callId, name, argumentsText } : null;
  }
  if (type === 'response.output_item.done' && event.item && typeof event.item === 'object') {
    const item = event.item as Record<string, unknown>;
    if (item.type !== 'function_call') return null;
    const callId = String(item.call_id || '');
    const name = String(item.name || '');
    const argumentsText = String(item.arguments || '{}');
    return callId && name ? { callId, name, argumentsText } : null;
  }
  return null;
}

function taskStatusText(task: LiveAgentTask, tr: TranslateFn): string {
  if (task.status === 'queued') return tr('Queued', '排队中');
  if (task.status === 'running') return tr('Running', '运行中');
  if (task.status === 'completed') return tr('Completed', '已完成');
  if (task.status === 'failed') return tr('Failed', '失败');
  return tr('Cancelled', '已取消');
}

function traceLabelText(label: string, tr: TranslateFn): string {
  if (label === 'Tool Call') return tr('Tool Call', '工具调用');
  if (label === 'Tool Result') return tr('Tool Result', '工具结果');
  if (label === 'Tool Error') return tr('Tool Error', '工具错误');
  if (label === 'Reasoning') return tr('Reasoning', '推理过程');
  if (label === 'Text') return tr('Text', '文本');
  if (label === 'Status') return tr('Status', '状态');
  return tr('Trace', '轨迹');
}

function appendTraceContent(previous: string, next: string, label: string): string {
  if (!previous) return next;
  if (label === 'Reasoning' || label === 'Text') return `${previous}${next}`;
  return `${previous.replace(/\s+$/g, '')}\n\n${next}`;
}

function mergedTaskTrace(task: LiveAgentTask | null, labels?: string[]): LiveAgentTask['trace'] {
  if (!task) return [];
  const allowed = labels ? new Set(labels) : null;
  const entries = task.trace.filter((entry) => entry.content.trim() && (!allowed || allowed.has(entry.label)));
  const sections: LiveAgentTask['trace'] = [];
  for (const entry of entries) {
    const last = sections[sections.length - 1];
    if (last && last.title === entry.title && last.label === entry.label) {
      last.content = appendTraceContent(last.content, entry.content, entry.label);
      continue;
    }
    sections.push({ ...entry });
  }
  return sections;
}

function markdown(content: string): { __html: string } {
  return { __html: renderMarkdownToHtml(normalizeMarkdownForRender(content)) };
}

function liveMessagesFromAgentMessages(messages: AgentMessage[] = []): LiveMessage[] {
  return messages
    .filter((message) => (message.role === 'user' || message.role === 'assistant') && message.content.trim())
    .map((message) => ({
      id: message.id || localId('livemsg'),
      role: message.role as LiveMessage['role'],
      content: message.content,
      createdAt: message.createdAt || new Date().toISOString()
    }));
}

export function LiveAgentPage({
  tr,
  config,
  embedded = false,
  autoStart = false,
  startSignal = 0,
  stopSignal = 0,
  initialSessionId = '',
  initialMessages = [],
  hideHeader = false,
  hideComposer = false,
  outboundMessage = null,
  onOutboundMessageConsumed,
  onSessionRecordChange,
  onStatusChange,
  onStatusMessageChange,
  onClose
}: {
  tr: TranslateFn;
  config: PublicAppConfig;
  embedded?: boolean;
  autoStart?: boolean;
  startSignal?: number;
  stopSignal?: number;
  initialSessionId?: string;
  initialMessages?: AgentMessage[];
  hideHeader?: boolean;
  hideComposer?: boolean;
  outboundMessage?: LiveAgentOutboundMessage | null;
  onOutboundMessageConsumed?: (id: string) => void;
  onSessionRecordChange?: (record: SessionRecord) => void;
  onStatusChange?: (status: LiveStatus) => void;
  onStatusMessageChange?: (message: string) => void;
  onClose?: () => void;
}): ReactElement {
  const [status, setStatus] = useState<LiveStatus>('idle');
  const [notice, setNotice] = useState('');
  const [sessionId, setSessionId] = useState(initialSessionId);
  const [messages, setMessages] = useState<LiveMessage[]>(() => liveMessagesFromAgentMessages(initialMessages));
  const [userTranscriptDraft, setUserTranscriptDraft] = useState('');
  const [assistantDraft, setAssistantDraft] = useState('');
  const [textInput, setTextInput] = useState('');
  const [tasks, setTasks] = useState<LiveAgentTask[]>([]);
  const [micActive, setMicActive] = useState(false);
  const [micLevel, setMicLevel] = useState(0);
  const [audioInputs, setAudioInputs] = useState<AudioInputOption[]>([]);
  const [selectedAudioInputId, setSelectedAudioInputId] = useState('');
  const [selectedTaskId, setSelectedTaskId] = useState('');
  const micRef = useRef<LiveMicCapture | null>(null);
  const playerRef = useRef(new PcmStreamPlayer());
  const functionArgsRef = useRef(new Map<string, string>());
  const completedFunctionCallIdsRef = useRef(new Set<string>());
  const completedAssistantResponseIdsRef = useRef(new Set<string>());
  const recentLiveMessagesRef = useRef<Array<{ role: LiveMessage['role']; content: string; createdAtMs: number }>>([]);
  const recentLiveTaskPromptsRef = useRef(new Map<string, { taskId: string; createdAtMs: number }>());
  const statusRef = useRef<LiveStatus>('idle');
  const sessionIdRef = useRef('');
  const configRef = useRef(config);
  const assistantDraftRef = useRef('');
  const autoStartedRef = useRef(false);
  const disposedRef = useRef(false);
  const startTokenRef = useRef(0);
  const qwenFallbackTimerRef = useRef<number | null>(null);
  const qwenManualTurnDetectionRef = useRef(false);
  const qwenServerVadActiveRef = useRef(false);
  const qwenServerSpeechSeenRef = useRef(false);
  const qwenLocalSpeechPendingRef = useRef(false);
  const qwenManualCommitInFlightRef = useRef(false);
  const qwenAudioChunksSinceCommitRef = useRef(0);
  const qwenAudioPeakLevelRef = useRef(0);
  const qwenLowConfidenceCommitAtRef = useRef(0);
  const selectedAudioInputIdRef = useRef('');
  const consumedOutboundIdsRef = useRef(new Set<string>());
  const startTimeoutRef = useRef<number | null>(null);
  const cleanupStopTimerRef = useRef<number | null>(null);
  const responseActiveRef = useRef(false);
  const responseCreatePendingRef = useRef(false);
  const responseCreateQueuedRef = useRef(false);
  const responsePendingTimerRef = useRef<number | null>(null);
  const qwenAudioResponseTimerRef = useRef<number | null>(null);
  const endRef = useRef<HTMLDivElement | null>(null);
  const traceListRef = useRef<HTMLDivElement | null>(null);
  const connected = status === 'connected';
  const canStart = config.omniApiKeyConfigured && Boolean(config.omniBaseUrl && config.omniModel);
  const activeTasks = useMemo(() => tasks.filter((task) => task.status === 'queued' || task.status === 'running'), [tasks]);
  const selectedTask = useMemo(
    () => tasks.find((task) => task.id === selectedTaskId) || tasks.find((task) => task.status === 'running') || tasks[0] || null,
    [selectedTaskId, tasks]
  );
  const selectedTaskTrace = useMemo(() => mergedTaskTrace(selectedTask), [selectedTask]);

  useEffect(() => {
    statusRef.current = status;
    onStatusChange?.(status);
  }, [status]);

  useEffect(() => {
    sessionIdRef.current = sessionId;
  }, [sessionId]);

  useEffect(() => {
    configRef.current = config;
  }, [config]);

  useEffect(() => {
    selectedAudioInputIdRef.current = selectedAudioInputId;
  }, [selectedAudioInputId]);

  useEffect(() => {
    void refreshAudioInputs().catch((error) => setNotice(error instanceof Error ? error.message : String(error)));
    const mediaDevices = navigator.mediaDevices;
    if (!mediaDevices?.addEventListener) return;
    const refresh = (): void => {
      void refreshAudioInputs().catch((error) => setNotice(error instanceof Error ? error.message : String(error)));
    };
    mediaDevices.addEventListener('devicechange', refresh);
    return () => mediaDevices.removeEventListener('devicechange', refresh);
  }, []);

  useEffect(() => {
    assistantDraftRef.current = assistantDraft;
  }, [assistantDraft]);

  useEffect(() => {
    onStatusMessageChange?.(notice);
  }, [notice]);

  useEffect(() => {
    if (selectedTaskId && tasks.some((task) => task.id === selectedTaskId)) return;
    setSelectedTaskId(tasks.find((task) => task.status === 'running')?.id || tasks[0]?.id || '');
  }, [selectedTaskId, tasks]);

  useEffect(() => {
    const list = traceListRef.current;
    if (!list) return;
    list.scrollTop = list.scrollHeight;
  }, [selectedTaskTrace]);

  useEffect(() => {
    const nextSessionId = initialSessionId.trim();
    if (!nextSessionId) return;
    sessionIdRef.current = nextSessionId;
    setSessionId(nextSessionId);
    setMessages(liveMessagesFromAgentMessages(initialMessages));
    void window.tasiHarness.liveTasks.list(nextSessionId)
      .then(setTasks)
      .catch((error) => setNotice(error instanceof Error ? error.message : String(error)));
  }, [initialSessionId, initialMessages]);

  useEffect(() => {
    clearCleanupStopTimer();
    disposedRef.current = false;
    const activeSessionId = sessionIdRef.current || initialSessionId.trim();
    void window.tasiHarness.liveTasks.list(activeSessionId || undefined).then(setTasks).catch((error) => setNotice(error instanceof Error ? error.message : String(error)));
    const offTask = window.tasiHarness.liveTasks.onUpdated(({ task }) => {
      if (sessionIdRef.current && task.sessionId !== sessionIdRef.current) return;
      setTasks((old) => [task, ...old.filter((item) => item.id !== task.id)].sort((a, b) => a.createdAt.localeCompare(b.createdAt)));
    });
    const offRealtime = window.tasiHarness.liveRealtime.onEvent((payload) => {
      if (payload.sessionId !== sessionIdRef.current) return;
      if (payload.status) {
        const nextStatus = payload.status === 'connected' ? 'connected' : payload.status === 'connecting' ? 'connecting' : payload.status === 'error' ? 'error' : 'closed';
        statusRef.current = nextStatus;
        setStatus(nextStatus);
        if (nextStatus === 'closed' || nextStatus === 'error') {
          clearStartTimeout();
          clearQwenFallbackTimer();
          clearQwenAudioResponseTimer();
          clearResponsePendingTimer();
          responseActiveRef.current = false;
          responseCreatePendingRef.current = false;
          responseCreateQueuedRef.current = false;
          resetQwenAudioBufferState();
          stopMic();
          playerRef.current.stop();
        }
        if (payload.message && payload.status !== 'connected') setNotice(payload.message);
      }
      if (payload.event) handleRealtimeEvent(payload.event);
    });
    return () => {
      disposedRef.current = true;
      offTask();
      offRealtime();
      cleanupStopTimerRef.current = window.setTimeout(() => {
        if (!disposedRef.current) return;
        startTokenRef.current += 1;
        clearStartTimeout();
        clearQwenFallbackTimer();
        clearQwenAudioResponseTimer();
        clearResponsePendingTimer();
        stopMic(true);
        void window.tasiHarness.liveRealtime.stop().catch(() => undefined);
        void playerRef.current.close().catch(() => undefined);
      }, 250);
    };
  }, []);

  useEffect(() => {
    if (!autoStart || autoStartedRef.current) return;
    autoStartedRef.current = true;
    void startSession();
  }, [autoStart]);

  useEffect(() => {
    if (!startSignal || statusRef.current === 'connecting' || statusRef.current === 'connected') return;
    void startSession();
  }, [startSignal]);

  useEffect(() => {
    if (!stopSignal || (statusRef.current !== 'connecting' && statusRef.current !== 'connected')) return;
    void stopSession();
  }, [stopSignal]);

  useEffect(() => {
    if (!outboundMessage || consumedOutboundIdsRef.current.has(outboundMessage.id)) return;
    if (statusRef.current !== 'connected') {
      setNotice(tr('Realtime call is still connecting. Please try again in a moment.', '实时通话仍在连接中，请稍后再试。'));
      return;
    }
    consumedOutboundIdsRef.current.add(outboundMessage.id);
    void sendOutboundMessage(outboundMessage)
      .then(() => onOutboundMessageConsumed?.(outboundMessage.id))
      .catch((error) => {
        consumedOutboundIdsRef.current.delete(outboundMessage.id);
        setNotice(error instanceof Error ? error.message : String(error));
      });
  }, [outboundMessage]);

  useEffect(() => endRef.current?.scrollIntoView({ behavior: 'smooth' }), [messages, userTranscriptDraft, assistantDraft]);

  async function sendRealtime(event: LiveRealtimeClientEvent): Promise<void> {
    await window.tasiHarness.liveRealtime.send(event);
  }

  async function handleRealtimeEvent(event: LiveRealtimeClientEvent): Promise<void> {
    const type = eventType(event);
    if (type === 'error') {
      const error = event.error && typeof event.error === 'object' ? event.error as Record<string, unknown> : {};
      const message = String(error.message || event.message || 'Realtime server returned an error.');
      responseCreatePendingRef.current = false;
      clearResponsePendingTimer();
      if (isActiveResponseError(message)) {
        responseActiveRef.current = true;
        responseCreateQueuedRef.current = true;
        statusRef.current = 'connected';
        setStatus('connected');
        setNotice(tr('The model is still answering. Your next turn has been queued.', '模型还在回复中，下一轮输入已排队。'));
        return;
      }
      setStatus('error');
      setNotice(message);
      return;
    }
    if (type === 'response.created') {
      responseCreatePendingRef.current = false;
      responseActiveRef.current = true;
      clearResponsePendingTimer();
      return;
    }
    if (type === 'session.created' || type === 'session.updated') {
      const session = event.session && typeof event.session === 'object' ? event.session as Record<string, unknown> : {};
      qwenManualTurnDetectionRef.current = configRef.current.omniProvider === 'qwen-bailian'
        && Object.prototype.hasOwnProperty.call(session, 'turn_detection')
        && session.turn_detection === null;
      if (!qwenManualTurnDetectionRef.current) qwenServerSpeechSeenRef.current = false;
      return;
    }
    const call = functionCallFromRealtimeEvent(event, functionArgsRef.current);
    if (call && call.name === 'create_live_task') {
      await createTaskFromFunctionCall(call.callId, call.argumentsText);
      return;
    }
    if (type === 'input_audio_buffer.speech_started') {
      qwenServerVadActiveRef.current = true;
      qwenServerSpeechSeenRef.current = true;
      qwenManualTurnDetectionRef.current = false;
      clearQwenAudioResponseTimer();
      clearQwenFallbackTimer();
      playerRef.current.stop();
      return;
    }
    if (type === 'input_audio_buffer.speech_stopped' || type === 'input_audio_buffer.committed') {
      qwenServerVadActiveRef.current = false;
      qwenLocalSpeechPendingRef.current = false;
      qwenManualCommitInFlightRef.current = false;
      resetQwenAudioBufferState();
      clearQwenFallbackTimer();
      scheduleQwenAudioResponseCreate(type);
      return;
    }
    if (type === 'conversation.item.input_audio_transcription.delta' || type === 'conversation.item.input_audio_transcription.text') {
      const prefix = textFromEvent(event, ['text', 'transcript', 'delta']);
      const stash = textFromEvent(event, ['stash']);
      const preview = `${prefix}${stash}`.trim();
      if (preview) setUserTranscriptDraft(preview);
      return;
    }
    if (type === 'conversation.item.input_audio_transcription.completed') {
      const transcript = textFromEvent(event, ['transcript', 'text']);
      setUserTranscriptDraft('');
      if (transcript.trim()) appendMessage('user', transcript);
      return;
    }
    if (type === 'response.audio.delta' || type === 'response.output_audio.delta') {
      const delta = textFromEvent(event, ['delta']);
      if (delta) playerRef.current.enqueue(delta);
      return;
    }
    if (type === 'response.audio_transcript.delta' || type === 'response.output_audio_transcript.delta' || type === 'response.text.delta' || type === 'response.output_text.delta') {
      const delta = textFromEvent(event, ['delta', 'text', 'transcript']);
      if (delta) setAssistantDraft((old) => {
        const next = `${old}${delta}`;
        assistantDraftRef.current = next;
        return next;
      });
      return;
    }
    if (type === 'response.audio_transcript.done' || type === 'response.output_audio_transcript.done' || type === 'response.text.done' || type === 'response.done') {
      const finalText = textFromEvent(event, ['transcript', 'text']);
      const content = (finalText || assistantDraftRef.current).trim();
      const responseId = responseIdFromEvent(event);
      if (content && (!responseId || !completedAssistantResponseIdsRef.current.has(responseId))) {
        appendMessage('assistant', content);
        if (responseId) completedAssistantResponseIdsRef.current.add(responseId);
      }
      assistantDraftRef.current = '';
      setAssistantDraft('');
      if (type === 'response.done') markResponseIdle();
      return;
    }
    if (type === 'response.cancelled' || type === 'response.failed') {
      markResponseIdle();
    }
  }

  async function createTaskFromFunctionCall(callId: string, argumentsText: string): Promise<void> {
    if (completedFunctionCallIdsRef.current.has(callId)) return;
    completedFunctionCallIdsRef.current.add(callId);
    let args: Record<string, unknown> = {};
    try {
      args = JSON.parse(argumentsText) as Record<string, unknown>;
    } catch {
      args = { task: argumentsText };
    }
    const prompt = String(args.task || args.prompt || '').trim();
    if (!prompt) return;
    const taskKey = prompt.replace(/\s+/g, ' ').toLowerCase();
    const existing = recentLiveTaskPromptsRef.current.get(taskKey);
    if (existing && Date.now() - existing.createdAtMs < 20000) {
      await sendRealtime({
        type: 'conversation.item.create',
        item: {
          type: 'function_call_output',
          call_id: callId,
          output: JSON.stringify({ task_id: existing.taskId, status: 'queued', duplicate: true }, null, 2)
        }
      });
      return;
    }
    const task = await window.tasiHarness.liveTasks.enqueue({
      prompt,
      name: String(args.name || '').trim(),
      sessionId: sessionIdRef.current,
      executionMode: configRef.current.defaultExecutionMode
    });
    recentLiveTaskPromptsRef.current.set(taskKey, { taskId: task.id, createdAtMs: Date.now() });
    await sendRealtime({
      type: 'conversation.item.create',
      item: {
        type: 'function_call_output',
        call_id: callId,
        output: JSON.stringify({ task_id: task.id, status: task.status }, null, 2)
      }
    });
    await createResponse();
    setNotice(tr(`Queued background task ${task.id}.`, `已创建后台任务 ${task.id}。`));
  }

  function appendMessage(role: LiveMessage['role'], content: string, attachments?: AgentMessageAttachment[]): void {
    const createdAt = new Date().toISOString();
    const normalizedContent = content.replace(/\s+/g, ' ').trim();
    const nowMs = Date.now();
    recentLiveMessagesRef.current = recentLiveMessagesRef.current.filter((message) => nowMs - message.createdAtMs < 10000);
    if (recentLiveMessagesRef.current.some((message) => message.role === role && message.content === normalizedContent)) return;
    recentLiveMessagesRef.current.push({ role, content: normalizedContent, createdAtMs: nowMs });
    setMessages((old) => [...old, { id: localId('livemsg'), role, content, createdAt }]);
    const activeSessionId = sessionIdRef.current || sessionId;
    if (!activeSessionId) return;
    void window.tasiHarness.liveSessions.appendMessage({
      sessionId: activeSessionId,
      role,
      content,
      attachments,
      createdAt
    }).then(onSessionRecordChange).catch((error) => setNotice(error instanceof Error ? error.message : String(error)));
  }

  async function startSession(): Promise<void> {
    const token = startTokenRef.current + 1;
    startTokenRef.current = token;
    completedFunctionCallIdsRef.current.clear();
    completedAssistantResponseIdsRef.current.clear();
    recentLiveMessagesRef.current = [];
    recentLiveTaskPromptsRef.current.clear();
    let realtimeSessionId = (sessionIdRef.current || initialSessionId).trim();
    if (!realtimeSessionId) {
      const created = await window.tasiHarness.liveSessions.create();
      realtimeSessionId = created.sessionId;
    }
    sessionIdRef.current = realtimeSessionId;
    setSessionId(realtimeSessionId);
    clearStartTimeout();
    setNotice('');
    setStatus('connecting');
    resetQwenAudioBufferState();
    startTimeoutRef.current = window.setTimeout(() => {
      if (disposedRef.current || startTokenRef.current !== token || statusRef.current !== 'connecting') return;
      setStatus('error');
      setNotice(tr('Realtime connection timed out. Check the Omni WebSocket URL, model, API key, and workspace ID.', '实时通话连接超时。请检查 Omni WebSocket URL、模型、API Key 和 Workspace ID。'));
      void window.tasiHarness.liveRealtime.stop().catch(() => undefined);
    }, 22000);
    try {
      const result = await window.tasiHarness.liveRealtime.start({
        sessionId: realtimeSessionId,
        instructions: config.omniSystemPrompt || config.systemPersona,
        voice: config.omniProvider === 'qwen-bailian' ? undefined : 'alloy'
      });
      if (disposedRef.current || startTokenRef.current !== token) return;
      clearStartTimeout();
      if (result.status !== 'connected') {
        setStatus(result.status === 'error' ? 'error' : 'closed');
        return;
      }
      setSessionId(result.sessionId);
      statusRef.current = 'connected';
      setStatus('connected');
      setNotice('');
      await startMic(true);
    } catch (error) {
      if (disposedRef.current || startTokenRef.current !== token) return;
      clearStartTimeout();
      setStatus('error');
      setNotice(error instanceof Error ? error.message : String(error));
    }
  }

  async function stopSession(closeMode = false): Promise<void> {
    startTokenRef.current += 1;
    clearStartTimeout();
    clearQwenFallbackTimer();
    clearQwenAudioResponseTimer();
    clearResponsePendingTimer();
    responseActiveRef.current = false;
    responseCreatePendingRef.current = false;
    responseCreateQueuedRef.current = false;
    resetQwenAudioBufferState();
    stopMic();
    playerRef.current.stop();
    await window.tasiHarness.liveRealtime.stop().catch(() => undefined);
    statusRef.current = 'closed';
    setStatus('closed');
    if (closeMode) onClose?.();
  }

  async function startMic(force = false): Promise<void> {
    if (micRef.current || (!force && statusRef.current !== 'connected')) return;
    const inputSampleRate = configRef.current.omniProvider === 'qwen-bailian' ? 16000 : 24000;
    const capture = await startLiveMic((audio, level, info) => {
      if (statusRef.current !== 'connected') return;
      setMicLevel(Math.min(1, Math.max(0, level * 18)));
      void sendRealtime({
        type: 'input_audio_buffer.append',
        audio,
        _clientAudioLevel: level,
        _clientAudioPeak: info.peak,
        _clientInputSampleRate: info.inputSampleRate,
        _clientTargetSampleRate: info.targetSampleRate,
        _clientInputFrames: info.inputFrames,
        _clientPcmBytes: info.pcmBytes
      }).catch((error) => setNotice(error instanceof Error ? error.message : String(error)));
      scheduleQwenFallbackCommit(level);
    }, inputSampleRate, {
      deviceId: selectedAudioInputIdRef.current,
      chunkBytes: configRef.current.omniProvider === 'qwen-bailian' ? 10240 : undefined
    });
    micRef.current = capture;
    setMicActive(true);
    await refreshAudioInputs();
  }

  function stopMic(silent = false): void {
    micRef.current?.stop();
    micRef.current = null;
    setMicLevel(0);
    if (!silent) setMicActive(false);
  }

  async function refreshAudioInputs(): Promise<void> {
    if (!navigator.mediaDevices?.enumerateDevices) return;
    const devices = await navigator.mediaDevices.enumerateDevices();
    const inputs = devices
      .filter((device) => device.kind === 'audioinput')
      .map((device, index) => ({
        deviceId: device.deviceId,
        label: device.label || tr(`Microphone ${index + 1}`, `麦克风 ${index + 1}`)
      }));
    setAudioInputs(inputs);
    if (inputs.length === 0) {
      selectedAudioInputIdRef.current = '';
      setSelectedAudioInputId('');
      return;
    }
    const current = selectedAudioInputIdRef.current;
    if (inputs.some((input) => input.deviceId === current)) return;
    selectedAudioInputIdRef.current = inputs[0].deviceId;
    setSelectedAudioInputId(inputs[0].deviceId);
  }

  async function selectAudioInput(deviceId: string): Promise<void> {
    setSelectedAudioInputId(deviceId);
    selectedAudioInputIdRef.current = deviceId;
    resetQwenAudioBufferState();
    clearQwenFallbackTimer();
    if (statusRef.current !== 'connected') return;
    stopMic(true);
    await startMic(true);
  }

  function clearQwenFallbackTimer(): void {
    if (!qwenFallbackTimerRef.current) return;
    window.clearTimeout(qwenFallbackTimerRef.current);
    qwenFallbackTimerRef.current = null;
  }

  function clearQwenAudioResponseTimer(): void {
    if (!qwenAudioResponseTimerRef.current) return;
    window.clearTimeout(qwenAudioResponseTimerRef.current);
    qwenAudioResponseTimerRef.current = null;
  }

  function resetQwenAudioBufferState(): void {
    qwenAudioChunksSinceCommitRef.current = 0;
    qwenAudioPeakLevelRef.current = 0;
    qwenLocalSpeechPendingRef.current = false;
  }

  function clearStartTimeout(): void {
    if (!startTimeoutRef.current) return;
    window.clearTimeout(startTimeoutRef.current);
    startTimeoutRef.current = null;
  }

  function clearCleanupStopTimer(): void {
    if (!cleanupStopTimerRef.current) return;
    window.clearTimeout(cleanupStopTimerRef.current);
    cleanupStopTimerRef.current = null;
  }

  function clearResponsePendingTimer(): void {
    if (!responsePendingTimerRef.current) return;
    window.clearTimeout(responsePendingTimerRef.current);
    responsePendingTimerRef.current = null;
  }

  function markResponseIdle(): void {
    responseActiveRef.current = false;
    responseCreatePendingRef.current = false;
    clearResponsePendingTimer();
    if (!responseCreateQueuedRef.current || statusRef.current !== 'connected' || disposedRef.current) return;
    responseCreateQueuedRef.current = false;
    void createResponse().catch((error) => setNotice(error instanceof Error ? error.message : String(error)));
  }

  function responseCreateEvent(): LiveRealtimeClientEvent {
    return configRef.current.omniProvider === 'qwen-bailian'
      ? { type: 'response.create' }
      : { type: 'response.create', response: { modalities: ['text', 'audio'] } };
  }

  async function createResponse(): Promise<boolean> {
    if (statusRef.current !== 'connected') return false;
    if (responseActiveRef.current || responseCreatePendingRef.current) {
      responseCreateQueuedRef.current = true;
      setNotice(tr('The model is still answering. Your next turn has been queued.', '模型还在回复中，下一轮输入已排队。'));
      return false;
    }
    responseCreatePendingRef.current = true;
    clearResponsePendingTimer();
    responsePendingTimerRef.current = window.setTimeout(() => {
      responseCreatePendingRef.current = false;
      responsePendingTimerRef.current = null;
    }, 6000);
    try {
      await sendRealtime(responseCreateEvent());
      return true;
    } catch (error) {
      responseCreatePendingRef.current = false;
      clearResponsePendingTimer();
      throw error;
    }
  }

  function scheduleQwenFallbackCommit(level: number): void {
    const allowLocalFallback = qwenManualTurnDetectionRef.current || !qwenServerSpeechSeenRef.current;
    if (configRef.current.omniProvider !== 'qwen-bailian' || qwenServerVadActiveRef.current || !allowLocalFallback) return;
    qwenAudioChunksSinceCommitRef.current += 1;
    qwenAudioPeakLevelRef.current = Math.max(qwenAudioPeakLevelRef.current, level);
    const now = Date.now();
    const clearSpeechLevel = 0.00045;
    const quietSpeechLevel = 0.00001;
    const forcedManualCommitChunks = 12;
    const lowConfidenceCooldownMs = 12000;
    const hasClearSpeech = level >= clearSpeechLevel;
    const shouldProbeQuietSpeech = !qwenLocalSpeechPendingRef.current
      && qwenAudioChunksSinceCommitRef.current >= 4
      && qwenAudioPeakLevelRef.current >= quietSpeechLevel;
    const shouldForceManualCommit = !qwenLocalSpeechPendingRef.current
      && qwenAudioChunksSinceCommitRef.current >= forcedManualCommitChunks
      && qwenAudioPeakLevelRef.current >= quietSpeechLevel
      && now - qwenLowConfidenceCommitAtRef.current >= lowConfidenceCooldownMs;
    if (!hasClearSpeech && !shouldProbeQuietSpeech && !shouldForceManualCommit) return;
    qwenLocalSpeechPendingRef.current = true;
    clearQwenFallbackTimer();
    qwenFallbackTimerRef.current = window.setTimeout(() => {
      void commitQwenAudioBuffer(shouldForceManualCommit ? 'manual_low_confidence' : 'local_vad');
    }, shouldForceManualCommit || shouldProbeQuietSpeech ? 120 : 900);
  }

  async function commitQwenAudioBuffer(source: string): Promise<void> {
    if (!qwenLocalSpeechPendingRef.current || qwenServerVadActiveRef.current || statusRef.current !== 'connected' || qwenManualCommitInFlightRef.current) return;
    qwenManualCommitInFlightRef.current = true;
    const chunks = qwenAudioChunksSinceCommitRef.current;
    const peak = qwenAudioPeakLevelRef.current;
    resetQwenAudioBufferState();
    clearQwenFallbackTimer();
    try {
      await sendRealtime({ type: 'input_audio_buffer.commit', _clientCommitSource: source });
      scheduleQwenAudioResponseCreate(source);
      if (source === 'manual_low_confidence') qwenLowConfidenceCommitAtRef.current = Date.now();
      setNotice(tr(`Voice submitted (${chunks} chunks, level ${peak.toFixed(4)}).`, `语音已提交（${chunks} 段，音量 ${peak.toFixed(4)}）。`));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!/empty|active response/i.test(message)) setNotice(`${source}: ${message}`);
    } finally {
      qwenManualCommitInFlightRef.current = false;
    }
  }

  function scheduleQwenAudioResponseCreate(sourceType: string): void {
    if (configRef.current.omniProvider !== 'qwen-bailian') return;
    if (responseActiveRef.current || responseCreatePendingRef.current) return;
    clearQwenAudioResponseTimer();
    qwenAudioResponseTimerRef.current = window.setTimeout(() => {
      qwenAudioResponseTimerRef.current = null;
      if (statusRef.current !== 'connected' || disposedRef.current || responseActiveRef.current || responseCreatePendingRef.current) return;
      void createResponse().catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        if (!isActiveResponseError(message)) setNotice(`${sourceType}: ${message}`);
      });
    }, 900);
  }

  async function toggleMic(): Promise<void> {
    if (micRef.current) {
      clearQwenFallbackTimer();
      stopMic();
      qwenLocalSpeechPendingRef.current = qwenAudioChunksSinceCommitRef.current > 0;
      await commitQwenAudioBuffer('mic_toggle').catch(() => undefined);
      return;
    }
    await startMic();
  }

  function outboundText(message: LiveAgentOutboundMessage): string {
    const parts = [message.text.trim()].filter(Boolean);
    if (message.documents.length > 0) {
      parts.push([
        'Uploaded documents in this live conversation:',
        ...message.documents.map((doc, index) => [
          `${index + 1}. ${doc.filename}`,
          doc.excerpt ? `Excerpt: ${doc.excerpt}` : '',
          doc.workspaceCopyPath ? `Workspace copy: ${doc.workspaceCopyPath}` : ''
        ].filter(Boolean).join('\n'))
      ].join('\n'));
    }
    const unsupported = message.attachments.filter((attachment) => attachment.kind !== 'image');
    if (unsupported.length > 0) {
      parts.push([
        'Uploaded media attached to this turn:',
        ...unsupported.map((attachment, index) => `${index + 1}. ${attachment.filename} (${attachment.kind}, ${attachment.mimeType})`)
      ].join('\n'));
    }
    return parts.join('\n\n').trim() || 'Please review the uploaded file or image.';
  }

  function outboundDisplayText(message: LiveAgentOutboundMessage): string {
    const labels = [
      ...message.documents.map((doc) => `file: ${doc.filename}`),
      ...message.attachments.map((attachment) => `${attachment.kind}: ${attachment.filename}`)
    ];
    return [message.text.trim(), labels.length > 0 ? labels.map((label) => `- ${label}`).join('\n') : ''].filter(Boolean).join('\n\n');
  }

  function dataUrl(attachment: AgentMessageAttachment): string {
    return `data:${attachment.mimeType};base64,${attachment.contentBase64}`;
  }

  function silencePcm16Base64(sampleRate: number, durationMs: number): string {
    return bytesToBase64(new Uint8Array(Math.max(1, Math.round(sampleRate * durationMs / 1000)) * 2));
  }

  async function imageToJpegBase64(attachment: AgentMessageAttachment, maxBase64Bytes = 250 * 1024): Promise<string> {
    if (/^image\/jpe?g$/i.test(attachment.mimeType) && attachment.contentBase64.length <= maxBase64Bytes) return attachment.contentBase64;
    const source = await new Promise<HTMLImageElement>((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error(`Failed to load image ${attachment.filename}.`));
      image.src = dataUrl(attachment);
    });
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Canvas is not available for image conversion.');
    let best = '';
    for (const maxDim of [1280, 960, 720, 480]) {
      const ratio = Math.min(1, maxDim / Math.max(source.naturalWidth || source.width, source.naturalHeight || source.height, 1));
      canvas.width = Math.max(1, Math.round((source.naturalWidth || source.width) * ratio));
      canvas.height = Math.max(1, Math.round((source.naturalHeight || source.height) * ratio));
      context.clearRect(0, 0, canvas.width, canvas.height);
      context.drawImage(source, 0, 0, canvas.width, canvas.height);
      for (const quality of [0.82, 0.72, 0.62, 0.52]) {
        const encoded = canvas.toDataURL('image/jpeg', quality).split(',').at(1) || '';
        if (encoded) best = encoded;
        if (encoded && encoded.length <= maxBase64Bytes) return encoded;
      }
    }
    return best || attachment.contentBase64;
  }

  async function sendOutboundMessage(message: LiveAgentOutboundMessage): Promise<void> {
    const text = outboundText(message);
    const images = message.attachments.filter((attachment) => attachment.kind === 'image');
    appendMessage('user', outboundDisplayText(message), message.attachments);

    if (configRef.current.omniProvider === 'qwen-bailian') {
      if (text) {
        await sendRealtime({
          type: 'conversation.item.create',
          item: {
            id: localId('liveitem'),
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text }]
          }
        });
      }
      if (images.length > 0) {
        await sendRealtime({ type: 'input_audio_buffer.append', audio: silencePcm16Base64(16000, 120) });
        for (const image of images.slice(0, 3)) {
          await sendRealtime({ type: 'input_image_buffer.append', image: await imageToJpegBase64(image) });
        }
        await sendRealtime({ type: 'input_audio_buffer.commit' });
      }
      await createResponse();
      return;
    }

    const content: Record<string, unknown>[] = [{ type: 'input_text', text }];
    for (const image of images) {
      content.push({ type: 'input_image', image_url: dataUrl(image), detail: 'auto' });
    }
    await sendRealtime({
      type: 'conversation.item.create',
      item: {
        id: localId('liveitem'),
        type: 'message',
        role: 'user',
        content
      }
    });
    await createResponse();
  }

  async function sendText(): Promise<void> {
    const text = textInput.trim();
    if (!text || !connected) return;
    setTextInput('');
    appendMessage('user', text);
    await sendRealtime({
      type: 'conversation.item.create',
      item: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text }]
      }
    });
    await createResponse();
  }

  return (
    <section className={`${embedded ? '' : 'page '}live-agent-page`}>
      {!hideHeader && <div className="live-agent-header">
        <div>
          <h1>{tr('Live Agent', '实时智能体')}</h1>
          <p>{tr('Omni realtime conversation in front, Harness AgentLoop tasks in the background.', '前台 Omni 实时对话，后台 Harness AgentLoop 多任务执行。')}</p>
        </div>
        <div className="live-agent-actions">
          <span className={`status-pill ${connected ? 'ok' : canStart ? 'warn' : 'warn'}`}>
            <span className="dot" /> {connected ? tr('Live', '实时中') : status === 'connecting' ? tr('Connecting', '连接中') : tr('Idle', '空闲')}
          </span>
          {embedded && !connected && (
            <button className="ghost-button" onClick={onClose}>
              {tr('Back to Chat', '返回对话')}
            </button>
          )}
          <button className={connected ? 'danger-button' : 'primary-button'} disabled={!canStart && !connected} onClick={() => void (connected ? stopSession() : startSession())}>
            {connected ? tr('Hang Up', '挂断') : tr('Start Live', '开始实时')}
          </button>
          <button className="ghost-button" disabled={!connected} onClick={() => void toggleMic()}>
            {micActive ? tr('Mute', '静音') : tr('Mic', '麦克风')}
          </button>
        </div>
      </div>}

      {!canStart && (
        <div className="notice-box">{tr('Configure Omni model, Realtime URL, and API key in Settings first.', '请先在设置中配置 Omni 模型、Realtime URL 和 API Key。')}</div>
      )}
      <div className="live-agent-grid">
        <section className="live-conversation-panel">
          <div className="live-panel-header">
            <strong>{tr('Conversation', '对话')}</strong>
            <div className="live-panel-meta">
              <div className={`live-waveform ${micLevel > 0.04 ? 'active' : ''}`} aria-hidden="true">
                {[0.55, 0.82, 1, 0.7, 0.95, 0.62].map((factor, index) => (
                  <span
                    key={factor}
                    style={{ transform: `scaleY(${Math.max(0.16, Math.min(1, micLevel * factor + (index % 2 ? 0.12 : 0.06)))})` }}
                  />
                ))}
              </div>
              {(
                <select
                  className="live-mic-select"
                  value={selectedAudioInputId}
                  disabled={status === 'connecting' || audioInputs.length === 0}
                  title={tr('Microphone input', '麦克风输入')}
                  aria-label={tr('Microphone input', '麦克风输入')}
                  onChange={(event) => void selectAudioInput(event.target.value)}
                >
                  {audioInputs.length === 0 && <option value="">{tr('No microphone detected', '未检测到麦克风')}</option>}
                  {audioInputs.map((input) => (
                    <option key={input.deviceId || input.label} value={input.deviceId}>{input.label}</option>
                  ))}
                </select>
              )}
            </div>
          </div>
          <div className="live-message-list">
            {messages.map((message) => (
              <article key={message.id} className={`msg-row ${message.role === 'assistant' ? 'ai' : 'user'}`}>
                <div className="msg-avatar">{message.role === 'assistant' ? 'AI' : 'You'}</div>
                <div className="msg-bubble-wrap">
                  <div className="msg-bubble" dangerouslySetInnerHTML={markdown(message.content)} />
                  <div className="msg-time">{new Date(message.createdAt).toLocaleString()}</div>
                </div>
              </article>
            ))}
            {userTranscriptDraft.trim() && (
              <article className="msg-row user">
                <div className="msg-avatar">You</div>
                <div className="msg-bubble-wrap">
                  <div className="msg-bubble" dangerouslySetInnerHTML={markdown(userTranscriptDraft)} />
                </div>
              </article>
            )}
            {assistantDraft.trim() && (
              <article className="msg-row ai">
                <div className="msg-avatar">AI</div>
                <div className="msg-bubble-wrap">
                  <div className="msg-bubble" dangerouslySetInnerHTML={markdown(assistantDraft)} />
                </div>
              </article>
            )}
            {!messages.length && !userTranscriptDraft && !assistantDraft && <div className="empty-state"><div className="empty-title">{tr('Ready for full duplex conversation', '准备开始全双工对话')}</div></div>}
            <div ref={endRef} />
          </div>
          {!hideComposer && <div className="live-input-row">
            <input
              value={textInput}
              disabled={!connected}
              onChange={(event) => setTextInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') void sendText();
              }}
              placeholder={tr('Send text into the live conversation', '发送文字到实时对话')}
            />
            <button className="primary-button" disabled={!connected || !textInput.trim()} onClick={() => void sendText()}>{tr('Send', '发送')}</button>
          </div>}
        </section>

        <aside className="live-task-panel">
          <div className="live-panel-header">
            <strong>{tr('Background Tasks', '后台任务')}</strong>
            <span>{activeTasks.length} {tr('active', '进行中')}</span>
          </div>
          <div className="live-task-list">
            {tasks.map((task) => {
              const reasoning = mergedTaskTrace(task, ['Reasoning']);
              const output = task.error || task.result || (task.status === 'completed' ? tr('No result content.', '暂无结果内容。') : '');
              return (
                <article
                  key={task.id}
                  className={`live-task-card ${task.status} ${selectedTask?.id === task.id ? 'selected' : ''}`}
                  role="button"
                  tabIndex={0}
                  onClick={() => setSelectedTaskId(task.id)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault();
                      setSelectedTaskId(task.id);
                    }
                  }}
                >
                  <div className="live-task-card-top">
                    <strong>{task.name}</strong>
                    <span>{taskStatusText(task, tr)}</span>
                  </div>
                  <div className="live-task-section">
                    <strong>{tr('Input', '输入')}</strong>
                    <p>{task.prompt}</p>
                  </div>
                  {reasoning.length > 0 && (
                    <div className="live-task-section">
                      <strong>{tr('Reasoning', '推理过程')}</strong>
                      <div className="live-task-trace-preview">
                        {reasoning.map((trace) => (
                          <pre key={trace.id}>{trace.content}</pre>
                        ))}
                      </div>
                    </div>
                  )}
                  {output && <div className="live-task-result" dangerouslySetInnerHTML={markdown(output)} />}
                  {(task.status === 'queued' || task.status === 'running') && (
                    <button
                      className="mini-button"
                      onClick={(event) => {
                        event.stopPropagation();
                        void window.tasiHarness.liveTasks.stop(task.id);
                      }}
                    >
                      {tr('Cancel', '取消')}
                    </button>
                  )}
                </article>
              );
            })}
            {!tasks.length && <p className="tool-empty">{tr('No background tasks yet.', '暂无后台任务。')}</p>}
          </div>
        </aside>

        <aside className="live-trace-panel">
          <div className="live-panel-header">
            <strong>{tr('Trace', '轨迹')}</strong>
            <span>{selectedTaskTrace.length}</span>
          </div>
          <div className="live-trace-list" ref={traceListRef}>
            {selectedTaskTrace.map((trace) => (
              <div key={trace.id} className="tool-event-card">
                <div className="tool-event-top"><strong>{traceLabelText(trace.label, tr)}</strong><span>{trace.title}</span></div>
                <pre className="code-block small">{trace.content}</pre>
              </div>
            ))}
            {!selectedTaskTrace.length && <p className="tool-empty">{selectedTask ? tr('No trace for this task yet.', '这个任务还没有轨迹。') : tr('Select a background task to inspect its trace.', '选择一个后台任务查看轨迹。')}</p>}
          </div>
        </aside>
      </div>
    </section>
  );
}
