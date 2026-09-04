# DeepSeek Harness Messenger

A bridge plugin between [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) and messaging platforms. Telegram Bot API is the initial transport, while the adapter boundary is designed for Yandex Messenger, Discord, and additional transports.

<p align="center">
  <img src="./docs/assets/telegram-settings.png" width="560" alt="Dark-theme Telegram configuration in DeepSeek Harness Messenger settings" />
</p>

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
- Claude-style animated progress, typing activity, streamed message edits, and contextual tool status;
- safe Telegram Markdown rendering for headings, emphasis, code, links, quotes, and lists;
- formatting-preserving splitting at Telegram's 4096-character limit;
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

## Agent notifications

The `messenger_notify` tool sends a standalone message to every messenger chat currently bound to the calling agent's session:

```json
{ "text": "The build is ready. You can review the result." }
```

Bind the session first with `/resume` or `/new` in Telegram. Notifications also work when that session is driven from DSH Web rather than Telegram. The tool accepts only text (non-blank, at most 16,000 characters); session and recipient IDs cannot be supplied by the model. Subagents do not inherit their parent's bindings. In a bound group, **every group member can see notifications**.

Use it for explicitly requested notifications or useful milestones, not to duplicate the normal final response or send secrets. Markdown rendering and Telegram message splitting are handled by the adapter. This is an immediate send, not a scheduler, and does not wait for a reply; use `ask_user_question` for questions.

The result reports counts of `sent`, `failed`, and `skipped` chats. A failed multi-part send may already have delivered some text; do not blindly retry partial failures. `sent` means the transport accepted the message, not that the user read it. Queued notifications are skipped if the binding changes, the call is cancelled, or the bridge stops before sending; already-started sends cannot be recalled and multi-part sends may finish after cancellation or unbinding. With no active adapter or binding, the tool returns an error. Bindings reset on plugin restart or successful live reconfiguration; use `/resume` again.

## Progressive responses

A prompt receives an immediate rotating activity placeholder and Telegram typing activity. As DSH events arrive, the plugin coalesces text chunks into throttled `editMessageText` updates and reports bounded reasoning, tool, and checklist status without exposing hidden reasoning.

Raw tool arguments, raw results, file contents, shell output, credentials, and opaque metadata are never mirrored automatically. An allowlist of sanitized contextual fields—such as a path, pattern, command description, query, or item name—may appear in a bounded tool summary. The final assistant response replaces the placeholder and is split safely when needed.

## Requirements

- Node.js 22 or newer.
- DeepSeek Harness `0.1.2-rc.1` or a compatible Web profile.
- A Telegram bot token from [BotFather](https://t.me/BotFather).
- Outbound DNS and HTTPS access to `api.telegram.org` from the Harness host.
- pnpm 10 through Corepack only for source development.

The adapter uses Telegram long polling. Remove any active webhook and stop other processes polling with the same token before enabling it. The plugin has no proxy setting of its own, so configure network egress at the host or runtime level.

## Install

Install the published package into a DSH Web profile:

```bash
dsh plugin --profile web add @syncended/dsh-messenger
```

If the pnpm-backed profile requires workspace-root handling or peer auto-installation must stay disabled:

```bash
dsh plugin --profile web add -w --config.auto-install-peers=false @syncended/dsh-messenger
```

For local development, install a checkout instead:

```bash
pnpm install
pnpm check

dsh plugin --profile web add /absolute/path/to/deepseek-harness-messenger
```

Restart `dsh web` after installing or upgrading and refresh the existing GUI. To remove the plugin:

```bash
dsh plugin --profile web remove @syncended/dsh-messenger
```

## DSH configuration

The package exports [`cordis.patch.yml`](./cordis.patch.yml) as its DSH bundle and a Web client plugin. The Telegram adapter is disabled by default, so installation never starts a bot before credentials and access controls are configured.

### Configure in DSH Web

1. Restart the Web profile after installing or upgrading the package.
2. Open **Settings → Messengers → Telegram**.
3. Enter the token issued by [BotFather](https://t.me/BotFather). It is written directly to the DSH credential store and never saved in plugin settings.
4. Add at least one allowed numeric Telegram chat ID.
5. Keep **Allow private chats only** enabled unless group access is required. For groups, add explicit allowed operator user IDs as well.
6. Turn on **Enable Telegram adapter** and save.
7. Send `/start` to the bot, then choose **Sessions** or **New**.

Settings changes apply live after the initial plugin restart. Local reverse-proxy origins under the reserved `.localhost` suffix, for example `https://dsh.localhost`, are supported; requests still pass through the DSH Host API trust fence. A bot token can also come from the `TELEGRAM_BOT_TOKEN` environment variable of the process launching `dsh web`; environment-provided credentials are intentionally read-only in the Web page.

### Find Telegram chat and user IDs

Before enabling this plugin's poller, send a message to the bot and call Telegram's official `getUpdates` endpoint once:

```bash
curl "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/getUpdates"
```

Use `result[].message.chat.id` as an allowed chat ID and `result[].message.from.id` as an allowed operator user ID. Group chat IDs are normally negative. Do not paste bot tokens into third-party “ID finder” bots or websites.

If `getUpdates` reports a webhook conflict, remove the webhook through the official Bot API before enabling long polling. In groups, review BotFather privacy mode: with privacy mode enabled, Telegram sends the bot commands and directed messages rather than every ordinary group message.

### Configure manually

The same settings can be supplied by editing the existing `messenger` row in `$DSH_HOME/profiles/web/cordis.patch.yml` (normally `~/.dsh/profiles/web/cordis.patch.yml`). Do not add a duplicate row with the same id:

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

`tokenRef` contains only the reserved DSH credential reference `TELEGRAM_BOT_TOKEN`; the secret value belongs in the managed DSH credential store or an environment variable with that name. Other references are rejected. Restart the Host after manual YAML edits; Web settings changes apply live.

> **Important:** the adapter is disabled by default and cannot be enabled until at least one allowed chat ID is configured. Group chats are disabled by default; to enable them, set `privateChatsOnly: false` and explicitly list authorized operators in `allowedUserIds`.

### Operator trust model

Every authorized Telegram operator is trusted as a Host-wide DSH operator. They can discover and resume top-level sessions, create sessions, send prompts and steering, change model/reasoning selection, change the session's DSH permission preset, cancel work, and receive assistant output. `danger-full-access` requires a second Telegram confirmation, but it is still a powerful Host-side mode. Prefer `workspace-write` and use a private bot chat.

In a group, mirrored output is visible to every group member even though only IDs in `allowedUserIds` can issue commands. Use groups only when every participant may see the connected session.

Inline callback payloads contain only opaque random one-use IDs. Ordinary control actions are held in process memory for ten minutes; question options can remain valid for up to 24 hours. Every action is bound to the originating transport, chat, operator, target session, and binding revision. Session IDs, paths, permission payloads, tool arguments, and credentials are not placed in Telegram callback data.

The credential reference is fixed to `TELEGRAM_BOT_TOKEN` so the plugin cannot resolve, overwrite, or remove credentials owned by another integration. Token values are checked for Telegram bot-token syntax before requests are sent.

### Delivery and latency semantics

Inbound updates use explicit at-most-once delivery. The adapter confirms an entire fetched batch with Telegram before scheduling any DSH side effect. Updates returned by that confirmation request are retained as the next batch rather than discarded. A process crash after confirmation can therefore require the operator to resend an update, but prompts and cancellations are not replayed automatically.

Long-poll timeout does not add command latency: Telegram returns a waiting poll immediately when an update arrives, and zero-time confirmation calls use only `requestTimeoutMs`. Poll, confirmation, handler, and Bot API failures are logged; Telegram `retry_after` is honored. Confirmed process-local work is capped at 64 handlers; polling applies backpressure before confirming another batch. Per-chat message handlers keep deterministic order, while callback acknowledgements bypass blocked chat tails and their substantive actions remain serialized.

### Troubleshooting

- An enabled setting is not proof of connectivity. Check Host logs for token validation, DNS/TLS, webhook conflict, polling, and Bot API failures.
- If messages are ignored, verify the numeric chat ID and, for groups, the sender's allowed user ID and `privateChatsOnly` setting.
- If polling reports a conflict, stop the other poller or remove the active webhook.
- If the Web page cannot write settings or credentials, connect directly to the Host or through a supported same-origin `.localhost` reverse proxy.

## Development

```bash
pnpm install
pnpm check
npm pack --dry-run
```

## Architecture

```text
TelegramAdapter ─┐
YandexAdapter  ──┼─> MessengerBridge ─> Session / Workspace controllers
DiscordAdapter ──┘          ^                        |
                            ├──── session/event ─────┘
                            └─ user-question waterfall
```

- An adapter owns only platform protocol, polling, callback acknowledgement, and message primitives.
- `MessengerBridge` owns authorization, opaque callback actions, process-local bindings, controls, and progressive presentation.
- The Host Session Controller provides canonical persisted-session create/resume, prompt, and model-selection paths; the Workspace Registry provides the local workspace roster.
- The messenger registers a prepended `user-questions/request` waterfall answerer and delegates when no Telegram binding can accept the question.
- DSH's permission-preset service performs permission changes; the plugin does not bypass sandbox or approval policy APIs.
- Durable `session/event` records drive streamed text, tool status, and final output.

Bindings and callback actions are currently process-local and reset when the plugin restarts.

## Roadmap

- Persist authorized bindings through DSH storage.
- Add connection diagnostics and bot identity to the Web GUI.
- Support attachments, images, and files.
- Add Yandex Messenger and Discord adapters.
- Add roles and more granular group-chat controls.

## License

MIT
