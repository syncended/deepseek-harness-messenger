# DeepSeek Harness Messenger

A bridge plugin between [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) and messaging platforms. Telegram Bot API is the initial transport, while the adapter boundary is designed for Yandex Messenger, Discord, and additional transports.

## Current features

- a **Messengers** page in DSH Web Settings for Telegram setup;
- secure Telegram bot-token management through the DSH credential store;
- live Telegram reconfiguration without restarting the Host;
- private-chat and operator allowlists;
- Telegram's native command menu and inline-button control panel;
- listing and resuming persisted top-level DSH sessions;
- choosing a registered DSH workspace when creating a new session;
- compact dashboards using DSH workspace display names without opaque session hashes;
- provider-grouped, paginated model selection and compact reasoning controls;
- interactive `ask_user_question` choices, multi-select, and free-text answers;
- context pressure, composition, and cumulative token-usage visibility;
- follow-up, steering, and turn cancellation controls;
- immediate `Deep diving…` feedback, typing activity, streamed message edits, and redacted tool/checklist status;
- Unicode-safe splitting at Telegram's 4096-character limit;
- low-latency batch polling without per-chat head-of-line blocking;
- a shared `MessengerAdapter` interface for future transports.

## Telegram controls

Send `/start` or `/menu` to open the dashboard. Its buttons provide session, model, reasoning, permission, context, and cancellation controls.

| Command | Action |
| --- | --- |
| `/menu` | Open the current-session dashboard |
| `/sessions` | List recent persisted top-level DSH sessions |
| `/resume [session-id]` | Choose a session with buttons, or resume the specified session |
| `/new` | Choose a registered workspace (or the Host default directory), then create and bind a new session |
| `/status` | Refresh the dashboard |
| `/model` | Choose an advertised provider/model route |
| `/reasoning` | Choose an effort advertised by the current model |
| `/permission` | Choose a DSH permission preset such as `workspace-write` |
| `/context` | Show context pressure, composition, and cumulative usage |
| `/steer <text>` | Send steering to the active turn |
| `/cancel` | Request cancellation of the active turn |
| `/unbind` | Remove the current binding |
| `/help` | Show command help |

`/use <session-id>` remains as an alias for `/resume <session-id>`. Any other text is queued as a follow-up to the bound session.

Telegram group commands addressed as `/command@bot_username` are accepted only when the suffix matches this bot's identity returned by `getMe`.

When DSH calls `ask_user_question`, the bot pauses typing and shows the question with native option buttons. Single-select, multi-select, free-text answers, batched questions, cancellation, reconnect replay, and concurrent pending questions are supported.

## Progressive responses

A prompt receives an immediate `Deep diving…` placeholder and Telegram typing activity. As DSH events arrive, the plugin coalesces text chunks into throttled edits and reports bounded status such as:

- `💭 Reasoning…` without exposing hidden reasoning text;
- `🔧 tool-name` when a tool starts;
- `✅ tool-name` or `❌ tool-name` when it finishes;
- compact checklist progress.

Tool arguments, raw tool results, file contents, shell output, credentials, and opaque metadata are never mirrored automatically. The final assistant response replaces the placeholder and is split safely when needed.

## Development setup

Node.js 22+ and pnpm 10 are required.

```bash
pnpm install
pnpm check
pnpm test
pnpm build
```

Install the published package into a DSH Web profile:

```bash
dsh plugin --profile web add -w --config.auto-install-peers=false @syncended/dsh-messenger
```

For local development, install it from a checkout instead:

```bash
dsh plugin --profile web add /absolute/path/to/deepseek-harness-messenger
```

## DSH configuration

The package exports [`cordis.patch.yml`](./cordis.patch.yml) as its DSH bundle and a Web client plugin. The Telegram adapter is disabled by default, so installation never starts a bot before credentials and access controls are configured.

### Configure in DSH Web

1. Restart the Web profile after installing or upgrading the package.
2. Open **Settings → Messengers → Telegram**.
3. Enter the bot token issued by [BotFather](https://t.me/BotFather). The token is written directly to the DSH credential store and is never saved in plugin settings.
4. Add at least one allowed numeric Telegram chat ID.
5. Keep **Allow private chats only** enabled unless group access is required.
6. Save, send `/start` to the bot, then choose **Sessions** or **New**.

Settings changes apply live. Local reverse-proxy origins under the reserved `.localhost` suffix, for example `https://dsh.localhost`, are supported; requests still pass through the DSH Host API trust fence. A bot token can also come from the `TELEGRAM_BOT_TOKEN` environment variable; environment-provided credentials are intentionally read-only in the Web page.

### Configure manually

The same settings can be supplied in the Web profile patch:

```yaml
- id: messenger
  config:
    telegram:
      enabled: true
      tokenRef: TELEGRAM_BOT_TOKEN
      allowedChatIds:
        - '123456789'
      allowedUserIds: []
      privateChatsOnly: true
      pollTimeoutSeconds: 30
      requestTimeoutMs: 15000
```

`tokenRef` contains only the reserved DSH credential reference `TELEGRAM_BOT_TOKEN`; the secret value belongs in the managed DSH credential store or an environment variable with that name. Other references are rejected.

> **Important:** the adapter is disabled by default. When enabled with an empty `allowedChatIds`, it ignores every incoming Telegram message. Group chats are disabled by default; to enable them, set `privateChatsOnly: false` and explicitly list authorized operators in `allowedUserIds`.

### Operator trust model

Every authorized Telegram operator is trusted as a Host-wide DSH operator. They can discover and resume top-level sessions, create sessions, send prompts and steering, change model/reasoning selection, change the session's DSH permission preset, cancel work, and receive assistant output. `danger-full-access` requires a second Telegram confirmation, but it is still a powerful Host-side mode. Prefer `workspace-write` and use a private bot chat.

In a group, mirrored output is visible to every group member even though only IDs in `allowedUserIds` can issue commands. Use groups only when every participant may see the connected session.

Inline callback payloads contain only opaque random one-use IDs. Actions are held in process memory, expire after ten minutes, and are bound to the originating transport, chat, operator, target session, and binding revision. Session IDs, paths, permission payloads, tool arguments, and credentials are not placed in Telegram callback data.

The credential reference is fixed to `TELEGRAM_BOT_TOKEN` so the plugin cannot resolve, overwrite, or remove credentials owned by another integration. Token values are checked for Telegram bot-token syntax before requests are sent.

### Delivery and latency semantics

Inbound updates use explicit at-most-once delivery. The adapter confirms an entire fetched batch with Telegram before scheduling any DSH side effect. Updates returned by that confirmation request are retained as the next batch rather than discarded. A process crash after confirmation can therefore require the operator to resend an update, but prompts and cancellations are not replayed automatically.

Long-poll timeout does not add command latency: Telegram returns a waiting poll immediately when an update arrives, and zero-time confirmation calls use only `requestTimeoutMs`. Poll, confirmation, handler, and Bot API failures are logged; Telegram `retry_after` is honored. Confirmed process-local work is capped at 64 handlers; polling applies backpressure before confirming another batch. Per-chat message handlers keep deterministic order, while callback acknowledgements bypass blocked chat tails and their substantive actions remain serialized.

## Architecture

```text
TelegramAdapter ─┐
YandexAdapter  ──┼─> MessengerBridge ─> Host ApiProxy / Agent services
DiscordAdapter ──┘          ^                        |
                            └──── session/event ─────┘
```

- An adapter owns only platform protocol, polling, callback acknowledgement, and message primitives.
- `MessengerBridge` owns authorization, opaque callback actions, process-local bindings, controls, and progressive presentation.
- The existing Host `apiProxy` provides canonical persisted-session create/resume, prompt, and model-selection paths.
- DSH's permission-preset service performs permission changes; the plugin does not bypass sandbox or approval policy APIs.
- Durable `session/event` records drive streamed text, tool status, checklist state, and final output.

Bindings and callback actions are currently process-local and reset when the plugin restarts.

## Roadmap

- Persist authorized bindings through DSH storage.
- Add connection diagnostics and bot identity to the Web GUI.
- Support attachments, images, and files.
- Add Yandex Messenger and Discord adapters.
- Add roles and more granular group-chat controls.

## License

MIT
