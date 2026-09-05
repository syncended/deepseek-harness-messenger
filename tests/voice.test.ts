import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { DEFAULT_VOICE_CONFIG, LocalWhisperTranscriber, abortable, type VoiceConfig, type WhisperRuntime } from '../src/voice.js';
import { ManagedWhisperRuntime, OwnedProcess, extractUv, runtimePaths, supportedTarget } from '../src/whisper-runtime.js';

const services: LocalWhisperTranscriber[] = [];
const runtimes: ManagedWhisperRuntime[] = [];
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(services.splice(0).map(service => service.dispose()));
  await Promise.all(runtimes.splice(0).map(runtime => runtime.stop()));
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const audio = (): Promise<Uint8Array> => Promise.resolve(new Uint8Array([1, 2, 3]));
function request(loadAudio = audio, signal = new AbortController().signal, onProgress = vi.fn()) {
  return { loadAudio, signal, onProgress };
}
function service(runtime: WhisperRuntime, options: { config?: VoiceConfig; requestTimeoutMs?: number; audioTimeoutMs?: number } = {}) {
  const factory = vi.fn(() => runtime);
  const instance = new LocalWhisperTranscriber(options.config ?? DEFAULT_VOICE_CONFIG, {
    createRuntime: factory,
    ...(options.requestTimeoutMs !== undefined ? { requestTimeoutMs: options.requestTimeoutMs } : {}),
    ...(options.audioTimeoutMs !== undefined ? { audioTimeoutMs: options.audioTimeoutMs } : {}),
  });
  services.push(instance);
  return { instance, factory };
}
function mockRuntime() {
  return { transcribe: vi.fn<WhisperRuntime['transcribe']>(async () => 'hello'), stop: vi.fn(async () => {}) };
}

describe('lazy global voice service', () => {
  it('exports defaults and does nothing until a voice request', async () => {
    const runtime = mockRuntime();
    const { instance, factory } = service(runtime);
    expect(DEFAULT_VOICE_CONFIG).toEqual({ enabled: true, model: 'small', device: 'auto' });
    expect(factory).not.toHaveBeenCalled();
    await instance.dispose();
    expect(factory).not.toHaveBeenCalled();
    expect(runtime.stop).not.toHaveBeenCalled();
  });

  it('never loads disabled or already-aborted requests', async () => {
    const loader = vi.fn(audio);
    const { instance, factory } = service(mockRuntime(), { config: { ...DEFAULT_VOICE_CONFIG, enabled: false } });
    await expect(instance.transcribe(request(loader))).rejects.toThrow('disabled');
    const enabled = service(mockRuntime());
    await expect(enabled.instance.transcribe(request(loader, AbortSignal.abort()))).rejects.toMatchObject({ name: 'AbortError' });
    expect(loader).not.toHaveBeenCalled();
    expect(factory).not.toHaveBeenCalled();
  });

  it('caps the global FIFO at eight including active, loads only at head and reuses queued worker', async () => {
    const first = deferred<Uint8Array>();
    const runtime = mockRuntime();
    const { instance, factory } = service(runtime);
    const loaders = Array.from({ length: 8 }, (_, index) => vi.fn(() => index === 0 ? first.promise : audio()));
    const results = loaders.map(loader => instance.transcribe(request(loader)));
    await Promise.resolve();
    expect(loaders[0]).toHaveBeenCalledOnce();
    expect(loaders.slice(1).every(loader => loader.mock.calls.length === 0)).toBe(true);
    const second = service(mockRuntime());
    await expect(second.instance.transcribe(request())).rejects.toThrow('queue is full');
    first.resolve(new Uint8Array([1]));
    await expect(Promise.all(results)).resolves.toHaveLength(8);
    expect(factory).toHaveBeenCalledOnce();
    expect(runtime.stop).toHaveBeenCalledOnce();
    const orders = loaders.map(loader => loader.mock.invocationCallOrder[0]!);
    expect(orders).toEqual([...orders].sort((a, b) => a - b));
    await instance.transcribe(request());
    expect(factory).toHaveBeenCalledTimes(2);
    expect(runtime.stop).toHaveBeenCalledTimes(2);
  });

  it('removes cancelled queued items without loading them', async () => {
    const first = deferred<Uint8Array>();
    const { instance } = service(mockRuntime());
    const active = instance.transcribe(request(() => first.promise));
    const controller = new AbortController();
    const loader = vi.fn(audio);
    const queued = instance.transcribe(request(loader, controller.signal));
    const rejected = expect(queued).rejects.toMatchObject({ name: 'AbortError' });
    controller.abort('do not expose this reason');
    await rejected;
    first.resolve(new Uint8Array([1]));
    await active;
    expect(loader).not.toHaveBeenCalled();
  });

  it('cancels active runtime, waits for cleanup and then continues FIFO', async () => {
    const started = deferred<void>();
    const runtime = mockRuntime();
    runtime.transcribe.mockImplementationOnce(async (_audio, _config, signal) => {
      started.resolve();
      return abortable(new Promise<string>(() => {}), signal);
    });
    const { instance } = service(runtime);
    const controller = new AbortController();
    const first = instance.transcribe(request(audio, controller.signal));
    const rejected = expect(first).rejects.toMatchObject({ name: 'AbortError' });
    const second = instance.transcribe(request());
    await started.promise;
    controller.abort();
    await rejected;
    await expect(second).resolves.toBe('hello');
    expect(runtime.stop).toHaveBeenCalledTimes(2);
  });

  it('times out uncooperative loaders and never creates runtime', async () => {
    const { instance, factory } = service(mockRuntime(), { audioTimeoutMs: 15 });
    await expect(instance.transcribe(request(() => new Promise(() => {})))).rejects.toThrow('timed out');
    expect(factory).not.toHaveBeenCalled();
  });

  it('sanitizes loader errors, caps bytes and tolerates throwing progress observers', async () => {
    const { instance } = service(mockRuntime());
    await expect(instance.transcribe(request(async () => { throw new Error('token/audio private'); }))).rejects.toThrow('Could not load voice audio');
    await expect(instance.transcribe(request(async () => new Uint8Array(20 * 1024 * 1024 + 1)))).rejects.toThrow('20 MB');
    await expect(instance.transcribe(request(audio, new AbortController().signal, vi.fn(() => { throw new Error('observer'); })))).resolves.toBe('hello');
  });

  it('recovers the global FIFO when runtime cleanup rejects', async () => {
    const broken = mockRuntime();
    broken.stop.mockRejectedValueOnce(new Error('private cleanup details'));
    const first = service(broken);
    const second = service(mockRuntime());
    const rejected = expect(first.instance.transcribe(request())).rejects.toThrow('cleanup failed');
    const other = second.instance.transcribe(request());
    await rejected;
    await expect(other).resolves.toBe('hello');
  });

  it('disposes only owned requests and releases other instances', async () => {
    const loaded = deferred<void>();
    const first = service(mockRuntime());
    const second = service(mockRuntime());
    const active = first.instance.transcribe(request(() => { loaded.resolve(); return new Promise(() => {}); }));
    const queuedLoader = vi.fn(audio);
    const queued = first.instance.transcribe(request(queuedLoader));
    const other = second.instance.transcribe(request());
    const rejected = Promise.all([expect(active).rejects.toMatchObject({ name: 'AbortError' }), expect(queued).rejects.toMatchObject({ name: 'AbortError' })]);
    await loaded.promise;
    await first.instance.dispose();
    await rejected;
    await expect(other).resolves.toBe('hello');
    expect(queuedLoader).not.toHaveBeenCalled();
    await expect(first.instance.transcribe(request())).rejects.toThrow('disposed');
  });
});

describe('bootstrap safety', () => {
  it('detects supported hosts without starting a subprocess', () => {
    expect(supportedTarget({ platform: 'linux', arch: 'x64', glibc: '2.28' })).toBe('x86_64-unknown-linux-gnu');
    expect(supportedTarget({ platform: 'darwin', arch: 'arm64', osRelease: '23.0.0' })).toBe('aarch64-apple-darwin');
    for (const host of [
      { platform: 'linux', arch: 'x64' }, { platform: 'linux', arch: 'arm64', glibc: '2.27' },
      { platform: 'win32', arch: 'x64' }, { platform: 'linux', arch: 'ia32', glibc: '2.39' },
      { platform: 'darwin', arch: 'arm64', osRelease: '22.0.0' },
    ]) expect(() => supportedTarget(host)).toThrow('Local voice requires');
  });

  it('uses persistent user directories and ignores relative XDG paths', () => {
    expect(runtimePaths({ XDG_DATA_HOME: 'relative', XDG_CACHE_HOME: '/custom/cache' }, '/home/test', 'linux')).toEqual({
      data: '/home/test/.local/share/dsh-messenger/voice', cache: '/custom/cache/dsh-messenger/voice',
    });
    expect(runtimePaths({}, '/Users/test', 'darwin').data).toBe('/Users/test/Library/Application Support/dsh-messenger/voice');
  });

  it('verifies archive hash before extraction and ignores untrusted paths', () => {
    const header = Buffer.alloc(512);
    header.write('uv-test/uv');
    header.write('00000000003\0', 124);
    header[156] = 48;
    const archive = gzipSync(Buffer.concat([header, Buffer.from('bin'), Buffer.alloc(509 + 1024)]));
    const hash = createHash('sha256').update(archive).digest('hex');
    expect(extractUv(archive, 'test', hash).toString()).toBe('bin');
    expect(() => extractUv(archive, 'test', '0'.repeat(64))).toThrow('checksum');
    expect(() => extractUv(archive, '../test', hash)).toThrow('archive is invalid');
  });
});

async function fakeWorker(code: string, options: { workerTimeoutMs?: number; factory?: (args: string[], paths: { data: string; cache: string }) => OwnedProcess } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-voice-test-'));
  directories.push(root);
  const paths = { data: join(root, 'data'), cache: join(root, 'cache') };
  await mkdir(paths.data);
  const children: OwnedProcess[] = [];
  const runtime = new ManagedWhisperRuntime({ paths, prepare: async () => process.execPath,
    createProcess: (_executable, args) => {
      const child = options.factory?.(args, paths) ?? new OwnedProcess(process.execPath, ['--input-type=module', '-e', code], {}, paths.data);
      children.push(child);
      return child;
    }, ...(options.workerTimeoutMs !== undefined ? { workerTimeoutMs: options.workerTimeoutMs } : {}) });
  runtimes.push(runtime);
  return { runtime, paths, children };
}
const lineWorker = (body: string) => `import readline from 'node:readline'; import fs from 'node:fs'; const lines = readline.createInterface({input:process.stdin}); lines.on('line', line => { const request = JSON.parse(line); ${body} });`;

describe('owned local worker protocol', () => {
  it('writes private audio, returns text and removes files, then fully exits at idle', async () => {
    const fixture = await fakeWorker(lineWorker(`if ((fs.statSync(request.path).mode & 0o777) !== 0o600) process.exit(2); console.log(JSON.stringify({id:request.id,type:'result',text:'  hello  '}));`));
    const { instance } = service(fixture.runtime);
    await expect(instance.transcribe(request())).resolves.toBe('hello');
    expect(await readdir(join(fixture.paths.cache, 'audio'))).toEqual([]);
    await expect(fixture.children[0]!.closed).resolves.toBe(null); // SIGKILL, awaited before request resolves
  });

  it('sanitizes stderr and arbitrary worker errors; cleans audio on failure', async () => {
    const fixture = await fakeWorker(lineWorker(`console.error('PRIVATE_AUDIO_AND_TOKEN'); console.log(JSON.stringify({id:request.id,type:'error',code:'PRIVATE_AUDIO_AND_TOKEN'}));`));
    await expect(fixture.runtime.transcribe(new Uint8Array([1]), DEFAULT_VOICE_CONFIG, new AbortController().signal, vi.fn())).rejects.toThrow(/^Local voice transcription failed\.$/);
    expect(await readdir(join(fixture.paths.cache, 'audio'))).toEqual([]);
  });

  it('rejects non-object protocol JSON without crashing the host', async () => {
    const fixture = await fakeWorker(lineWorker(`console.log('null');`));
    await expect(fixture.runtime.transcribe(new Uint8Array([1]), DEFAULT_VOICE_CONFIG, new AbortController().signal, vi.fn())).rejects.toThrow('Invalid local voice worker response');
  });

  it('kills and reaps a busy worker on abort and removes temporary audio', async () => {
    const fixture = await fakeWorker(lineWorker(`setInterval(() => {}, 1000);`));
    const controller = new AbortController();
    const promise = fixture.runtime.transcribe(new Uint8Array([1]), DEFAULT_VOICE_CONFIG, controller.signal, vi.fn());
    const rejected = expect(promise).rejects.toMatchObject({ name: 'AbortError' });
    await vi.waitFor(() => expect(fixture.children).toHaveLength(1));
    controller.abort();
    await rejected;
    await expect(fixture.children[0]!.closed).resolves.toBe(null);
    const audioRoot = join(fixture.paths.cache, 'audio');
    expect(await readdir(audioRoot).catch(() => [])).toEqual([]);
  });

  it('times out busy subprocesses without an auto retry', async () => {
    const fixture = await fakeWorker(lineWorker(`setInterval(() => {}, 1000);`), { workerTimeoutMs: 20 });
    await expect(fixture.runtime.transcribe(new Uint8Array([1]), DEFAULT_VOICE_CONFIG, new AbortController().signal, vi.fn())).rejects.toThrow('Local voice runtime failed');
    expect(fixture.children).toHaveLength(1);
    expect(await readdir(join(fixture.paths.cache, 'audio'))).toEqual([]);
  });

  it('auto retries a native crash exactly once on CPU, never for explicit CUDA', async () => {
    const devices: string[] = [];
    const fixture = await fakeWorker('', { factory: (args, paths) => {
      devices.push(args[4]!);
      const code = args[4] === 'auto' ? lineWorker('process.exit(134);') : lineWorker(`console.log(JSON.stringify({id:request.id,type:'result',text:'cpu result'}));`);
      return new OwnedProcess(process.execPath, ['--input-type=module', '-e', code], {}, paths.data);
    } });
    await expect(fixture.runtime.transcribe(new Uint8Array([1]), DEFAULT_VOICE_CONFIG, new AbortController().signal, vi.fn())).resolves.toBe('cpu result');
    expect(devices).toEqual(['auto', 'cpu']);
    const explicit = await fakeWorker(lineWorker('process.exit(134);'));
    await expect(explicit.runtime.transcribe(new Uint8Array([1]), { ...DEFAULT_VOICE_CONFIG, device: 'cuda' }, new AbortController().signal, vi.fn())).rejects.toThrow('worker exited');
    expect(explicit.children).toHaveLength(1);
  });

  it('enforces decoded duration errors from the worker without returning text', async () => {
    const fixture = await fakeWorker(lineWorker(`console.log(JSON.stringify({id:request.id,type:'error',code:'duration'}));`));
    await expect(fixture.runtime.transcribe(new Uint8Array([1]), DEFAULT_VOICE_CONFIG, new AbortController().signal, vi.fn())).rejects.toThrow('300-second');
  });
});

// Optional stdlib-only Python test seam. Does not install anything or require
// Python for normal npm tests. Invoke with DSH_VOICE_TEST_PYTHON=python3.
it.skipIf(!process.env.DSH_VOICE_TEST_PYTHON)('Python worker mocked artifacts, decoded limit, VAD and cleanup', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-voice-python-test-'));
  directories.push(root);
  const code = `import importlib.util, pathlib, sys, types
sys.dont_write_bytecode=True
spec=importlib.util.spec_from_file_location('worker', sys.argv[1])
w=importlib.util.module_from_spec(spec)
spec.loader.exec_module(w)
w.send=lambda *args, **kwargs: None
root=pathlib.Path(sys.argv[2])
fw=types.ModuleType('faster_whisper')
utils=types.ModuleType('faster_whisper.utils')
sys.modules['faster_whisper']=fw
sys.modules['faster_whisper.utils']=utils
artifacts=['config.json','model.bin','tokenizer.json']
def download(repo, **kwargs):
 assert kwargs['use_auth_token'] is False
 assert len(kwargs['revision']) == 40
 directory=pathlib.Path(kwargs['output_dir'])
 directory.mkdir(parents=True, exist_ok=True)
 for name in artifacts: (directory/name).write_text('fixture')
utils.download_model=download
for missing in ('vocabulary.json','preprocessor_config.json'):
 try: w.model_directory('large-v3', root, 1)
 except w.VoiceError as error: assert str(error)=='model'
 else: raise AssertionError('partial model accepted')
 assert not list(root.glob('*/.complete'))
 artifacts.append(missing)
large=pathlib.Path(w.model_directory('large-v3',root,1))
assert (large/'.complete').is_file()
assert not list(large.glob('.complete-*'))
artifacts=['config.json','model.bin','tokenizer.json','vocabulary.txt']
tiny=pathlib.Path(w.model_directory('tiny',root,1))
assert (tiny/'.complete').is_file()
assert not (tiny/'preprocessor_config.json').exists()
def failed_model(*args, **kwargs): raise RuntimeError('private failure')
fw.WhisperModel=failed_model
sys.modules['ctranslate2']=types.SimpleNamespace(get_supported_compute_types=lambda device: {'int8','float16'})
try: w.create_model(tiny,'cpu')
except RuntimeError: pass
assert not (tiny/'.complete').exists()
(tiny/'.complete').write_text('fixture')
try: w.create_model(tiny,'cuda')
except RuntimeError: pass
assert (tiny/'.complete').exists()
source=root/'audio'
source.write_bytes(b'fixture')
class Frame:
 samples=300*16000+1
 pts=None
class Container:
 streams=types.SimpleNamespace(audio=[1])
 def __enter__(self): return self
 def __exit__(self,*args): pass
 def decode(self,**kwargs): return [Frame()]
class Resampler:
 def __init__(self,**kwargs): pass
 def resample(self,frame): return [frame] if frame is not None else []
sys.modules['av']=types.SimpleNamespace(open=lambda *args,**kwargs: Container(),audio=types.SimpleNamespace(resampler=types.SimpleNamespace(AudioResampler=Resampler)))
sys.modules['numpy']=types.SimpleNamespace()
try: w.decode_bounded(source)
except w.VoiceError as error: assert str(error)=='duration'
else: raise AssertionError('decoded duration accepted')
assert source.exists()
w.CURRENT_INPUT=str(source)
w.remove_current_input()
assert not source.exists()
class Model:
 def transcribe(self,audio,**kwargs):
  assert kwargs['vad_filter'] is True
  return [types.SimpleNamespace(text='fixture')], None
assert w.infer(Model(),None)=='fixture'
`;
  const child = new OwnedProcess(process.env.DSH_VOICE_TEST_PYTHON!, ['-I', '-c', code,
    fileURLToPath(new URL('../python/worker.py', import.meta.url)), root], process.env, root);
  child.child.stdout.resume();
  try { expect(await abortable(child.closed, AbortSignal.timeout(20_000))).toBe(0); }
  finally { await child.stop(); }
});

// Explicit opt-in only. Downloads uv, managed Python, pinned wheels, tiny model
// and a public speech fixture into a disposable /tmp tree; never uses user cache.
it.skipIf(process.env.DSH_VOICE_REAL_SMOKE !== '1')('REAL isolated CPU tiny model + OGG smoke', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-voice-real-'));
  directories.push(root);
  const paths = { data: join(root, 'data'), cache: join(root, 'cache') };
  const runtime = new ManagedWhisperRuntime({ paths });
  runtimes.push(runtime);
  const response = await fetch('https://raw.githubusercontent.com/SYSTRAN/faster-whisper/v1.2.1/tests/data/jfk.flac');
  if (!response.ok) throw new Error('Could not retrieve the public smoke fixture.');
  const flac = new Uint8Array(await response.arrayBuffer());
  const text = await runtime.transcribe(flac, { enabled: true, model: 'tiny', device: 'cpu' }, new AbortController().signal, () => {});
  expect(text.toLowerCase().includes('country')).toBe(true);
  await runtime.stop();
  const env = (await readdir(paths.data)).find(name => name.startsWith('v1-py'))!;
  const input = join(root, 'input.flac');
  const output = join(root, 'input.ogg');
  await writeFile(input, flac, { mode: 0o600 });
  const encode = new OwnedProcess(join(paths.data, env, 'bin', 'python'), ['-I', '-c',
    'import av,sys\nwith av.open(sys.argv[1]) as source, av.open(sys.argv[2], "w", format="ogg") as dest:\n stream=dest.add_stream("libopus",rate=48000)\n for frame in source.decode(audio=0):\n  for packet in stream.encode(frame): dest.mux(packet)\n for packet in stream.encode(None): dest.mux(packet)', input, output], {}, root);
  encode.child.stdout.resume();
  try { expect(await abortable(encode.closed, AbortSignal.timeout(30_000))).toBe(0); }
  finally { await encode.stop(); }
  expect((await stat(output)).size > 0).toBe(true);
  const oggText = await runtime.transcribe(await readFile(output), { enabled: true, model: 'tiny', device: 'cpu' }, new AbortController().signal, () => {});
  expect(oggText.toLowerCase().includes('country')).toBe(true);
  expect(await readdir(join(paths.cache, 'audio'))).toEqual([]);
}, 25 * 60_000);
