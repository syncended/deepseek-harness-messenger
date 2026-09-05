import { ManagedWhisperRuntime } from './whisper-runtime.js';

export interface VoiceConfig {
  enabled: boolean;
  model: 'tiny' | 'base' | 'small' | 'medium' | 'large-v3' | 'turbo';
  device: 'auto' | 'cpu' | 'cuda';
}

export const DEFAULT_VOICE_CONFIG: VoiceConfig = Object.freeze({ enabled: true, model: 'small', device: 'auto' });

export interface VoiceTranscriber {
  transcribe(request: {
    loadAudio: (signal: AbortSignal) => Promise<Uint8Array>;
    signal: AbortSignal;
    onProgress: (text: string) => void;
  }): Promise<string>;
  dispose(): Promise<void>;
}

export interface WhisperRuntime {
  transcribe(audio: Uint8Array, config: VoiceConfig, signal: AbortSignal, onProgress: (text: string) => void): Promise<string>;
  stop(): Promise<void>;
}

/** Test seam; construction of the default runtime performs no IO. */
export interface VoiceDependencies {
  createRuntime?: () => WhisperRuntime;
  requestTimeoutMs?: number;
  audioTimeoutMs?: number;
}

type Request = Parameters<VoiceTranscriber['transcribe']>[0];
interface Task {
  owner: LocalWhisperTranscriber;
  request: Request;
  controller: AbortController;
  resolve: (text: string) => void;
  reject: (error: Error) => void;
  detach: () => void;
}

export function voiceAbortError(): Error {
  return new DOMException('Voice transcription cancelled.', 'AbortError');
}

/** Also bounds a loader which fails to honour its signal. Never expose its errors. */
export async function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    void promise.catch(() => {});
    throw voiceAbortError();
  }
  let cancel: () => void = () => {};
  const aborted = new Promise<never>((_, reject) => {
    cancel = () => reject(voiceAbortError());
    signal.addEventListener('abort', cancel, { once: true });
  });
  try { return await Promise.race([promise, aborted]); }
  finally { signal.removeEventListener('abort', cancel); }
}

// One FIFO per plugin module, not per user or configuration instance. Cap includes
// the active item. Only the active item invokes loadAudio or creates a runtime.
const waiting: Task[] = [];
let active: Task | undefined;
let pumping: Promise<void> | undefined;

function finish(task: Task, result: string | Error): void {
  task.detach();
  if (typeof result === 'string') task.resolve(result);
  else task.reject(result);
}

async function pump(): Promise<void> {
  while (waiting.length) {
    const task = waiting.shift()!;
    active = task;
    let result: string | Error;
    try { result = await task.owner.run(task); }
    catch (error) { result = error instanceof Error ? error : new Error('Local voice transcription failed.'); }
    // No idle daemon. Reuse only while another item from this instance is queued.
    if (task.controller.signal.aborted || waiting[0]?.owner !== task.owner) {
      try { await task.owner.stopRuntime(); }
      catch { result = new Error('Local voice runtime cleanup failed. Restart the host before retrying.'); }
    }
    active = undefined;
    finish(task, task.controller.signal.aborted && !(result instanceof Error) ? voiceAbortError() : result);
  }
}

function kick(): void {
  if (pumping) return;
  pumping = pump().finally(() => {
    pumping = undefined;
    if (waiting.length) kick();
  });
}

export class LocalWhisperTranscriber implements VoiceTranscriber {
  private readonly config: VoiceConfig;
  private readonly dependencies: VoiceDependencies;
  private runtime: WhisperRuntime | undefined;
  private disposed = false;
  private readonly pending = new Set<Promise<string>>();

  constructor(config: VoiceConfig, dependencies: VoiceDependencies = {}) {
    if (typeof config.enabled !== 'boolean' || !['tiny', 'base', 'small', 'medium', 'large-v3', 'turbo'].includes(config.model)
      || !['auto', 'cpu', 'cuda'].includes(config.device)) throw new Error('Invalid local voice configuration.');
    this.config = { ...config };
    this.dependencies = dependencies;
  }

  transcribe(request: Request): Promise<string> {
    if (this.disposed) return Promise.reject(new Error('Voice transcription service is disposed.'));
    if (!this.config.enabled) return Promise.reject(new Error('Voice transcription is disabled.'));
    if (request.signal.aborted) return Promise.reject(voiceAbortError());
    if (waiting.length + (active ? 1 : 0) >= 8) return Promise.reject(new Error('Voice queue is full. Please try again later.'));
    const controller = new AbortController();
    const promise = new Promise<string>((resolve, reject) => {
      const cancel = () => {
        controller.abort();
        const index = waiting.indexOf(task);
        if (index !== -1) {
          waiting.splice(index, 1);
          finish(task, voiceAbortError());
        }
      };
      const task: Task = { owner: this, request, controller, resolve, reject,
        detach: () => request.signal.removeEventListener('abort', cancel) };
      request.signal.addEventListener('abort', cancel, { once: true });
      waiting.push(task);
      kick();
    });
    this.pending.add(promise);
    void promise.then(() => this.pending.delete(promise), () => this.pending.delete(promise));
    return promise;
  }

  /** Internal scheduler entry point, public only to avoid a second scheduler API. */
  async run(task: Task): Promise<string> {
    const { controller, request } = task;
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, this.dependencies.requestTimeoutMs ?? 30 * 60_000);
    const progress = (text: string) => {
      if (!controller.signal.aborted) { try { request.onProgress(text); } catch { /* UI observers cannot break cleanup. */ } }
    };
    try {
      progress('Loading voice audio for local transcription…');
      const loadTimer = setTimeout(() => { timedOut = true; controller.abort(); }, this.dependencies.audioTimeoutMs ?? 60_000);
      let audio: Uint8Array;
      try {
        audio = await abortable(Promise.resolve().then(() => {
          if (controller.signal.aborted) throw voiceAbortError();
          return request.loadAudio(controller.signal);
        }), controller.signal);
      }
      catch { throw controller.signal.aborted ? voiceAbortError() : new Error('Could not load voice audio. Please retry.'); }
      finally { clearTimeout(loadTimer); }
      if (!(audio instanceof Uint8Array) || !audio.byteLength || audio.byteLength > 20 * 1024 * 1024) {
        throw new Error('Voice audio must be nonempty and no larger than 20 MB.');
      }
      controller.signal.throwIfAborted();
      this.runtime ??= this.dependencies.createRuntime?.() ?? new ManagedWhisperRuntime();
      return await this.runtime.transcribe(audio, this.config, controller.signal, progress);
    } catch (error) {
      if (timedOut) throw new Error('Local voice transcription timed out. Try a smaller model or shorter recording.');
      if (controller.signal.aborted) throw voiceAbortError();
      throw error;
    } finally { clearTimeout(timer); }
  }

  async stopRuntime(): Promise<void> {
    const runtime = this.runtime;
    this.runtime = undefined;
    if (runtime) await runtime.stop();
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    for (let i = waiting.length - 1; i >= 0; i--) {
      const task = waiting[i]!;
      if (task.owner === this) {
        waiting.splice(i, 1);
        task.controller.abort();
        finish(task, voiceAbortError());
      }
    }
    if (active?.owner === this) active.controller.abort();
    await Promise.allSettled([...this.pending]);
    await this.stopRuntime();
  }
}
