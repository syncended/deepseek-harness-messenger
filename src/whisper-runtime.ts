import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { access, chmod, mkdir, mkdtemp, open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir, release } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { abortable, voiceAbortError, type VoiceConfig, type WhisperRuntime } from './voice.js';

export const UV_VERSION = '0.6.17';
export const PYTHON_VERSION = '3.12.10';
// Exact dependency closure, wheels only: never execute source builds or consult a
// user's pip/uv config. Upgrade together with ENV_VERSION and platform checks.
export const PYTHON_PACKAGES = [
  'faster-whisper==1.2.1', 'ctranslate2==4.6.0', 'av==16.0.1', 'onnxruntime==1.22.1',
  'numpy==2.2.6', 'tokenizers==0.21.4', 'huggingface-hub==0.34.4', 'hf-xet==1.1.9',
  'setuptools==80.9.0', 'pyyaml==6.0.2', 'tqdm==4.67.1', 'filelock==3.19.1',
  'fsspec==2025.9.0', 'packaging==25.0', 'typing-extensions==4.15.0',
  'requests==2.32.4', 'charset-normalizer==3.4.3', 'idna==3.10', 'urllib3==2.5.0',
  'certifi==2025.8.3', 'coloredlogs==15.0.1', 'humanfriendly==10.0',
  'flatbuffers==25.2.10', 'protobuf==6.32.0', 'sympy==1.14.0', 'mpmath==1.3.0',
] as const;
const ENV_VERSION = `v1-py${PYTHON_VERSION}-${createHash('sha256').update(PYTHON_PACKAGES.join('\n')).digest('hex').slice(0, 12)}`;
// SHA256 values from the corresponding official release *.tar.gz.sha256 assets:
// https://github.com/astral-sh/uv/releases/tag/0.6.17 . No installer scripts.
const ARCHIVES: Record<string, string> = {
  'x86_64-unknown-linux-gnu': '720ec28f7a94aa8cd91d3d57dec1434d64b9ae13d1dd6a25f4c0cdb837ba9cf6',
  'aarch64-unknown-linux-gnu': '6fb716c36e8ca9cf98b7cb347b0ced41679145837eb22890ee5fa9d8b68ce9f5',
  'aarch64-apple-darwin': 'e686c73b9314c77a36a6a4c9f94b07c001f0c9157c50c63c764941141c0d0088',
  'x86_64-apple-darwin': '61e9bdc02aacdb994da6ea2a477b11b34c23fc09203237aeee8d3817daab012d',
};

export interface HostPlatform { platform: string; arch: string; glibc?: string; osRelease?: string }
export function supportedTarget(host?: HostPlatform): string {
  if (!host) {
    const header = process.platform === 'linux'
      ? (process.report.getReport() as { header: { glibcVersionRuntime?: string } }).header : {};
    host = { platform: process.platform, arch: process.arch, osRelease: release(),
      ...(header.glibcVersionRuntime ? { glibc: header.glibcVersionRuntime } : {}) };
  }
  const arch = host.arch === 'x64' ? 'x86_64' : host.arch === 'arm64' ? 'aarch64' : undefined;
  if (arch && host.platform === 'linux' && host.glibc) {
    const [major, minor] = host.glibc.split('.').map(Number);
    if (major! > 2 || (major === 2 && minor! >= 28)) return `${arch}-unknown-linux-gnu`;
  }
  // PyAV arm64 wheels require macOS 14; require the same baseline on Intel.
  if (arch && host.platform === 'darwin' && Number(host.osRelease?.split('.')[0]) >= 23) return `${arch}-apple-darwin`;
  throw new Error('Local voice requires Linux x64/arm64 with glibc 2.28+ or macOS 14+ (Intel/Apple Silicon). Windows: use a Linux WSL2 host. Alpine/musl and 32-bit hosts are unsupported; disable voice or move the host.');
}

export function runtimePaths(env: NodeJS.ProcessEnv = process.env, home = homedir(), platform = process.platform): { data: string; cache: string } {
  const absolute = (value: string | undefined, fallback: string) => value && isAbsolute(value) ? value : fallback;
  if (platform === 'darwin') return {
    data: join(home, 'Library', 'Application Support', 'dsh-messenger', 'voice'),
    cache: join(home, 'Library', 'Caches', 'dsh-messenger', 'voice'),
  };
  return {
    data: join(absolute(env.XDG_DATA_HOME, join(home, '.local', 'share')), 'dsh-messenger', 'voice'),
    cache: join(absolute(env.XDG_CACHE_HOME, join(home, '.cache')), 'dsh-messenger', 'voice'),
  };
}

/** Extract only the expected regular binary, not arbitrary archive paths/symlinks. */
export function extractUv(archive: Uint8Array, target: string, checksum = ARCHIVES[target]): Buffer {
  if (!checksum || createHash('sha256').update(archive).digest('hex') !== checksum) throw new Error('Local voice bootstrap checksum verification failed. Retry on a trusted connection.');
  const tar = gunzipSync(archive, { maxOutputLength: 160 * 1024 * 1024 });
  for (let offset = 0; offset + 512 <= tar.length;) {
    const header = tar.subarray(offset, offset + 512);
    const name = header.subarray(0, 100).toString().replace(/\0.*$/s, '');
    const size = Number.parseInt(header.subarray(124, 136).toString().replace(/\0.*$/s, '').trim(), 8);
    if (!name) break;
    if (!Number.isSafeInteger(size) || size < 0 || offset + 512 + size > tar.length) break;
    if (name === `uv-${target}/uv` && (header[156] === 0 || header[156] === 48)) {
      return tar.subarray(offset + 512, offset + 512 + size);
    }
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  throw new Error('Local voice bootstrap archive is invalid.');
}

async function exists(path: string): Promise<boolean> { try { await access(path); return true; } catch { return false; } }

export async function downloadUv(target: string, signal: AbortSignal, fetcher: typeof fetch = fetch): Promise<Buffer> {
  const url = `https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/uv-${target}.tar.gz`;
  const timeout = AbortSignal.timeout(3 * 60_000);
  const response = await fetcher(url, { signal: AbortSignal.any([signal, timeout]), redirect: 'follow' });
  if (!response.ok || !response.body) throw new Error('Could not download the local voice runtime from GitHub. Check your connection and retry.');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.length;
      if (length > 32 * 1024 * 1024) throw new Error('Local voice runtime archive exceeds its safety limit.');
      chunks.push(value);
    }
  } finally { await reader.cancel().catch(() => {}); }
  signal.throwIfAborted();
  return extractUv(Buffer.concat(chunks), target);
}

/** POSIX process group ownership: cancellation kills descendants and waits for close.
 * stderr is deliberately discarded, never attached to errors or application logs.
 */
export class OwnedProcess {
  readonly child: ChildProcessWithoutNullStreams;
  readonly closed: Promise<number | null>;
  private exited = false;
  constructor(executable: string, args: string[], env: NodeJS.ProcessEnv, cwd: string) {
    this.child = spawn(executable, args, { env, cwd, detached: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
    this.child.stderr.resume();
    this.child.stdin.on('error', () => {});
    this.closed = new Promise(resolve => {
      this.child.once('error', () => { /* close follows error; never forward OS stderr/paths. */ });
      this.child.once('close', code => { this.exited = true; resolve(code); });
    });
  }
  async stop(): Promise<void> {
    if (!this.exited && this.child.pid) {
      try { process.kill(-this.child.pid, 'SIGKILL'); } catch { this.child.kill('SIGKILL'); }
    }
    await this.closed;
  }
}

class WorkerExitError extends Error {}

export interface WhisperRuntimeDependencies {
  paths?: ReturnType<typeof runtimePaths>;
  prepare?: (signal: AbortSignal, progress: (text: string) => void) => Promise<string>;
  createProcess?: (executable: string, args: string[], env: NodeJS.ProcessEnv, cwd: string) => OwnedProcess;
  workerTimeoutMs?: number;
}

export class ManagedWhisperRuntime implements WhisperRuntime {
  private readonly dependencies: WhisperRuntimeDependencies;
  constructor(dependencies: WhisperRuntimeDependencies = {}) { this.dependencies = dependencies; }
  private process: OwnedProcess | undefined;
  private workerConfig: string | undefined;
  private buffered = '';
  private receive: ((line: string) => void) | undefined;
  private paths: ReturnType<typeof runtimePaths> | undefined;
  private seq = 0;

  private environment(paths: ReturnType<typeof runtimePaths>): NodeJS.ProcessEnv {
    // Do not pass Telegram tokens, Python hooks, user pip config, HF auth, or UV
    // mirror overrides to the runtime. Only platform/GPU loader settings survive.
    const env: NodeJS.ProcessEnv = {};
    for (const key of ['PATH', 'LD_LIBRARY_PATH', 'DYLD_LIBRARY_PATH', 'CUDA_VISIBLE_DEVICES']) {
      if (process.env[key]) env[key] = process.env[key];
    }
    return { ...env, HOME: join(paths.data, 'home'), LANG: 'C.UTF-8',
      UV_NO_CONFIG: '1', UV_NO_PROGRESS: '1', UV_PYTHON_PREFERENCE: 'only-managed',
      UV_PYTHON_INSTALL_DIR: join(paths.data, 'python'), UV_CACHE_DIR: join(paths.cache, 'uv'),
      UV_PYTHON_BIN_DIR: join(paths.data, 'bin'), UV_PYTHON_INSTALL_REGISTRY: '0',
      UV_HTTP_TIMEOUT: '60', UV_HTTP_RETRIES: '2',
      HF_HOME: join(paths.cache, 'huggingface'), HF_HUB_DISABLE_TELEMETRY: '1', DO_NOT_TRACK: '1',
      HF_HUB_DISABLE_IMPLICIT_TOKEN: '1', HF_HUB_DISABLE_XET: '1', HF_HUB_DISABLE_PROGRESS_BARS: '1',
      HF_HUB_ETAG_TIMEOUT: '30', HF_HUB_DOWNLOAD_TIMEOUT: '60', TOKENIZERS_PARALLELISM: 'false',
    };
  }

  private async command(executable: string, args: string[], env: NodeJS.ProcessEnv, cwd: string, signal: AbortSignal, error: string): Promise<void> {
    signal.throwIfAborted();
    const child = new OwnedProcess(executable, args, env, cwd);
    this.process = child;
    child.child.stdout.resume();
    const timeout = AbortSignal.timeout(12 * 60_000);
    try {
      const code = await abortable(child.closed, AbortSignal.any([signal, timeout]));
      if (code !== 0) throw new Error(error);
    } catch {
      if (signal.aborted) throw voiceAbortError();
      throw new Error(error);
    } finally { await child.stop(); if (this.process === child) this.process = undefined; }
  }

  private async prepare(signal: AbortSignal, progress: (text: string) => void): Promise<string> {
    const target = supportedTarget();
    const paths = this.paths ??= runtimePaths();
    const envDir = join(paths.data, `${ENV_VERSION}-${target}`);
    const python = join(envDir, 'bin', 'python');
    const ready = join(envDir, '.ready');
    if (await exists(ready) && await exists(python)) return python;
    progress('First voice: preparing isolated local Python and Whisper (binary downloads only)…');
    await mkdir(paths.data, { recursive: true, mode: 0o700 });
    await mkdir(paths.cache, { recursive: true, mode: 0o700 });
    await mkdir(join(paths.data, 'home'), { recursive: true, mode: 0o700 });
    const lock = join(paths.data, '.install-lock');
    const deadline = Date.now() + 120_000;
    for (;;) {
      signal.throwIfAborted();
      try { await mkdir(lock, { mode: 0o700 }); break; }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw new Error('Cannot write the local voice data directory. Check user directory permissions.');
        if (Date.now() > deadline) throw new Error(`Local voice installation is locked. If no other host is installing, remove ${lock} and retry.`);
        await new Promise<void>((resolve, reject) => {
          const cancel = () => { clearTimeout(timer); reject(voiceAbortError()); };
          const timer = setTimeout(() => { signal.removeEventListener('abort', cancel); resolve(); }, 250);
          signal.addEventListener('abort', cancel, { once: true });
        });
      }
    }
    try {
      if (await exists(ready) && await exists(python)) return python;
      const uv = join(paths.data, `uv-${UV_VERSION}-${target}`);
      if (!await exists(uv)) {
        const binary = await downloadUv(target, signal);
        signal.throwIfAborted();
        const staging = `${uv}.${randomUUID()}.tmp`;
        try { await writeFile(staging, binary, { mode: 0o700 }); await chmod(staging, 0o700); await rename(staging, uv); }
        finally { await rm(staging, { force: true }); }
      }
      const env = this.environment(paths);
      progress('Downloading managed Python (first installation only)…');
      await this.command(uv, ['python', 'install', PYTHON_VERSION], env, paths.data, signal,
        'Could not install managed Python. Check GitHub connectivity, disk space and host platform support, then retry.');
      await rm(envDir, { recursive: true, force: true });
      await this.command(uv, ['venv', '--python', PYTHON_VERSION, '--python-preference', 'only-managed', envDir], env, paths.data, signal,
        'Could not create the isolated voice environment. Check disk space and user directory permissions.');
      progress('Installing pinned local Whisper dependencies (binary wheels only)…');
      await this.command(uv, ['pip', 'install', '--python', python, '--index-url', 'https://pypi.org/simple', '--only-binary', ':all:', '--no-deps', ...PYTHON_PACKAGES], env, paths.data, signal,
        'Could not install pinned Whisper wheels. Check pypi.org connectivity, disk space and supported host versions, then retry.');
      await this.command(uv, ['pip', 'check', '--python', python], env, paths.data, signal,
        'The pinned voice environment is inconsistent. Remove its versioned data directory and retry.');
      signal.throwIfAborted();
      await writeFile(ready, ENV_VERSION, { mode: 0o600 });
      return python;
    } finally { await rm(lock, { recursive: true, force: true }); }
  }

  private async worker(config: VoiceConfig, signal: AbortSignal, progress: (text: string) => void): Promise<OwnedProcess> {
    const key = `${config.model}:${config.device}`;
    if (this.process && this.workerConfig === key) return this.process;
    await this.stop();
    this.paths ??= this.dependencies.paths ?? runtimePaths();
    const python = await (this.dependencies.prepare?.(signal, progress) ?? this.prepare(signal, progress));
    const paths = this.paths;
    const script = fileURLToPath(new URL('../python/worker.py', import.meta.url));
    if (!await exists(script)) throw new Error('The plugin package is missing python/worker.py. Reinstall a complete plugin package.');
    signal.throwIfAborted();
    const createProcess = this.dependencies.createProcess ?? ((...args: ConstructorParameters<typeof OwnedProcess>) => new OwnedProcess(...args));
    const worker = createProcess(python, ['-I', '-u', script, config.model, config.device, join(paths.cache, 'models')], this.environment(paths), paths.data);
    this.process = worker;
    this.workerConfig = key;
    this.buffered = '';
    worker.child.stdout.setEncoding('utf8');
    worker.child.stdout.on('data', (chunk: string) => {
      this.buffered += chunk;
      if (this.buffered.length > 128 * 1024) { void worker.stop(); return; }
      let index: number;
      while ((index = this.buffered.indexOf('\n')) >= 0) {
        const line = this.buffered.slice(0, index);
        this.buffered = this.buffered.slice(index + 1);
        this.receive?.(line);
      }
    });
    return worker;
  }

  async transcribe(audio: Uint8Array, config: VoiceConfig, signal: AbortSignal, notify: (text: string) => void): Promise<string> {
    let stage = 'Preparing local Whisper…';
    let stageStarted = Date.now();
    const progress = (text: string) => {
      stage = text;
      stageStarted = Date.now();
      if (!signal.aborted) { try { notify(text); } catch { /* observer only */ } }
    };
    const heartbeat = setInterval(() => {
      if (!signal.aborted) { try { notify(`${stage} (${Math.floor((Date.now() - stageStarted) / 1000)}s elapsed)`); } catch { /* observer only */ } }
    }, 30_000);
    let temporary: string | undefined;
    try {
      const worker = await this.worker(config, signal, progress);
      const tempRoot = join(this.paths!.cache, 'audio');
      await mkdir(tempRoot, { recursive: true, mode: 0o700 });
      temporary = await mkdtemp(join(tempRoot, 'voice-'));
      await chmod(temporary, 0o700);
      const audioPath = join(temporary, 'audio');
      const handle = await open(audioPath, 'wx', 0o600);
      try { await handle.writeFile(audio); } finally { await handle.close(); }
      signal.throwIfAborted();
      const id = ++this.seq;
      const result = new Promise<string>((resolve, reject) => {
        this.receive = line => {
          let message: { id?: number; type?: string; text?: string; code?: string };
          try {
            const parsed: unknown = JSON.parse(line);
            if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
            message = parsed as typeof message;
          } catch { reject(new Error('Invalid local voice worker response.')); return; }
          if (message.id !== id) return;
          if (message.type === 'progress') {
            const statuses: Record<string, string> = {
              model: 'Preparing cached Whisper model; the first voice may download model files…',
              loading: 'Loading the cached Whisper model into local memory…',
              transcribing: 'Transcribing locally…', cpu: 'CUDA unavailable; using local CPU transcription…',
            };
            if (message.code && statuses[message.code]) progress(statuses[message.code]!);
          } else if (message.type === 'result' && typeof message.text === 'string') resolve(message.text.trim());
          else if (message.type === 'error') {
            const errors: Record<string, string> = {
              duration: 'Decoded voice audio exceeds the 300-second limit.',
              audio: 'Voice audio could not be decoded. Send a valid audio recording.',
              model: 'Could not load the local Whisper model. Check Hugging Face connectivity and available disk space, or choose a smaller model.',
              cuda: 'CUDA voice transcription requires a compatible NVIDIA GPU, CUDA 12 and cuDNN 9. Choose CPU or auto if unavailable.',
              inference: 'Local voice transcription failed. Try CPU, a smaller model, or a shorter recording.',
            };
            reject(new Error(errors[message.code ?? ''] ?? 'Local voice transcription failed.'));
          } else reject(new Error('Invalid local voice worker response.'));
        };
      });
      const timeout = AbortSignal.timeout(this.dependencies.workerTimeoutMs ?? 20 * 60_000);
      worker.child.stdin.write(`${JSON.stringify({ id, path: audioPath })}\n`);
      const unexpectedExit = worker.closed.then(() => { throw new WorkerExitError('Local voice worker exited. Try CPU or a smaller model; check available memory.'); });
      try { return await abortable(Promise.race([result, unexpectedExit]), AbortSignal.any([signal, timeout])); }
      finally { this.receive = undefined; }
    } catch (error) {
      await this.stop();
      if (signal.aborted) throw voiceAbortError();
      if (config.device === 'auto' && error instanceof WorkerExitError) {
        // Some missing CUDA/cuDNN libraries terminate native code instead of
        // raising Python exceptions. Retry exactly once with CPU in a new process.
        clearInterval(heartbeat);
        progress('GPU worker unavailable; retrying locally on CPU…');
        return await this.transcribe(audio, { ...config, device: 'cpu' }, signal, notify);
      }
      // Only our allowlisted worker messages escape; setup/network/fs exceptions
      // are replaced, never exposing subprocess stderr, audio, URLs or transcript.
      if (error instanceof Error && /^(Local voice|Could not|Cannot write|The plugin package|The pinned voice|Voice audio|Decoded voice|CUDA voice|Invalid local)/.test(error.message)) throw error;
      throw new Error('Local voice runtime failed. Check connectivity, disk space and user cache permissions, then retry.');
    } finally {
      clearInterval(heartbeat);
      if (temporary) await rm(temporary, { recursive: true, force: true });
    }
  }

  async stop(): Promise<void> {
    const child = this.process;
    this.process = undefined;
    this.workerConfig = undefined;
    this.receive = undefined;
    this.buffered = '';
    if (child) await child.stop();
  }
}
