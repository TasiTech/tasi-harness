const BYTE_CHUNK = 0x8000;
const DEFAULT_INPUT_SAMPLE_RATE = 24000;
const OUTPUT_SAMPLE_RATE = 24000;

export interface LiveMicCapture {
  stop: () => void;
}

export interface LiveMicChunkInfo {
  inputSampleRate: number;
  targetSampleRate: number;
  inputFrames: number;
  pcmBytes: number;
  peak: number;
}

export interface LiveMicOptions {
  deviceId?: string;
  chunkBytes?: number;
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let index = 0; index < bytes.length; index += BYTE_CHUNK) {
    const chunk = bytes.subarray(index, index + BYTE_CHUNK);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

export function base64ToBytes(encoded: string): Uint8Array {
  const binary = atob(encoded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function rms(input: Float32Array): number {
  let sum = 0;
  for (let index = 0; index < input.length; index += 1) sum += input[index] * input[index];
  return Math.sqrt(sum / Math.max(1, input.length));
}

function peak(input: Float32Array): number {
  let max = 0;
  for (let index = 0; index < input.length; index += 1) max = Math.max(max, Math.abs(input[index]));
  return max;
}

function downsampleToPcm16(input: Float32Array, inputRate: number, targetRate: number): Int16Array {
  if (inputRate === targetRate) {
    const direct = new Int16Array(input.length);
    for (let index = 0; index < input.length; index += 1) {
      const sample = Math.max(-1, Math.min(1, input[index]));
      direct[index] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
    }
    return direct;
  }
  const ratio = inputRate / targetRate;
  const length = Math.max(1, Math.round(input.length / ratio));
  const out = new Int16Array(length);
  let inputOffset = 0;
  for (let outputIndex = 0; outputIndex < length; outputIndex += 1) {
    const nextInputOffset = Math.round((outputIndex + 1) * ratio);
    let sum = 0;
    let count = 0;
    for (let inputIndex = inputOffset; inputIndex < nextInputOffset && inputIndex < input.length; inputIndex += 1) {
      sum += input[inputIndex];
      count += 1;
    }
    inputOffset = nextInputOffset;
    const sample = Math.max(-1, Math.min(1, count > 0 ? sum / count : 0));
    out[outputIndex] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
  }
  return out;
}

function int16ToBytes(input: Int16Array): Uint8Array {
  const bytes = new Uint8Array(input.length * 2);
  const view = new DataView(bytes.buffer);
  for (let index = 0; index < input.length; index += 1) view.setInt16(index * 2, input[index], true);
  return bytes;
}

export async function startLiveMic(
  onChunk: (base64Pcm: string, level: number, info: LiveMicChunkInfo) => void,
  targetSampleRate = DEFAULT_INPUT_SAMPLE_RATE,
  options: LiveMicOptions = {}
): Promise<LiveMicCapture> {
  const audio: true | MediaTrackConstraints = options.deviceId ? { deviceId: { exact: options.deviceId } } : true;
  const stream = await navigator.mediaDevices.getUserMedia({ audio, video: false });
  const context = new AudioContext();
  await context.resume().catch(() => undefined);
  const source = context.createMediaStreamSource(stream);
  const processor = context.createScriptProcessor(4096, 1, 1);
  let uploadBuffer: number[] = [];
  let lastInfo: LiveMicChunkInfo | null = null;

  const emitBytes = (bytes: Uint8Array, level: number, info: LiveMicChunkInfo): void => {
    if (bytes.byteLength <= 0) return;
    onChunk(bytesToBase64(bytes), level, { ...info, pcmBytes: bytes.byteLength });
  };

  processor.onaudioprocess = (event) => {
    const input = event.inputBuffer.getChannelData(0);
    event.outputBuffer.getChannelData(0).fill(0);
    const level = rms(input);
    const bytes = int16ToBytes(downsampleToPcm16(input, context.sampleRate, targetSampleRate));
    if (bytes.byteLength <= 0) return;
    const info = {
        inputSampleRate: context.sampleRate,
        targetSampleRate,
        inputFrames: input.length,
        pcmBytes: bytes.byteLength,
        peak: peak(input)
      };
    lastInfo = info;
    if (options.chunkBytes && options.chunkBytes > 0) {
      uploadBuffer.push(...bytes);
      while (uploadBuffer.length >= options.chunkBytes) {
        const chunk = new Uint8Array(uploadBuffer.slice(0, options.chunkBytes));
        uploadBuffer = uploadBuffer.slice(options.chunkBytes);
        emitBytes(chunk, level, info);
      }
    } else {
      emitBytes(bytes, level, info);
    }
  };
  source.connect(processor);
  processor.connect(context.destination);
  return {
    stop: () => {
      if (uploadBuffer.length > 0 && lastInfo) {
        emitBytes(new Uint8Array(uploadBuffer), 0, lastInfo);
        uploadBuffer = [];
      }
      processor.disconnect();
      source.disconnect();
      stream.getTracks().forEach((track) => track.stop());
      void context.close().catch(() => undefined);
    }
  };
}

export class PcmStreamPlayer {
  private context: AudioContext | null = null;
  private nextTime = 0;
  private sources = new Set<AudioBufferSourceNode>();

  enqueue(base64Pcm: string, sampleRate = OUTPUT_SAMPLE_RATE): void {
    const bytes = base64ToBytes(base64Pcm);
    if (bytes.byteLength < 2) return;
    const context = this.context ?? new AudioContext({ sampleRate });
    this.context = context;
    if (context.state === 'suspended') void context.resume().catch(() => undefined);
    const samples = new Int16Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.byteLength / 2));
    const floats = new Float32Array(samples.length);
    for (let index = 0; index < samples.length; index += 1) floats[index] = samples[index] / 0x8000;
    const buffer = context.createBuffer(1, floats.length, sampleRate);
    buffer.copyToChannel(floats, 0);
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(context.destination);
    const startAt = Math.max(this.nextTime, context.currentTime);
    this.nextTime = startAt + buffer.duration;
    source.start(startAt);
    this.sources.add(source);
    source.onended = () => this.sources.delete(source);
  }

  stop(): void {
    for (const source of this.sources) {
      try {
        source.stop();
      } catch {
        // Ignore already-stopped buffers.
      }
    }
    this.sources.clear();
    if (this.context) this.nextTime = this.context.currentTime;
  }

  async close(): Promise<void> {
    this.stop();
    const context = this.context;
    this.context = null;
    if (context) await context.close();
  }
}
