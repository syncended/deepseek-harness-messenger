window.__ModuleLoader__.load({
  id: "@syncended/dsh-messenger",
  factory: (require) => {
    const module = { exports: {} };
    const exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    const React = require("react");
    const {
      createElement: h,
      useCallback,
      useEffect,
      useMemo,
      useRef,
      useState,
      useSyncExternalStore,
    } = React;

    const TELEGRAM_BOT_TOKEN_REF = "TELEGRAM_BOT_TOKEN";
    const TELEGRAM_BOT_TOKEN_PATTERN = /^\d{6,12}:[A-Za-z0-9_-]{30,}$/;
    const DEFAULT_TELEGRAM = Object.freeze({
      enabled: false,
      tokenRef: TELEGRAM_BOT_TOKEN_REF,
      allowedChatIds: [],
      allowedUserIds: [],
      privateChatsOnly: true,
      pollTimeoutSeconds: 30,
      requestTimeoutMs: 15000,
    });
    const CHAT_ID_PATTERN = /^-?\d+$/;
    const USER_ID_PATTERN = /^\d+$/;

    function responseValue(response) {
      if (!response?.result?.ok) {
        throw new Error(response?.result?.error?.message || "The DSH request failed.");
      }
      return response.result.value;
    }

    function messengerNamespace(describe) {
      return Array.isArray(describe?.namespaces)
        ? describe.namespaces.find((view) => view?.ns === "messenger")
        : undefined;
    }

    function messageOf(error) {
      return error instanceof Error ? error.message : String(error);
    }

    function isLocalhostProxy(hostname) {
      return typeof hostname === "string" && hostname.toLowerCase().endsWith(".localhost");
    }

    function createDirectSettingsScope(api) {
      const listeners = new Set();
      let snapshot = {
        status: "loading",
        value: undefined,
        base: undefined,
        user: undefined,
        revision: undefined,
        writable: false,
        mode: "host",
      };
      let generation = 0;
      let disposed = false;
      let tail = Promise.resolve();

      const publish = (view, writable = snapshot.writable) => {
        if (disposed) return;
        snapshot = {
          status: "ready",
          value: view.value,
          base: view.base,
          user: view.user,
          revision: view.revision,
          writable,
          mode: "host",
        };
        for (const listener of [...listeners]) listener();
      };

      const enqueue = (operation) => {
        const task = tail.then(operation);
        tail = task.catch(() => {});
        return task;
      };

      const load = async () => {
        if (disposed) return;
        const request = ++generation;
        try {
          const described = responseValue(await api.settings.describe({}));
          const view = messengerNamespace(described);
          if (view === undefined) {
            throw new Error("The Messenger Host plugin has not registered its settings namespace.");
          }
          if (disposed || request !== generation) return;
          publish(view, described.writable === true);
        } catch (reason) {
          if (!disposed && request === generation) {
            snapshot = {
              ...snapshot,
              status: snapshot.value === undefined ? "unavailable" : "ready",
            };
            for (const listener of [...listeners]) listener();
          }
          throw reason;
        }
      };

      const reload = () => enqueue(load);

      const set = (field, value) => enqueue(async () => {
        if (disposed) return;
        try {
          const response = await api.settings.mutate({
            ns: "messenger",
            ops: [{ op: "set", path: [field], value }],
            ...(snapshot.revision === undefined ? {} : { expectedRevision: snapshot.revision }),
          });
          const view = responseValue(response);
          if (!disposed) publish(view);
        } catch (reason) {
          try {
            await load();
          } catch {
            // Preserve the write failure; a manual retry can refresh again.
          }
          throw reason;
        }
      });

      return {
        getSnapshot: () => snapshot,
        subscribe(listener) {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        reload,
        set,
        async dispose() {
          disposed = true;
          generation += 1;
          listeners.clear();
          await tail;
        },
      };
    }

    function splitIds(value) {
      return [...new Set(String(value)
        .split(/[\s,]+/)
        .map((item) => item.trim())
        .filter(Boolean))];
    }

    function telegramValue(section) {
      const telegram = section?.telegram;
      if (!telegram || typeof telegram !== "object") return { ...DEFAULT_TELEGRAM };
      return {
        enabled: telegram.enabled === true,
        tokenRef: typeof telegram.tokenRef === "string"
          ? telegram.tokenRef
          : DEFAULT_TELEGRAM.tokenRef,
        allowedChatIds: Array.isArray(telegram.allowedChatIds)
          ? telegram.allowedChatIds.map(String)
          : [],
        allowedUserIds: Array.isArray(telegram.allowedUserIds)
          ? telegram.allowedUserIds.map(String)
          : [],
        privateChatsOnly: telegram.privateChatsOnly !== false,
        pollTimeoutSeconds: Number.isFinite(telegram.pollTimeoutSeconds)
          ? telegram.pollTimeoutSeconds
          : DEFAULT_TELEGRAM.pollTimeoutSeconds,
        requestTimeoutMs: Number.isFinite(telegram.requestTimeoutMs)
          ? telegram.requestTimeoutMs
          : DEFAULT_TELEGRAM.requestTimeoutMs,
      };
    }

    function formValue(telegram) {
      return {
        enabled: telegram.enabled,
        tokenRef: telegram.tokenRef,
        allowedChatIds: telegram.allowedChatIds.join("\n"),
        allowedUserIds: telegram.allowedUserIds.join("\n"),
        privateChatsOnly: telegram.privateChatsOnly,
        pollTimeoutSeconds: String(telegram.pollTimeoutSeconds),
        requestTimeoutMs: String(telegram.requestTimeoutMs),
      };
    }

    function sameTelegram(left, right) {
      return left.enabled === right.enabled
        && left.tokenRef === right.tokenRef
        && left.privateChatsOnly === right.privateChatsOnly
        && left.pollTimeoutSeconds === right.pollTimeoutSeconds
        && left.requestTimeoutMs === right.requestTimeoutMs
        && left.allowedChatIds.length === right.allowedChatIds.length
        && left.allowedChatIds.every((value, index) => value === right.allowedChatIds[index])
        && left.allowedUserIds.length === right.allowedUserIds.length
        && left.allowedUserIds.every((value, index) => value === right.allowedUserIds[index]);
    }

    function validateForm(form, credential, tokenDraft) {
      const tokenRef = form.tokenRef.trim();
      if (tokenRef !== TELEGRAM_BOT_TOKEN_REF) {
        throw new Error(`Telegram credentials must use ${TELEGRAM_BOT_TOKEN_REF}.`);
      }
      if (tokenDraft.trim() && !TELEGRAM_BOT_TOKEN_PATTERN.test(tokenDraft.trim())) {
        throw new Error("The token does not match the Telegram bot token format.");
      }
      const allowedChatIds = splitIds(form.allowedChatIds);
      const invalidChatId = allowedChatIds.find((id) => !CHAT_ID_PATTERN.test(id));
      if (invalidChatId) throw new Error(`Invalid Telegram chat ID: ${invalidChatId}`);

      const allowedUserIds = splitIds(form.allowedUserIds);
      const invalidUserId = allowedUserIds.find((id) => !USER_ID_PATTERN.test(id));
      if (invalidUserId) throw new Error(`Invalid Telegram user ID: ${invalidUserId}`);

      const pollTimeoutSeconds = Number(form.pollTimeoutSeconds);
      if (!Number.isInteger(pollTimeoutSeconds) || pollTimeoutSeconds < 1 || pollTimeoutSeconds > 50) {
        throw new Error("Long-poll timeout must be an integer between 1 and 50 seconds.");
      }
      const requestTimeoutMs = Number(form.requestTimeoutMs);
      if (!Number.isInteger(requestTimeoutMs) || requestTimeoutMs < 1000 || requestTimeoutMs > 120000) {
        throw new Error("Request timeout must be an integer between 1000 and 120000 milliseconds.");
      }
      if (form.enabled && allowedChatIds.length === 0) {
        throw new Error("Add at least one allowed chat ID before enabling Telegram.");
      }
      if (form.enabled && !form.privateChatsOnly && allowedUserIds.length === 0) {
        throw new Error("Group access requires at least one allowed user ID.");
      }
      if (form.enabled && !tokenDraft.trim() && credential?.configured !== true) {
        throw new Error("Store a Telegram bot token before enabling the adapter.");
      }
      return {
        enabled: form.enabled,
        tokenRef,
        allowedChatIds,
        allowedUserIds,
        privateChatsOnly: form.privateChatsOnly,
        pollTimeoutSeconds,
        requestTimeoutMs,
      };
    }

    function Field({ label, hint, children }) {
      return h(
        "label",
        { className: "dsh-msg-field" },
        h("span", { className: "dsh-msg-label" }, label),
        children,
        hint ? h("span", { className: "dsh-msg-hint" }, hint) : null,
      );
    }

    function Toggle({ checked, disabled, onChange, children }) {
      return h(
        "label",
        { className: "dsh-msg-toggle" },
        h("input", {
          type: "checkbox",
          checked,
          disabled,
          onChange: (event) => onChange(event.target.checked),
        }),
        h("span", { className: "dsh-msg-toggle-track", "aria-hidden": true }),
        h("span", null, children),
      );
    }

    function CredentialStatus({ state }) {
      if (state.loading) return h("span", { className: "dsh-msg-pill" }, "Checking token…");
      if (state.error) return h("span", { className: "dsh-msg-pill dsh-msg-pill-error" }, "Credential check failed");
      if (state.value?.configured) {
        const source = state.value.source ? ` · ${state.value.source}` : "";
        return h("span", { className: "dsh-msg-pill dsh-msg-pill-success" }, `Token configured${source}`);
      }
      return h("span", { className: "dsh-msg-pill" }, "Token not configured");
    }

    function MessengerSettings({ scope, settingsDescribe, api, credentialSignals }) {
      const subscribe = useCallback((listener) => scope.subscribe(listener), [scope]);
      const getSnapshot = useCallback(() => scope.getSnapshot(), [scope]);
      const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
      const credentialRevision = useSyncExternalStore(
        credentialSignals.subscribe,
        credentialSignals.getSnapshot,
        credentialSignals.getSnapshot,
      );
      const telegram = useMemo(() => telegramValue(snapshot.value), [snapshot.value]);
      const [form, setForm] = useState(() => formValue(telegram));
      const [dirty, setDirty] = useState(false);
      const [tokenDraft, setTokenDraft] = useState("");
      const [credential, setCredential] = useState({ ref: null, loading: true, value: undefined, error: null });
      const credentialRequest = useRef(0);
      const [busy, setBusy] = useState(false);
      const [error, setError] = useState(null);
      const [notice, setNotice] = useState(null);
      const [settingsRetry, setSettingsRetry] = useState(0);
      const [settingsRecovery, setSettingsRecovery] = useState({ loading: true, error: null });

      useEffect(() => {
        if (!dirty) setForm(formValue(telegram));
      }, [telegram, dirty]);

      const tokenRef = TELEGRAM_BOT_TOKEN_REF;
      const refreshCredential = useCallback(async () => {
        const request = ++credentialRequest.current;
        setCredential({ ref: TELEGRAM_BOT_TOKEN_REF, loading: true, value: undefined, error: null });
        try {
          const value = responseValue(await api.credentials.describe({ refs: [tokenRef] }));
          if (request !== credentialRequest.current) return;
          setCredential({
            ref: tokenRef,
            loading: false,
            value: value.credentials[tokenRef] || { configured: false, writable: true },
            error: null,
          });
        } catch (reason) {
          if (request !== credentialRequest.current) return;
          setCredential({ ref: tokenRef, loading: false, value: undefined, error: messageOf(reason) });
        }
      }, [api, tokenRef]);

      useEffect(() => {
        void refreshCredential();
      }, [refreshCredential, credentialRevision]);

      useEffect(() => {
        if (snapshot.status === "ready") {
          setSettingsRecovery({ loading: false, error: null });
          return undefined;
        }
        let current = true;
        setSettingsRecovery({ loading: true, error: null });
        void (async () => {
          if (typeof scope.reload === "function") {
            await scope.reload();
          } else {
            const response = await api.settings.describe({});
            const view = messengerNamespace(responseValue(response));
            if (view === undefined) {
              throw new Error("The Messenger Host plugin has not registered its settings namespace.");
            }
            await settingsDescribe.ensure();
            if (!current) return;
            settingsDescribe.acceptView(view);
            if (settingsDescribe.getSnapshot().view === undefined) {
              throw new Error("Settings can only be changed from a browser connected directly to this DSH Host.");
            }
          }
          if (current) setSettingsRecovery({ loading: false, error: null });
        })().catch((reason) => {
          if (current) setSettingsRecovery({ loading: false, error: messageOf(reason) });
        });
        return () => {
          current = false;
        };
      }, [api, scope, settingsDescribe, settingsRetry, snapshot.status]);

      const update = (field, value) => {
        setForm((current) => ({ ...current, [field]: value }));
        setDirty(true);
        setError(null);
        setNotice(null);
      };

      const discard = () => {
        setForm(formValue(telegram));
        setTokenDraft("");
        setDirty(false);
        setError(null);
        setNotice(null);
      };

      const save = async () => {
        setBusy(true);
        setError(null);
        setNotice(null);
        let settingsSaved = false;
        try {
          const describedCredential = credential.ref === form.tokenRef.trim()
            ? credential.value
            : undefined;
          const next = validateForm(form, describedCredential, tokenDraft);
          await scope.set("telegram", next);
          const committed = telegramValue(scope.getSnapshot().value);
          if (!sameTelegram(committed, next)) {
            throw new Error("The Host rejected the Messenger settings. Reload and try again.");
          }
          settingsSaved = true;
          if (tokenDraft.trim()) {
            responseValue(await api.credentials.set({ ref: next.tokenRef, value: tokenDraft.trim() }));
            setTokenDraft("");
          }
          setForm(formValue(next));
          setDirty(false);
          await refreshCredential();
          setNotice(next.enabled
            ? "Saved. Telegram is being connected now."
            : "Saved. Telegram is disabled.");
        } catch (reason) {
          const prefix = settingsSaved ? "Settings were saved, but the token update failed: " : "";
          setError(prefix + messageOf(reason));
        } finally {
          setBusy(false);
        }
      };

      const removeToken = async () => {
        if (!window.confirm(`Remove the credential stored as ${tokenRef}?`)) return;
        setBusy(true);
        setError(null);
        setNotice(null);
        try {
          responseValue(await api.credentials.unset({ ref: tokenRef }));
          setTokenDraft("");
          await refreshCredential();
          setNotice("Stored Telegram token removed.");
        } catch (reason) {
          setError(messageOf(reason));
        } finally {
          setBusy(false);
        }
      };

      if (snapshot.status !== "ready") {
        const recoveryText = settingsRecovery.loading
          ? "Loading Messenger settings…"
          : settingsRecovery.error || "Messenger settings are unavailable in this browser.";
        return h(
          "section",
          { className: "dsh-msg-root" },
          h("div", { className: "dsh-msg-empty" },
            h("p", { className: "dsh-msg-empty-text" }, recoveryText),
            settingsRecovery.loading
              ? null
              : h("button", {
                  type: "button",
                  className: "dsh-msg-button",
                  onClick: () => setSettingsRetry((value) => value + 1),
                }, "Retry"),
          ),
        );
      }

      const currentCredential = credential.ref === tokenRef
        ? credential
        : { ref: tokenRef, loading: true, value: undefined, error: null };
      const writable = snapshot.writable && !busy;
      const credentialWritable = currentCredential.value?.writable !== false;
      return h(
        "section",
        { className: "dsh-msg-root" },
        h("div", { className: "dsh-msg-heading" },
          h("h2", null, "Messengers"),
          h("p", null, "Connect messaging platforms to live DeepSeek Harness chats."),
        ),
        h(
          "div",
          { className: "dsh-msg-card" },
          h("div", { className: "dsh-msg-card-head" },
            h("div", null,
              h("h3", null, "Telegram"),
              h("p", null, "Telegram Bot API transport"),
            ),
            h("div", { className: "dsh-msg-statuses" },
              h("span", { className: form.enabled ? "dsh-msg-pill dsh-msg-pill-success" : "dsh-msg-pill" }, form.enabled ? "Enabled" : "Disabled"),
              h(CredentialStatus, { state: currentCredential }),
            ),
          ),
          h(Toggle, {
            checked: form.enabled,
            disabled: !writable,
            onChange: (value) => update("enabled", value),
          }, "Enable Telegram adapter"),
          h(Field, {
            label: "Bot token",
            hint: currentCredential.value?.configured
              ? `Stored as ${TELEGRAM_BOT_TOKEN_REF}. Leave blank to keep the current token.`
              : `Paste the token issued by BotFather. It is stored as ${TELEGRAM_BOT_TOKEN_REF} and sent only to the local DSH Host.`,
          }, h("input", {
            className: "dsh-msg-input",
            type: "password",
            autoComplete: "off",
            value: tokenDraft,
            disabled: !writable || !credentialWritable,
            placeholder: currentCredential.value?.configured ? "Stored" : "123456:ABC…",
            onChange: (event) => {
              setTokenDraft(event.target.value);
              setError(null);
              setNotice(null);
            },
          })),
          currentCredential.error ? h("p", { className: "dsh-msg-error", role: "alert" }, currentCredential.error) : null,
          h("div", { className: "dsh-msg-grid" },
            h(Field, {
              label: "Allowed chat IDs",
              hint: "One numeric ID per line. Private chats use positive IDs; groups normally use negative IDs.",
            }, h("textarea", {
              className: "dsh-msg-input dsh-msg-textarea",
              value: form.allowedChatIds,
              disabled: !writable,
              placeholder: "123456789",
              onChange: (event) => update("allowedChatIds", event.target.value),
            })),
            h(Field, {
              label: "Allowed user IDs",
              hint: form.privateChatsOnly
                ? "Not required while private-chat-only mode is enabled."
                : "Required for group chats so only listed operators can control DSH.",
            }, h("textarea", {
              className: "dsh-msg-input dsh-msg-textarea",
              value: form.allowedUserIds,
              disabled: !writable || form.privateChatsOnly,
              placeholder: "123456789",
              onChange: (event) => update("allowedUserIds", event.target.value),
            })),
          ),
          h(Toggle, {
            checked: form.privateChatsOnly,
            disabled: !writable,
            onChange: (value) => update("privateChatsOnly", value),
          }, "Allow private chats only (recommended)"),
          h("details", { className: "dsh-msg-advanced" },
            h("summary", null, "Advanced network settings"),
            h("div", { className: "dsh-msg-grid dsh-msg-advanced-grid" },
              h(Field, { label: "Long-poll timeout (seconds)" }, h("input", {
                className: "dsh-msg-input",
                type: "number",
                min: 1,
                max: 50,
                value: form.pollTimeoutSeconds,
                disabled: !writable,
                onChange: (event) => update("pollTimeoutSeconds", event.target.value),
              })),
              h(Field, { label: "Request timeout (milliseconds)" }, h("input", {
                className: "dsh-msg-input",
                type: "number",
                min: 1000,
                max: 120000,
                step: 1000,
                value: form.requestTimeoutMs,
                disabled: !writable,
                onChange: (event) => update("requestTimeoutMs", event.target.value),
              })),
            ),
          ),
          error ? h("p", { className: "dsh-msg-error", role: "alert" }, error) : null,
          notice ? h("p", { className: "dsh-msg-notice", role: "status" }, notice) : null,
          h("div", { className: "dsh-msg-actions" },
            h("button", { type: "button", className: "dsh-msg-button dsh-msg-button-primary", disabled: !writable, onClick: () => void save() }, busy ? "Saving…" : "Save"),
            h("button", { type: "button", className: "dsh-msg-button", disabled: busy || (!dirty && !tokenDraft), onClick: discard }, "Discard"),
            currentCredential.value?.configured
              ? h("button", { type: "button", className: "dsh-msg-button dsh-msg-button-danger", disabled: !writable || !credentialWritable, onClick: () => void removeToken() }, "Remove token")
              : null,
          ),
        ),
        h("div", { className: "dsh-msg-card dsh-msg-help" },
          h("h3", null, "After connecting"),
          h("ol", null,
            h("li", null, "Open the bot in Telegram and send ", h("code", null, "/sessions"), "."),
            h("li", null, "Bind the Telegram chat with ", h("code", null, "/use <session-id>"), "."),
            h("li", null, "Send ordinary messages to control the bound DSH chat."),
          ),
        ),
      );
    }

    const STYLE_CSS = [
      ".dsh-msg-root{display:flex;flex-direction:column;gap:16px;padding:4px 0 28px;color:var(--dsw-alias-label-primary);}",
      ".dsh-msg-heading h2,.dsh-msg-card h3{margin:0;}",
      ".dsh-msg-heading p,.dsh-msg-card-head p{margin:5px 0 0;color:var(--dsw-alias-label-tertiary);font-size:13px;}",
      ".dsh-msg-card{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);border-radius:14px;padding:18px;display:flex;flex-direction:column;gap:16px;}",
      ".dsh-msg-card-head{display:flex;justify-content:space-between;gap:16px;align-items:flex-start;}",
      ".dsh-msg-statuses{display:flex;gap:6px;flex-wrap:wrap;justify-content:flex-end;}",
      ".dsh-msg-pill{display:inline-flex;align-items:center;border-radius:999px;padding:3px 8px;background:var(--dsw-alias-interactive-bg-hover);font-size:11px;color:var(--dsw-alias-label-secondary);white-space:nowrap;}",
      ".dsh-msg-pill-success{background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 12%,transparent);color:var(--dsw-alias-state-success-primary);}",
      ".dsh-msg-pill-error{background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 12%,transparent);color:var(--dsw-alias-state-error-primary);}",
      ".dsh-msg-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px;}",
      ".dsh-msg-field{display:flex;flex-direction:column;gap:7px;min-width:0;}",
      ".dsh-msg-label{font-size:12px;font-weight:600;}",
      ".dsh-msg-hint{font-size:11px;line-height:1.45;color:var(--dsw-alias-label-tertiary);}",
      ".dsh-msg-input{width:100%;box-sizing:border-box;border:1px solid var(--dsw-alias-border-l2);border-radius:9px;background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary);padding:9px 10px;font:inherit;font-size:13px;outline:none;}",
      ".dsh-msg-input:focus{border-color:var(--dsw-alias-brand-primary);box-shadow:0 0 0 2px color-mix(in srgb,var(--dsw-alias-brand-primary) 18%,transparent);}",
      ".dsh-msg-input:disabled{color:var(--dsw-alias-label-tertiary);cursor:not-allowed;}",
      ".dsh-msg-textarea{min-height:92px;resize:vertical;font-family:var(--ds-font-family-code,ui-monospace,SFMono-Regular,Menlo,monospace);}",
      ".dsh-msg-toggle{display:inline-flex;align-items:center;gap:9px;font-size:13px;cursor:pointer;width:max-content;max-width:100%;}",
      ".dsh-msg-toggle input{position:absolute;opacity:0;width:1px;height:1px;}",
      ".dsh-msg-toggle-track{position:relative;width:34px;height:19px;border-radius:10px;background:var(--dsw-alias-border-l2);flex:none;transition:background .15s;}",
      ".dsh-msg-toggle-track::after{content:'';position:absolute;top:2px;left:2px;width:15px;height:15px;border-radius:50%;background:var(--dsw-static-neutral-00);box-shadow:var(--dsw-shadow-lv1);transition:transform .15s;}",
      ".dsh-msg-toggle input:checked+.dsh-msg-toggle-track{background:var(--dsw-alias-state-business-primary);}",
      ".dsh-msg-toggle input:checked+.dsh-msg-toggle-track::after{transform:translateX(15px);}",
      ".dsh-msg-toggle input:focus-visible+.dsh-msg-toggle-track{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px;}",
      ".dsh-msg-toggle:has(input:disabled){opacity:.55;cursor:not-allowed;}",
      ".dsh-msg-advanced{border-top:1px solid var(--dsw-alias-border-l2);padding-top:12px;}",
      ".dsh-msg-advanced summary{cursor:pointer;font-size:12px;font-weight:600;}",
      ".dsh-msg-advanced-grid{margin-top:14px;}",
      ".dsh-msg-actions{display:flex;gap:8px;flex-wrap:wrap;align-items:center;}",
      ".dsh-msg-button{border:1px solid var(--dsw-alias-border-l2);border-radius:9px;background:transparent;color:var(--dsw-alias-label-secondary);padding:8px 13px;font:inherit;font-size:12px;font-weight:600;cursor:pointer;}",
      ".dsh-msg-button:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary);}",
      ".dsh-msg-button-primary{background:var(--dsw-alias-button-primary-fill);border-color:transparent;color:var(--dsw-alias-label-primary-foreground);}",
      ".dsh-msg-button-primary:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover);color:var(--dsw-alias-label-primary-foreground);}",
      ".dsh-msg-button-danger{color:var(--dsw-alias-state-error-primary);}",
      ".dsh-msg-button:disabled{opacity:.55;cursor:not-allowed;}",
      ".dsh-msg-error,.dsh-msg-notice{margin:0;border-radius:9px;padding:9px 11px;font-size:12px;line-height:1.45;}",
      ".dsh-msg-error{background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 10%,transparent);color:var(--dsw-alias-state-error-primary);}",
      ".dsh-msg-notice{background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 10%,transparent);color:var(--dsw-alias-state-success-primary);}",
      ".dsh-msg-help ol{margin:0;padding-left:20px;display:flex;flex-direction:column;gap:7px;font-size:13px;}",
      ".dsh-msg-help code{font-family:var(--ds-font-family-code,ui-monospace,SFMono-Regular,Menlo,monospace);background:var(--dsw-alias-interactive-bg-hover);border-radius:5px;padding:1px 5px;}",
      ".dsh-msg-empty{padding:28px;border:1px dashed var(--dsw-alias-border-l2);border-radius:12px;text-align:center;color:var(--dsw-alias-label-tertiary);display:flex;flex-direction:column;align-items:center;gap:12px;}",
      ".dsh-msg-empty-text{margin:0;}",
      "@media(max-width:720px){.dsh-msg-grid{grid-template-columns:1fr}.dsh-msg-card-head{flex-direction:column}.dsh-msg-statuses{justify-content:flex-start}}",
    ].join("\n");

    function createSignalStore() {
      let revision = 0;
      const listeners = new Set();
      return {
        getSnapshot: () => revision,
        subscribe(listener) {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        bump() {
          revision += 1;
          for (const listener of [...listeners]) listener();
        },
      };
    }

    const inject = ["slots", "connection", "remote", "settingsScope"];

    function apply(ctx) {
      const api = ctx.get("connection").api;
      const directScope = isLocalhostProxy(globalThis.location?.hostname)
        ? createDirectSettingsScope(api)
        : undefined;
      const scope = directScope ?? ctx.settingsScope.bind({ namespace: "messenger" });
      const settingsDescribe = directScope === undefined
        ? ctx.settingsScope.describe()
        : undefined;
      const credentialSignals = createSignalStore();

      ctx.effect(() => {
        const tag = document.createElement("style");
        tag.setAttribute("data-plugin", "@syncended/dsh-messenger");
        tag.textContent = STYLE_CSS;
        document.head.appendChild(tag);
        return () => tag.remove();
      }, "messenger: client styles");

      if (directScope !== undefined) {
        ctx.effect(
          () => () => directScope.dispose(),
          "messenger: direct proxy settings scope",
        );
        ctx.effect(() => {
          const refresh = () => {
            void directScope.reload().catch(() => {});
          };
          const disposers = [
            ctx.remote.$on("settings/document-updated", refresh),
            ctx.on("connection/reset", refresh),
          ];
          return () => {
            for (const dispose of disposers) dispose();
          };
        }, "messenger: proxy settings invalidation");
      }

      ctx.effect(
        () => ctx.remote.$on("credentials/reference-updated", () => credentialSignals.bump()),
        "messenger: credential invalidation",
      );

      ctx.slots.inject("settings.section", () => ctx.slots.register({
        name: "settings.section",
        id: "messengers",
        order: 30,
        label: "Messengers",
        inject: () => ({ scope, settingsDescribe, api, credentialSignals }),
      }, MessengerSettings));
    }

    exports.apply = apply;
    exports.inject = inject;
    exports.__testing = Object.freeze({
      splitIds,
      telegramValue,
      sameTelegram,
      validateForm,
      messengerNamespace,
      isLocalhostProxy,
      createDirectSettingsScope,
    });
    return module.exports;
  },
});
