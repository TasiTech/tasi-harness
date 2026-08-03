import { randomBytes, createHash } from 'node:crypto';
import { request as httpsRequest } from 'node:https';
import type { IncomingMessage } from 'node:http';
import type { TLSSocket } from 'node:tls';
import type { AppConfig, LiveRealtimeClientEvent, LiveRealtimeEvent, LiveRealtimeStartRequest, LiveRealtimeStartResult } from '../../shared/types.js';
import { createId, nowIso } from '../../shared/types.js';

type RealtimeEventListener = (event: LiveRealtimeEvent) => void;
type RealtimeLogger = (event: string, details?: Record<string, unknown>) => void;
const NOT_CONNECTED_MESSAGE = 'Realtime WebSocket is not connected.';

function realtimeLogPayload(event: LiveRealtimeClientEvent): Record<string, unknown> {
  const session = event.session && typeof event.session === 'object' ? event.session as Record<string, unknown> : null;
  if (event.type !== 'session.update' || !session) return { type: event.type };
  const tools = Array.isArray(session.tools) ? session.tools : [];
  const turnDetection = session.turn_detection && typeof session.turn_detection === 'object'
    ? session.turn_detection as Record<string, unknown>
    : {};
  return {
    type: event.type,
    modalities: session.modalities,
    voice: session.voice,
    inputAudioFormat: session.input_audio_format,
    outputAudioFormat: session.output_audio_format,
    turnDetectionType: turnDetection.type,
    instructionLength: typeof session.instructions === 'string' ? session.instructions.length : 0,
    toolCount: tools.length,
    hasToolChoice: Object.prototype.hasOwnProperty.call(session, 'tool_choice')
  };
}

function stripClientMetadata(event: LiveRealtimeClientEvent): LiveRealtimeClientEvent {
  const payload: LiveRealtimeClientEvent = { type: event.type };
  for (const [key, value] of Object.entries(event)) {
    if (key === 'type' || key.startsWith('_client')) continue;
    payload[key] = value;
  }
  return payload;
}

function audioAppendLogPayload(event: LiveRealtimeClientEvent, count: number): Record<string, unknown> {
  const audio = typeof event.audio === 'string' ? event.audio : '';
  return {
    count,
    base64Chars: audio.length,
    approxBytes: audio ? Math.floor(audio.length * 3 / 4) : 0,
    clientLevel: typeof event._clientAudioLevel === 'number' ? Number(event._clientAudioLevel.toFixed(6)) : undefined,
    clientPeak: typeof event._clientAudioPeak === 'number' ? Number(event._clientAudioPeak.toFixed(6)) : undefined,
    inputSampleRate: event._clientInputSampleRate,
    targetSampleRate: event._clientTargetSampleRate,
    inputFrames: event._clientInputFrames
  };
}

function realtimeServerEventLogPayload(event: LiveRealtimeClientEvent): Record<string, unknown> | null {
  const type = String(event.type || '');
  if (!type) return null;
  if (type === 'error') return { type, error: event.error ?? event.message ?? event };
  if (type === 'session.created' || type === 'session.updated') {
    const session = event.session && typeof event.session === 'object' ? event.session as Record<string, unknown> : {};
    const turnDetection = session.turn_detection && typeof session.turn_detection === 'object'
      ? session.turn_detection as Record<string, unknown>
      : null;
    return {
      type,
      modalities: session.modalities,
      inputAudioFormat: session.input_audio_format,
      outputAudioFormat: session.output_audio_format,
      voice: session.voice,
      turnDetectionType: turnDetection?.type ?? null,
      inputTranscription: session.input_audio_transcription ?? null
    };
  }
  if (type === 'conversation.item.input_audio_transcription.completed') {
    return {
      type,
      transcript: typeof event.transcript === 'string' ? event.transcript.slice(0, 1000) : '',
      text: typeof event.text === 'string' ? event.text.slice(0, 1000) : ''
    };
  }
  if (type === 'response.audio_transcript.done' || type === 'response.text.done') {
    return {
      type,
      transcript: typeof event.transcript === 'string' ? event.transcript.slice(0, 1000) : '',
      text: typeof event.text === 'string' ? event.text.slice(0, 1000) : ''
    };
  }
  if (/failed|invalid|rate_limit|disconnect|close/i.test(type)) return { type, event };
  if (/audio\.delta|output_audio\.delta|input_audio_buffer\.append/i.test(type)) return null;
  return { type };
}

function realtimeWebSocketUrl(baseUrl: string, model: string): URL {
  const raw = (baseUrl.trim() || 'wss://api.openai.com/v1/realtime').replace(/\/+$/, '');
  const url = new URL(raw);
  if (url.protocol === 'https:') url.protocol = 'wss:';
  if (url.protocol !== 'wss:') throw new Error('Realtime WebSocket URL must start with wss://.');
  if (!url.searchParams.has('model')) url.searchParams.set('model', model.trim());
  return url;
}

function qwenWorkspaceIdFromUrl(url: URL): string {
  const explicit = url.searchParams.get('workspaceId') || url.searchParams.get('workspace_id') || '';
  if (explicit.trim()) return explicit.trim();
  const match = /^([^.]+)\.cn-beijing\.maas\.aliyuncs\.com$/i.exec(url.hostname);
  return match?.[1] || '';
}

function qwenPath(url: URL): string {
  const next = new URL(url.toString());
  next.searchParams.delete('workspaceId');
  next.searchParams.delete('workspace_id');
  return `${next.pathname}${next.search}`;
}

function liveToolSchema(): Record<string, unknown> {
  return {
    name: 'create_live_task',
    description: 'Create a background AgentLoop task for complex, slow, tool-using, file/code/browser/research, or explicitly delegated work. Do not use this for greetings, casual chat, or simple questions.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        name: {
          type: 'string',
          description: 'Short task title.'
        },
        task: {
          type: 'string',
          description: 'Complete user request for the background AgentLoop.'
        }
      },
      required: ['task']
    }
  };
}

function buildLiveTools(config: AppConfig): LiveRealtimeClientEvent[] {
  const tool = liveToolSchema();
  if (config.omniProvider === 'qwen-bailian') {
    return [
      {
        type: 'function',
        function: tool
      }
    ];
  }
  return [
    {
      type: 'function',
      ...tool
    }
  ];
}

function qwenDefaultVoice(model: string): string {
  return /qwen3-omni/i.test(model) ? 'Cherry' : 'Tina';
}

function buildSessionUpdate(config: AppConfig, req: LiveRealtimeStartRequest): LiveRealtimeClientEvent {
  const isQwen = config.omniProvider === 'qwen-bailian';
  const baseInstructions = [
    req.instructions?.trim() || '',
    'You are the realtime voice front end for Tasi Harness live_agent mode.',
    'You handle full duplex voice conversation: listen to user speech, answer with short spoken responses, and keep the conversation moving naturally.',
    'Use create_live_task to hand difficult work to the background Harness AgentLoop task queue.',
    'After creating a background task, briefly tell the user it has been queued and continue the conversation.',
    [
      '## Live Task Queue Policy',
      '- The user system prompt / agent instruction is authoritative for deciding whether a request should become a background task.',
      '- Call create_live_task when the system prompt says this class of request should be queued or delegated.',
      '- Also call create_live_task when the request is clearly complex, slow, multi-step, requires tools/files/code/browser actions/research, or can run independently in the background.',
      '- If the current request is simple enough for realtime chat, answer directly in the live conversation.',
      '- Do not create background tasks for greetings, casual conversation, or simple questions unless the system prompt explicitly requires it.'
    ].join('\n')
  ].filter(Boolean).join('\n\n');

  const session: Record<string, unknown> = {
    modalities: ['text', 'audio'],
    instructions: baseInstructions,
    voice: req.voice?.trim() || (isQwen ? qwenDefaultVoice(config.omniModel) : 'alloy'),
    input_audio_format: isQwen ? 'pcm' : 'pcm16',
    output_audio_format: isQwen ? 'pcm' : 'pcm16',
    turn_detection: isQwen
      ? {
          type: 'semantic_vad',
          threshold: 0,
          prefix_padding_ms: 500,
          silence_duration_ms: 900
        }
      : {
          type: 'server_vad',
          threshold: 0.5,
          prefix_padding_ms: 300,
          silence_duration_ms: 700,
          create_response: true,
          interrupt_response: true
        },
    ...(isQwen
      ? {
          input_audio_transcription: {
            model: 'qwen3-asr-flash-realtime'
          }
        }
      : {
          input_audio_transcription: {
            model: 'whisper-1'
          }
        }),
    tools: buildLiveTools(config)
  };

  if (!isQwen) session.tool_choice = 'auto';

  return {
    type: 'session.update',
    session
  };
}

class RealtimeSocket {
  private socket: TLSSocket | null = null;
  private request: ReturnType<typeof httpsRequest> | null = null;
  private buffer = Buffer.alloc(0);
  private closed = false;
  private closeMessage = NOT_CONNECTED_MESSAGE;
  private audioAppendCount = 0;

  constructor(
    private readonly deps: {
      config: AppConfig;
      sessionId: string;
      onEvent: RealtimeEventListener;
      log?: RealtimeLogger;
    }
  ) {}

  connect(): Promise<void> {
    const { config } = this.deps;
    if (!config.omniApiKey) throw new Error('Omni API key is empty.');
    if (!config.omniBaseUrl) throw new Error('Realtime WebSocket URL is empty.');
    if (!config.omniModel) throw new Error('Realtime model is empty.');
    if (config.omniBaseUrl.includes('{WorkspaceId}')) throw new Error('Replace {WorkspaceId} before starting Live Agent.');

    const url = realtimeWebSocketUrl(config.omniBaseUrl, config.omniModel);
    const qwenWorkspaceId = config.omniProvider === 'qwen-bailian' ? qwenWorkspaceIdFromUrl(url) : '';
    const requestPath = config.omniProvider === 'qwen-bailian' ? qwenPath(url) : `${url.pathname}${url.search}`;
    this.log('connect.request', {
      provider: config.omniProvider,
      model: config.omniModel,
      hostname: url.hostname,
      path: requestPath,
      qwenWorkspaceIdPresent: Boolean(qwenWorkspaceId),
      hasApiKey: Boolean(config.omniApiKey)
    });
    const secKey = randomBytes(16).toString('base64');
    return new Promise((resolve, reject) => {
      let settled = false;
      let connectTimer: ReturnType<typeof setTimeout> | null = null;
      const finishResolve = (): void => {
        if (settled) return;
        settled = true;
        if (connectTimer) clearTimeout(connectTimer);
        resolve();
      };
      const finishReject = (error: unknown): void => {
        if (settled) return;
        settled = true;
        if (connectTimer) clearTimeout(connectTimer);
        this.log('connect.reject', {
          message: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined
        });
        reject(error);
      };
      const req = httpsRequest({
        protocol: 'https:',
        hostname: url.hostname,
        port: url.port ? Number(url.port) : undefined,
        path: requestPath,
        method: 'GET',
        timeout: 15000,
        headers: {
          Authorization: `Bearer ${config.omniApiKey}`,
          Connection: 'Upgrade',
          Upgrade: 'websocket',
          'Sec-WebSocket-Key': secKey,
          'Sec-WebSocket-Version': '13',
          'User-Agent': 'tasi-harness-realtime/1.0',
          ...(qwenWorkspaceId ? { 'X-DashScope-WorkSpace': qwenWorkspaceId } : {}),
          ...(config.omniProvider === 'openai' ? { 'OpenAI-Beta': 'realtime=v1' } : {})
        }
      });
      this.request = req;
      connectTimer = setTimeout(() => {
        const error = new Error('Realtime WebSocket connection timed out after 20 seconds.');
        this.closeMessage = error.message;
        req.destroy(error);
        finishReject(error);
      }, 20000);
      req.on('upgrade', (res, socket, head) => {
        this.log('connect.upgrade', {
          statusCode: res.statusCode,
          statusMessage: res.statusMessage,
          headers: {
            date: res.headers.date,
            server: res.headers.server,
            requestId: res.headers['x-request-id'] ?? res.headers['x-dashscope-request-id']
          }
        });
        try {
          this.validateUpgrade(res, secKey);
        } catch (error) {
          socket.destroy();
          finishReject(error);
          return;
        }
        if (this.closed) {
          socket.destroy();
          finishReject(new Error(this.closeMessage));
          return;
        }
        this.socket = socket as TLSSocket;
        this.socket.on('data', (chunk) => this.acceptData(Buffer.from(chunk)));
        this.socket.on('error', (error) => {
          this.closeMessage = error.message;
          this.log('socket.error', { message: error.message, stack: error.stack });
          this.emitStatus('error', error.message);
        });
        this.socket.on('close', () => {
          const wasLocalClose = this.closed;
          const message = this.closeMessage === NOT_CONNECTED_MESSAGE
            ? 'Realtime WebSocket closed unexpectedly before a server error message was received.'
            : this.closeMessage;
          this.socket = null;
          this.request = null;
          this.log('socket.close', { local: wasLocalClose, message });
          if (wasLocalClose) return;
          this.closed = true;
          this.closeMessage = message;
          this.emitStatus('error', message);
        });
        if (head.length > 0) this.acceptData(Buffer.from(head));
        if (this.closed || !this.socket || this.socket.destroyed) {
          finishReject(new Error(this.closeMessage));
          return;
        }
        finishResolve();
      });
      req.on('response', (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
        res.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf8').trim();
          this.log('connect.response', {
            statusCode: res.statusCode,
            statusMessage: res.statusMessage,
            body: body.slice(0, 4000)
          });
          finishReject(new Error(`${res.statusCode ?? 'HTTP'} ${res.statusMessage ?? ''}${body ? `: ${body}` : ''}`.trim()));
        });
      });
      req.on('timeout', () => {
        const error = new Error('Realtime WebSocket connection timed out.');
        this.closeMessage = error.message;
        req.destroy(error);
      });
      req.on('error', (error) => {
        if (this.closed && this.closeMessage === 'Realtime session stopped.') {
          finishReject(new Error(this.closeMessage));
          return;
        }
        this.closeMessage = error.message;
        this.log('request.error', { code: (error as NodeJS.ErrnoException).code, message: error.message, stack: error.stack });
        finishReject(error);
      });
      req.end();
    });
  }

  send(event: LiveRealtimeClientEvent): void {
    if (!this.isConnected()) throw new Error(this.closeMessage);
    const cleaned = stripClientMetadata(event);
    const payload = this.deps.config.omniProvider === 'qwen-bailian' && !cleaned.event_id
      ? { ...cleaned, event_id: createId('event') }
      : cleaned;
    if (payload.type === 'input_audio_buffer.append') {
      this.audioAppendCount += 1;
      if (this.audioAppendCount === 1 || this.audioAppendCount % 50 === 0) {
        this.log('client.audio_append', audioAppendLogPayload(event, this.audioAppendCount));
      }
    } else {
      this.log('client.event', {
        ...realtimeLogPayload(payload),
        ...(payload.type === 'input_audio_buffer.commit' && typeof event._clientCommitSource === 'string'
          ? { clientCommitSource: event._clientCommitSource }
          : {})
      });
    }
    this.writeFrame(1, Buffer.from(JSON.stringify(payload), 'utf8'));
  }

  isConnected(): boolean {
    return !this.closed && Boolean(this.socket && !this.socket.destroyed);
  }

  wasStopped(): boolean {
    return this.closed && this.closeMessage === 'Realtime session stopped.';
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.closeMessage === NOT_CONNECTED_MESSAGE) this.closeMessage = 'Realtime session stopped.';
    this.log('socket.close.request', { message: this.closeMessage });
    try {
      if (this.socket && !this.socket.destroyed) this.writeFrame(8, Buffer.alloc(0));
    } catch {
      // Ignore close frame failures.
    }
    this.request?.destroy();
    this.request = null;
    this.socket?.destroy();
    this.socket = null;
  }

  private validateUpgrade(res: IncomingMessage, secKey: string): void {
    if ((res.statusCode ?? 0) !== 101) throw new Error(`Realtime WebSocket upgrade failed (${res.statusCode ?? 'HTTP'}).`);
    const expected = createHash('sha1')
      .update(`${secKey}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest('base64');
    const accepted = String(res.headers['sec-websocket-accept'] ?? '');
    if (accepted !== expected) throw new Error('Realtime WebSocket upgrade returned an invalid accept key.');
  }

  private acceptData(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length >= 2) {
      const first = this.buffer[0];
      const second = this.buffer[1];
      const opcode = first & 0x0f;
      let offset = 2;
      let length = second & 0x7f;
      if (length === 126) {
        if (this.buffer.length < offset + 2) return;
        length = this.buffer.readUInt16BE(offset);
        offset += 2;
      } else if (length === 127) {
        if (this.buffer.length < offset + 8) return;
        const high = this.buffer.readUInt32BE(offset);
        const low = this.buffer.readUInt32BE(offset + 4);
        if (high > 0) {
          this.close();
          this.emitStatus('error', 'Realtime WebSocket frame is too large.');
          return;
        }
        length = low;
        offset += 8;
      }
      const masked = (second & 0x80) !== 0;
      const maskOffset = masked ? offset : -1;
      if (masked) offset += 4;
      if (this.buffer.length < offset + length) return;
      const mask = masked && maskOffset >= 0 ? this.buffer.subarray(maskOffset, maskOffset + 4) : null;
      let payload = this.buffer.subarray(offset, offset + length);
      this.buffer = this.buffer.subarray(offset + length);
      if (mask) {
        payload = Buffer.from(payload.map((value, index) => value ^ mask[index % 4]));
      }
      if (opcode === 1) this.emitServerEvent(payload.toString('utf8'));
      if (opcode === 8) {
        this.closeMessage = this.closeReason(payload);
        this.log('socket.close.frame', { message: this.closeMessage });
        this.emitStatus('error', this.closeMessage);
        this.close();
      }
      if (opcode === 9) this.writeFrame(10, payload);
    }
  }

  private closeReason(payload: Buffer): string {
    if (payload.length < 2) return 'Realtime WebSocket closed.';
    const code = payload.readUInt16BE(0);
    const reason = payload.subarray(2).toString('utf8').trim();
    return `Realtime WebSocket closed (${code})${reason ? `: ${reason}` : '.'}`;
  }

  private writeFrame(opcode: number, payload: Buffer): void {
    const socket = this.socket;
    if (!socket || socket.destroyed) return;
    const mask = randomBytes(4);
    const length = payload.length;
    const headerLength = length < 126 ? 2 : length <= 0xffff ? 4 : 10;
    const header = Buffer.alloc(headerLength);
    header[0] = 0x80 | opcode;
    if (length < 126) {
      header[1] = 0x80 | length;
    } else if (length <= 0xffff) {
      header[1] = 0x80 | 126;
      header.writeUInt16BE(length, 2);
    } else {
      header[1] = 0x80 | 127;
      header.writeUInt32BE(0, 2);
      header.writeUInt32BE(length, 6);
    }
    const maskedPayload = Buffer.alloc(length);
    for (let index = 0; index < length; index += 1) maskedPayload[index] = payload[index] ^ mask[index % 4];
    socket.write(Buffer.concat([header, mask, maskedPayload]));
  }

  private emitServerEvent(text: string): void {
    try {
      const event = JSON.parse(text) as LiveRealtimeClientEvent;
      const logPayload = realtimeServerEventLogPayload(event);
      if (logPayload) this.log('server.event', logPayload);
      this.deps.onEvent({
        sessionId: this.deps.sessionId,
        event,
        createdAt: nowIso()
      });
    } catch {
      this.log('server.raw_text', { text: text.slice(0, 4000) });
      this.deps.onEvent({
        sessionId: this.deps.sessionId,
        event: { type: 'raw.text', text },
        createdAt: nowIso()
      });
    }
  }

  private emitStatus(status: LiveRealtimeEvent['status'], message: string): void {
    if (status === 'closed' && this.closed) return;
    this.log('status', { status, message });
    this.deps.onEvent({ sessionId: this.deps.sessionId, status, message, createdAt: nowIso() });
  }

  private log(event: string, details?: Record<string, unknown>): void {
    this.deps.log?.(event, {
      sessionId: this.deps.sessionId,
      provider: this.deps.config.omniProvider,
      model: this.deps.config.omniModel,
      ...details
    });
  }
}

export class RealtimeSessionManager {
  private active: { sessionId: string; socket: RealtimeSocket } | null = null;

  constructor(
    private readonly deps: {
      getConfig: () => AppConfig;
      onEvent: RealtimeEventListener;
      log?: RealtimeLogger;
    }
  ) {}

  async start(req: LiveRealtimeStartRequest = {}): Promise<LiveRealtimeStartResult> {
    this.stop();
    const config = this.deps.getConfig();
    const sessionId = req.sessionId?.trim() || createId('live');
    this.log('start.request', {
      sessionId,
      provider: config.omniProvider,
      model: config.omniModel,
      baseUrl: config.omniBaseUrl,
      hasApiKey: Boolean(config.omniApiKey),
      instructionLength: req.instructions?.length ?? 0,
      requestedVoice: req.voice || ''
    });
    const socket = new RealtimeSocket({ config, sessionId, onEvent: this.deps.onEvent, log: this.deps.log });
    this.active = { sessionId, socket };
    this.deps.onEvent({ sessionId, status: 'connecting', message: 'Connecting realtime model...', createdAt: nowIso() });
    try {
      await socket.connect();
    } catch (error) {
      if (socket.wasStopped() || !this.active || this.active.socket !== socket) {
        return { sessionId, provider: config.omniProvider, model: config.omniModel, status: 'closed' };
      }
      this.active = null;
      this.log('start.error', {
        sessionId,
        provider: config.omniProvider,
        model: config.omniModel,
        message: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined
      });
      this.deps.onEvent({
        sessionId,
        status: 'error',
        message: error instanceof Error ? error.message : String(error),
        createdAt: nowIso()
      });
      throw error;
    }
    if (!this.active || this.active.socket !== socket || !socket.isConnected()) {
      this.log('start.closed_before_session_update', { sessionId, provider: config.omniProvider, model: config.omniModel });
      return { sessionId, provider: config.omniProvider, model: config.omniModel, status: 'closed' };
    }
    const sessionUpdate = buildSessionUpdate(config, req);
    this.log('session.update.prepare', {
      sessionId,
      provider: config.omniProvider,
      model: config.omniModel,
      ...realtimeLogPayload(sessionUpdate)
    });
    socket.send(sessionUpdate);
    this.deps.onEvent({ sessionId, status: 'connected', message: 'Realtime model connected.', createdAt: nowIso() });
    this.log('start.connected', { sessionId, provider: config.omniProvider, model: config.omniModel });
    return { sessionId, provider: config.omniProvider, model: config.omniModel, status: 'connected' };
  }

  send(event: LiveRealtimeClientEvent): void {
    if (!this.active) throw new Error('Live Realtime is not connected.');
    this.active.socket.send(event);
  }

  stop(): void {
    if (!this.active) return;
    const sessionId = this.active.sessionId;
    this.log('stop.request', { sessionId });
    this.active.socket.close();
    this.active = null;
    this.deps.onEvent({ sessionId, status: 'closed', message: 'Realtime session stopped.', createdAt: nowIso() });
  }

  private log(event: string, details?: Record<string, unknown>): void {
    this.deps.log?.(event, details);
  }
}
