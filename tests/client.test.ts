import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';

const CLIENT_SOURCE = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');

interface ClientDefinition {
  id: string;
  factory: (require: (id: string) => unknown) => {
    apply(ctx: any): void;
    inject: string[];
    __testing: {
      createSettingsApi(remote: any): any;
      splitIds(value: string): string[];
      telegramValue(section: unknown): Record<string, unknown>;
      voiceValue(section: unknown): Record<string, unknown>;
      sameVoice(left: unknown, right: Record<string, unknown>): boolean;
      validateVoice(form: Record<string, unknown>): Record<string, unknown>;
      VoiceSettings(props: { scope: any }): any;
      messengerNamespace(describe: unknown): unknown;
      isLocalhostProxy(hostname: unknown): boolean;
      createDirectSettingsScope(api: any): {
        getSnapshot(): Record<string, any>;
        subscribe(listener: () => void): () => void;
        reload(): Promise<void>;
        set(field: string, value: unknown): Promise<void>;
        dispose(): Promise<void>;
      };
      sameTelegram(
        left: Record<string, any>,
        right: Record<string, any>,
      ): boolean;
      validateForm(
        form: Record<string, unknown>,
        credential: { configured?: boolean } | undefined,
        tokenDraft: string,
      ): Record<string, unknown>;
    };
  };
}

function loadClient(react?: Record<string, unknown>) {
  let definition: ClientDefinition | undefined;
  const execute = new Function('window', CLIENT_SOURCE);
  execute({
    __ModuleLoader__: {
      load(value: ClientDefinition) {
        definition = value;
      },
    },
  });
  if (definition === undefined) throw new Error('client bundle did not register');
  const reactStub = {
    createElement() {},
    useCallback() {},
    useEffect() {},
    useMemo() {},
    useState() {},
    useSyncExternalStore() {},
  };
  return definition.factory((id) => {
    if (id === 'react') return react ?? reactStub;
    throw new Error(`unexpected client import: ${id}`);
  });
}

function loadClientTesting() {
  return loadClient().__testing;
}

// Small hook/element harness: exercise the shipped component without adding a
// DOM or renderer dependency to this plugin's existing pure-client test suite.
function componentHarness() {
  const slots: any[] = [];
  let cursor = 0;
  let changed = false;
  let effects: Array<() => void> = [];
  const equalDeps = (left: any[], right: any[]) => left?.length === right.length
    && left.every((value, index) => Object.is(value, right[index]));
  const react = {
    createElement(type: any, props: any, ...children: any[]) {
      return { type, props: { ...props, children } };
    },
    useState(initial: any) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial;
      return [slots[index], (update: any) => {
        const next = typeof update === 'function' ? update(slots[index]) : update;
        if (!Object.is(next, slots[index])) changed = true;
        slots[index] = next;
      }];
    },
    useRef(initial: any) {
      const index = cursor++;
      return slots[index] ??= { current: initial };
    },
    useMemo(factory: () => any, deps: any[]) {
      const index = cursor++;
      if (!slots[index] || !equalDeps(slots[index].deps, deps)) {
        slots[index] = { deps, value: factory() };
      }
      return slots[index].value;
    },
    useCallback(callback: any, deps: any[]) { return react.useMemo(() => callback, deps); },
    useEffect(effect: () => any, deps: any[]) {
      const index = cursor++;
      if (!slots[index] || !equalDeps(slots[index].deps, deps)) {
        effects.push(() => {
          slots[index]?.cleanup?.();
          slots[index] = { deps, cleanup: effect() };
        });
      }
    },
    useSyncExternalStore(subscribe: any, getSnapshot: any) {
      react.useEffect(() => subscribe(() => { changed = true; }), [subscribe]);
      return getSnapshot();
    },
  };
  return {
    react,
    render(component: any, props: any) {
      let tree: any;
      let renders = 0;
      do {
        if (++renders > 30) throw new Error('component did not settle');
        cursor = 0;
        changed = false;
        effects = [];
        tree = component(props);
        for (const effect of effects) effect();
      } while (changed);
      return tree;
    },
  };
}

function elements(tree: any): any[] {
  if (!tree || typeof tree !== 'object') return [];
  // Field and Toggle are stateless leaf wrappers; leave the stateful voice
  // child unexpanded when inspecting the parent Telegram component.
  if (typeof tree.type === 'function' && tree.type.name !== 'VoiceSettings') {
    return elements(tree.type(tree.props));
  }
  return [tree, ...(tree.props.children ?? []).flat(Infinity).flatMap(elements)];
}

function text(tree: any): string {
  if (tree === null || tree === undefined || typeof tree === 'boolean') return '';
  if (typeof tree !== 'object') return String(tree);
  if (Array.isArray(tree)) return tree.map(text).join('');
  return text(tree.props.children);
}

function voiceFixture(value: Record<string, unknown> = {}, writable = true) {
  const harness = componentHarness();
  const client = loadClient(harness.react);
  let snapshot = { status: 'ready', value, writable };
  const listeners = new Set<() => void>();
  const publish = (next: Partial<typeof snapshot>) => {
    snapshot = { ...snapshot, ...next };
    for (const listener of listeners) listener();
  };
  const scope = {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) { listeners.add(listener); return () => listeners.delete(listener); },
    set: vi.fn(async (field: string, next: unknown) => {
      publish({ value: { ...snapshot.value, [field]: next } });
    }),
  };
  const render = () => harness.render(client.__testing.VoiceSettings, { scope });
  const controls = (type: string) => elements(render()).filter((node) => node.type === type);
  const button = (label: string) => controls('button').find((node) => text(node) === label);
  return { client, scope, publish, render, controls, button };
}

describe('Local Whisper Web settings', () => {
  const testing = loadClientTesting();

  it('defaults missing legacy configuration and validates only supported values', () => {
    const defaults = { enabled: true, model: 'small', device: 'auto' };
    expect(testing.voiceValue(undefined)).toEqual(defaults);
    expect(testing.voiceValue({ telegram: {} })).toEqual(defaults);
    expect(testing.voiceValue({ voice: { enabled: false } })).toEqual({ ...defaults, enabled: false });
    for (const model of ['tiny', 'base', 'small', 'medium', 'large-v3', 'turbo']) {
      for (const device of ['auto', 'cpu', 'cuda']) {
        const next = { enabled: false, model, device };
        expect(testing.validateVoice(next)).toEqual(next);
        expect(testing.voiceValue({ voice: next })).toEqual(next);
      }
    }
    expect(() => testing.validateVoice({ ...defaults, model: 'large' })).toThrow('model');
    expect(() => testing.validateVoice({ ...defaults, device: 'metal' })).toThrow('device');
    expect(() => testing.validateVoice({ ...defaults, enabled: 'true' })).toThrow('enabled');
    expect(testing.sameVoice(undefined, defaults)).toBe(false);
  });

  it('renders lazy local-only preparation instructions and the supported options', () => {
    const fixture = voiceFixture();
    expect(fixture.controls('select').map((node) => node.props.value)).toEqual(['small', 'auto']);
    expect(fixture.controls('option').map((node) => node.props.value)).toEqual([
      'tiny', 'base', 'small', 'medium', 'large-v3', 'turbo', 'auto', 'cpu', 'cuda',
    ]);
    const copy = elements(fixture.render()).map((node) => text(node)).join(' ');
    for (const phrase of ['Local Whisper', 'isolated runtime', 'downloads the selected model',
      'needs internet', 'not sent to a speech-to-text cloud', 'kept on disk',
      'worker exits after the queue drains', 'NVIDIA CUDA', 'otherwise CPU', '5 minutes / 20 MB', '/voice_cancel']) {
      expect(copy).toContain(phrase);
    }
    expect(fixture.controls('button').map(text)).toEqual(['Save voice settings', 'Discard voice changes']);
  });

  it('persists the top-level voice section independently and reloads committed settings', async () => {
    const telegram = testing.telegramValue(undefined);
    const fixture = voiceFixture({ telegram });
    fixture.controls('select')[0].props.onChange({ target: { value: 'turbo' } });
    fixture.controls('select')[1].props.onChange({ target: { value: 'cuda' } });
    fixture.controls('input')[0].props.onChange({ target: { checked: false } });
    await fixture.button('Save voice settings').props.onClick();
    const next = { enabled: false, model: 'turbo', device: 'cuda' };
    expect(fixture.scope.set).toHaveBeenCalledExactlyOnceWith('voice', next);
    expect(fixture.scope.getSnapshot().value).toEqual({ telegram, voice: next });
    expect(fixture.scope.getSnapshot().value.telegram).toBe(telegram);
    expect(text(fixture.render())).toContain('Saved. Local voice transcription is disabled.');
    expect(fixture.button('Discard voice changes').props.disabled).toBe(true);
    const reopened = voiceFixture(fixture.scope.getSnapshot().value);
    expect(reopened.controls('select').map((node) => node.props.value)).toEqual(['turbo', 'cuda']);
    expect(reopened.controls('input')[0].props.checked).toBe(false);
  });

  it('keeps Telegram drafts, token operations and saves separate from voice state', async () => {
    const fixture = voiceFixture();
    const main = componentHarness();
    const client = loadClient(main.react);
    let component: any;
    let props: any;
    const credentials = {
      describe: vi.fn(async () => ({ ok: true, value: {} })),
      set: vi.fn(async () => ({ ok: true, value: undefined })),
    };
    client.apply({
      remote: { settings: {}, credentials },
      settingsScope: { bind: () => fixture.scope, describe: () => ({}) },
      effect: () => {},
      slots: {
        inject: (_slot: string, register: () => void) => register(),
        register: (section: any, target: any) => { props = section.inject(); component = target; },
      },
    });
    const render = () => main.render(component, props);
    const nodes = (type: string) => elements(render()).filter((node) => node.type === type);
    const button = (label: string) => nodes('button').find((node) => text(node) === label);
    expect(elements(render()).some((node) => node.type?.name === 'VoiceSettings' && node.props.scope === fixture.scope)).toBe(true);
    nodes('textarea')[0].props.onChange({ target: { value: '123456789' } });
    nodes('input').find((node) => node.props.type === 'password').props.onChange({ target: { value: 'unfinished-token' } });
    fixture.controls('select')[0].props.onChange({ target: { value: 'turbo' } });
    await fixture.button('Save voice settings').props.onClick();
    expect(nodes('textarea')[0].props.value).toBe('123456789');
    expect(nodes('input').find((node) => node.props.type === 'password').props.value).toBe('unfinished-token');
    expect(credentials.set).not.toHaveBeenCalled();
    expect(fixture.scope.set).toHaveBeenCalledExactlyOnceWith('voice', { enabled: true, model: 'turbo', device: 'auto' });
    fixture.controls('select')[0].props.onChange({ target: { value: 'medium' } });
    button('Discard').props.onClick();
    button('Save').props.onClick();
    await vi.waitFor(() => expect(text(render())).toContain('Saved. Telegram is disabled.'));
    expect(fixture.scope.set).toHaveBeenLastCalledWith('telegram', testing.telegramValue(undefined));
    expect(fixture.scope.getSnapshot().value.voice).toEqual({ enabled: true, model: 'turbo', device: 'auto' });
    expect(fixture.controls('select')[0].props.value).toBe('medium');
    expect(fixture.button('Discard voice changes').props.disabled).toBe(false);
    expect(credentials.set).not.toHaveBeenCalled();
  });

  it('syncs clean snapshots, preserves drafts and discards to the latest snapshot', () => {
    const fixture = voiceFixture();
    fixture.publish({ value: { voice: { enabled: false, model: 'base', device: 'cpu' } } });
    expect(fixture.controls('select').map((node) => node.props.value)).toEqual(['base', 'cpu']);
    fixture.controls('select')[0].props.onChange({ target: { value: 'medium' } });
    fixture.publish({ value: { voice: { enabled: true, model: 'tiny', device: 'auto' }, telegram: { enabled: true } } });
    expect(fixture.controls('select').map((node) => node.props.value)).toEqual(['medium', 'cpu']);
    fixture.button('Discard voice changes').props.onClick();
    expect(fixture.controls('select').map((node) => node.props.value)).toEqual(['tiny', 'auto']);
    expect(fixture.controls('input')[0].props.checked).toBe(true);
    expect(fixture.scope.set).not.toHaveBeenCalled();
  });

  it('disables edits while busy and prevents duplicate or read-only writes', async () => {
    const fixture = voiceFixture();
    fixture.controls('select')[0].props.onChange({ target: { value: 'tiny' } });
    let finish!: () => void;
    fixture.scope.set.mockImplementationOnce(async (field, next) => {
      await new Promise<void>((resolve) => { finish = resolve; });
      fixture.publish({ value: { [field]: next } });
    });
    const save = fixture.button('Save voice settings').props.onClick;
    const pending = save();
    await save();
    expect(fixture.scope.set).toHaveBeenCalledTimes(1);
    for (const control of [...fixture.controls('select'), ...fixture.controls('input'), ...fixture.controls('button')]) {
      expect(control.props.disabled).toBe(true);
    }
    finish();
    await pending;
    expect(fixture.button('Save voice settings').props.disabled).toBe(false);
    fixture.publish({ writable: false });
    expect(fixture.controls('select')[0].props.disabled).toBe(true);
    await fixture.button('Save voice settings').props.onClick();
    expect(fixture.scope.set).toHaveBeenCalledTimes(1);
    fixture.publish({ writable: true, status: 'unavailable' });
    expect(fixture.button('Save voice settings').props.disabled).toBe(true);
  });

  it('retains a rejected draft and surfaces write failures without false success', async () => {
    const fixture = voiceFixture();
    fixture.controls('select')[0].props.onChange({ target: { value: 'large-v3' } });
    fixture.scope.set.mockRejectedValueOnce(new Error('settings revision conflict'));
    await fixture.button('Save voice settings').props.onClick();
    expect(text(fixture.render())).toContain('settings revision conflict');
    expect(fixture.controls('select')[0].props.value).toBe('large-v3');
    expect(fixture.button('Discard voice changes').props.disabled).toBe(false);
    fixture.scope.set.mockResolvedValueOnce(undefined);
    await fixture.button('Save voice settings').props.onClick();
    expect(text(fixture.render())).toContain('The Host rejected the voice settings');
    expect(text(fixture.render())).not.toContain('Saved.');
    fixture.button('Discard voice changes').props.onClick();
    expect(text(fixture.render())).not.toContain('The Host rejected');
    // Even a save of defaults must verify an explicit committed voice section.
    fixture.scope.set.mockResolvedValueOnce(undefined);
    await fixture.button('Save voice settings').props.onClick();
    expect(text(fixture.render())).toContain('The Host rejected the voice settings');
    await fixture.button('Save voice settings').props.onClick();
    expect(text(fixture.render())).toContain('Saved. Local voice transcription is enabled.');
  });
});

describe('Messenger Web settings helpers', () => {
  const testing = loadClientTesting();

  it('uses controller remotes without the removed connection.api property', async () => {
    const client = loadClient();
    const describe = vi.fn(async () => ({ ok: true, value: { namespaces: [] } }));
    let injected: any;
    const bind = vi.fn(() => ({}));
    client.apply({
      remote: { settings: { describe }, credentials: {} },
      // No connection service or get() method: modern transport has no .api.
      settingsScope: { bind, describe: () => ({}) },
      effect: () => {},
      slots: {
        inject: (_slot: string, register: () => void) => register(),
        register: (section: any) => { injected = section.inject(); },
      },
    });
    expect(client.inject).toContain('remote.settings');
    expect(client.inject).toContain('remote.credentials');
    expect(client.inject).not.toContain('connection');
    expect(bind).toHaveBeenCalledWith({ namespace: 'messenger' });
    await expect(injected.api.settings.describe({})).resolves.toEqual({
      result: { ok: true, value: { namespaces: [] } },
    });
    expect(describe).toHaveBeenCalledWith();
  });

  it('adapts positional remote calls and Telegram credential metadata', async () => {
    const metadata = { TELEGRAM_BOT_TOKEN: { configured: true, writable: true } };
    const remote = {
      settings: {
        describe: vi.fn(async () => ({ ok: true, value: { namespaces: [] } })),
        mutate: vi.fn(async () => ({ ok: true, value: { revision: 7 } })),
      },
      credentials: {
        describe: vi.fn(async () => ({ ok: true, value: metadata })),
        set: vi.fn(async () => ({ ok: true, value: undefined })),
        unset: vi.fn(async () => ({ ok: true, value: undefined })),
      },
    };
    const api = testing.createSettingsApi(remote);
    const ops = [{ op: 'set', path: ['telegram'], value: { enabled: false } }];
    await expect(api.settings.mutate({ ns: 'messenger', ops, expectedRevision: 6 })).resolves.toEqual({
      result: { ok: true, value: { revision: 7 } },
    });
    expect(remote.settings.mutate).toHaveBeenCalledWith('messenger', ops, 6);
    const refs = Object.keys(metadata);
    expect(await api.credentials.describe({ refs })).toEqual({
      result: { ok: true, value: { credentials: metadata } },
    });
    expect(remote.credentials.describe).toHaveBeenCalledWith(refs);
    await expect(api.credentials.set({ ref: refs[0], value: 'test-value' })).resolves.toEqual({
      result: { ok: true, value: undefined },
    });
    expect(remote.credentials.set).toHaveBeenCalledWith(refs[0], 'test-value');
    await expect(api.credentials.unset({ ref: refs[0] })).resolves.toEqual({
      result: { ok: true, value: undefined },
    });
    expect(remote.credentials.unset).toHaveBeenCalledWith(refs[0]);
    const denied = { ok: false, error: { message: 'Not authorized' } };
    remote.credentials.describe.mockResolvedValueOnce(denied as any);
    expect(await api.credentials.describe({ refs })).toEqual({ result: denied });
    remote.settings.describe.mockResolvedValueOnce(denied as any);
    const scope = testing.createDirectSettingsScope(api);
    await expect(scope.reload()).rejects.toThrow('Not authorized');
    await scope.dispose();
  });

  it('normalizes and deduplicates ID lists', () => {
    expect(testing.splitIds('123, 456\n123')).toEqual(['123', '456']);
  });

  it('uses DSH theme tokens instead of fixed light-theme colors', () => {
    expect(CLIENT_SOURCE).toContain('var(--dsw-alias-bg-layer-3)');
    expect(CLIENT_SOURCE).toContain('var(--dsw-alias-label-primary)');
    expect(CLIENT_SOURCE).toContain('var(--dsw-alias-border-l2)');
    expect(CLIENT_SOURCE).not.toContain('--dsw-alias-bg-primary');
    expect(CLIENT_SOURCE).not.toContain('--dsw-alias-text-primary');
    expect(CLIENT_SOURCE).not.toContain('--dsw-alias-border-default');
    expect(CLIENT_SOURCE).not.toContain('--dsw-alias-fill-l2');
    expect(CLIENT_SOURCE).not.toContain('--dsw-font-mono');
    expect(CLIENT_SOURCE).toContain('--ds-font-family-code');
  });

  it('finds the Messenger namespace in a fresh Host description', () => {
    const messenger = { ns: 'messenger', revision: 2 };
    expect(testing.messengerNamespace({
      namespaces: [{ ns: 'shell' }, messenger],
    })).toBe(messenger);
    expect(testing.messengerNamespace({ namespaces: [] })).toBeUndefined();
  });

  it('recognizes only reserved localhost subdomains as local proxies', () => {
    expect(testing.isLocalhostProxy('dsh.localhost')).toBe(true);
    expect(testing.isLocalhostProxy('DSHR.LOCALHOST')).toBe(true);
    expect(testing.isLocalhostProxy('localhost')).toBe(false);
    expect(testing.isLocalhostProxy('dsh.localhost.example.com')).toBe(false);
  });

  it('reads and revision-fences settings through a localhost proxy', async () => {
    const telegram = testing.telegramValue(undefined);
    let mutation: any;
    const namespace = (revision: number, enabled = false) => ({
      ns: 'messenger',
      schema: {},
      value: { telegram: { ...telegram, enabled } },
      base: { telegram },
      applies: 'live',
      secrets: [],
      revision,
    });
    const api = {
      settings: {
        async describe() {
          return { result: { ok: true, value: {
            writable: true,
            hasDocument: true,
            namespaces: [namespace(4)],
          } } };
        },
        async mutate(request: unknown) {
          mutation = request;
          return { result: { ok: true, value: namespace(5, true) } };
        },
      },
    };
    const scope = testing.createDirectSettingsScope(api);
    await scope.reload();
    expect(scope.getSnapshot()).toMatchObject({
      status: 'ready',
      revision: 4,
      writable: true,
      mode: 'host',
    });
    await scope.set('telegram', { ...telegram, enabled: true });
    expect(mutation).toMatchObject({
      ns: 'messenger',
      expectedRevision: 4,
      ops: [{ op: 'set', path: ['telegram'] }],
    });
    expect(scope.getSnapshot()).toMatchObject({
      status: 'ready',
      revision: 5,
      value: { telegram: { enabled: true } },
    });
    await scope.dispose();
  });

  it('serializes proxy reloads and writes so revisions cannot regress', async () => {
    const telegram = testing.telegramValue(undefined);
    let resolveDescribe!: (value: unknown) => void;
    let mutateCalled = false;
    const api = {
      settings: {
        describe() {
          return new Promise((resolve) => {
            resolveDescribe = resolve;
          });
        },
        async mutate() {
          mutateCalled = true;
          return { result: { ok: true, value: {
            ns: 'messenger', schema: {}, value: { telegram: { ...telegram, enabled: true } },
            applies: 'live', secrets: [], revision: 5,
          } } };
        },
      },
    };
    const scope = testing.createDirectSettingsScope(api);
    const reload = scope.reload();
    const write = scope.set('telegram', { ...telegram, enabled: true });
    await Promise.resolve();
    expect(mutateCalled).toBe(false);
    resolveDescribe({ result: { ok: true, value: {
      writable: true,
      hasDocument: true,
      namespaces: [{
        ns: 'messenger', schema: {}, value: { telegram },
        applies: 'live', secrets: [], revision: 4,
      }],
    } } });
    await reload;
    await write;
    expect(scope.getSnapshot()).toMatchObject({ revision: 5 });
    await scope.dispose();
  });

  it('refreshes a proxy scope after a rejected stale write', async () => {
    const telegram = testing.telegramValue(undefined);
    let reads = 0;
    const api = {
      settings: {
        async describe() {
          reads += 1;
          return { result: { ok: true, value: {
            writable: true,
            hasDocument: true,
            namespaces: [{
              ns: 'messenger', schema: {}, value: { telegram },
              applies: 'live', secrets: [], revision: reads === 1 ? 4 : 6,
            }],
          } } };
        },
        async mutate() {
          return { result: { ok: false, error: { message: 'settings revision conflict' } } };
        },
      },
    };
    const scope = testing.createDirectSettingsScope(api);
    await scope.reload();
    await expect(scope.set('telegram', telegram)).rejects.toThrow('settings revision conflict');
    expect(scope.getSnapshot()).toMatchObject({ status: 'ready', revision: 6 });
    await scope.dispose();
  });

  it('waits for an in-flight proxy write during disposal', async () => {
    const telegram = testing.telegramValue(undefined);
    let resolveMutation!: (value: unknown) => void;
    const api = {
      settings: {
        async describe() {
          return { result: { ok: true, value: {
            writable: true,
            hasDocument: true,
            namespaces: [{
              ns: 'messenger', schema: {}, value: { telegram },
              applies: 'live', secrets: [], revision: 1,
            }],
          } } };
        },
        mutate() {
          return new Promise((resolve) => {
            resolveMutation = resolve;
          });
        },
      },
    };
    const scope = testing.createDirectSettingsScope(api);
    await scope.reload();
    const write = scope.set('telegram', telegram);
    await Promise.resolve();
    let disposed = false;
    const disposal = scope.dispose().then(() => {
      disposed = true;
    });
    await Promise.resolve();
    expect(disposed).toBe(false);
    resolveMutation({ result: { ok: true, value: {
      ns: 'messenger', schema: {}, value: { telegram },
      applies: 'live', secrets: [], revision: 2,
    } } });
    await write;
    await disposal;
    expect(disposed).toBe(true);
  });

  it('uses secure Telegram defaults', () => {
    expect(testing.telegramValue(undefined)).toMatchObject({
      enabled: false,
      tokenRef: 'TELEGRAM_BOT_TOKEN',
      privateChatsOnly: true,
      allowedChatIds: [],
      allowedUserIds: [],
    });
  });

  it('detects a Host write that did not land', () => {
    const intended = testing.telegramValue({ telegram: {
      enabled: true,
      tokenRef: 'TELEGRAM_BOT_TOKEN',
      allowedChatIds: ['123'],
      allowedUserIds: [],
      privateChatsOnly: true,
      pollTimeoutSeconds: 30,
      requestTimeoutMs: 15000,
    } });
    const retained = testing.telegramValue(undefined);
    expect(testing.sameTelegram(retained, intended)).toBe(false);
    expect(testing.sameTelegram(intended, intended)).toBe(true);
  });

  it('validates an enabled private-chat configuration', () => {
    expect(testing.validateForm({
      enabled: true,
      tokenRef: 'TELEGRAM_BOT_TOKEN',
      allowedChatIds: '123456789',
      allowedUserIds: '',
      privateChatsOnly: true,
      pollTimeoutSeconds: '30',
      requestTimeoutMs: '15000',
    }, { configured: true }, '')).toMatchObject({
      enabled: true,
      allowedChatIds: ['123456789'],
      privateChatsOnly: true,
    });
  });

  it('rejects non-Telegram credential references and malformed token drafts', () => {
    const base = {
      enabled: false,
      tokenRef: 'OTHER_PROVIDER_SECRET',
      allowedChatIds: '',
      allowedUserIds: '',
      privateChatsOnly: true,
      pollTimeoutSeconds: '30',
      requestTimeoutMs: '15000',
    };
    expect(() => testing.validateForm(base, undefined, '')).toThrow(
      'TELEGRAM_BOT_TOKEN',
    );
    expect(() => testing.validateForm({
      ...base,
      tokenRef: 'TELEGRAM_BOT_TOKEN',
    }, undefined, 'not-a-telegram-token')).toThrow('Telegram bot token format');
  });

  it('requires an operator allowlist for group access', () => {
    expect(() => testing.validateForm({
      enabled: true,
      tokenRef: 'TELEGRAM_BOT_TOKEN',
      allowedChatIds: '-100123456789',
      allowedUserIds: '',
      privateChatsOnly: false,
      pollTimeoutSeconds: '30',
      requestTimeoutMs: '15000',
    }, { configured: true }, '')).toThrow('Group access requires');
  });
});
