# DeepSeek Harness Messenger

A bridge plugin between [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) and messaging platforms. Telegram Bot API is the initial transport, while the architecture is designed to support Yandex Messenger, Discord, and additional adapters.

## Current features

- a **Messengers** page in DSH Web Settings for Telegram setup;
- secure Telegram bot token management through the DSH credential store;
- live Telegram reconfiguration without restarting the Host;
- Telegram chat ID allowlist with unknown chats ignored;
- binding a Telegram chat to a live DSH session;
- sending follow-up and steering messages to Harness;
- canceling an active turn from Telegram;
- mirroring text from `assistant/message` events back to Telegram;
- splitting long responses to respect Telegram limits;
- a shared `MessengerAdapter` interface for future transports.

## Bot commands

| Command | Action |
| --- | --- |
| `/sessions` | List live top-level DSH chats |
| `/use <session-id>` | Bind the current Telegram chat to a DSH chat |
| `/status` | Show the current binding and agent status |
| `/steer <text>` | Send steering to the active turn |
| `/cancel` | Request cancellation of the active turn |
| `/unbind` | Remove the current binding |
| `/help` | Show command help |

Any other text is sent as a separate follow-up to the bound DSH chat.

## Development setup

Node.js 22+ and pnpm 10 are required.

```bash
pnpm install
pnpm check
pnpm test
pnpm build
```

Install the published package into a DSH web profile:

```bash
dsh plugin --profile web add -w --config.auto-install-peers=false @syncended/dsh-messenger
```

For local development, install it from a checkout instead:

```bash
dsh plugin --profile web add /absolute/path/to/deepseek-harness-messenger
```

## DSH configuration

The package exports [`cordis.patch.yml`](./cordis.patch.yml) as its DSH bundle and a Web client plugin. The bundled Telegram adapter is disabled by default, so installation never starts a bot before credentials and access controls are configured.

### Configure in DSH Web

1. Restart the Web profile after installing or upgrading the package.
2. Open **Settings → Messengers → Telegram**.
3. Enter the bot token issued by [BotFather](https://t.me/BotFather). The token is written directly to the DSH credential store and is never saved in plugin settings.
4. Add at least one allowed numeric Telegram chat ID.
5. Keep **Allow private chats only** enabled unless group access is required.
6. Save, then send `/sessions` to the bot and bind it with `/use <session-id>`.

Settings changes apply live. Local reverse-proxy origins under the reserved `.localhost` suffix (for example, `https://dsh.localhost`) are supported; requests still pass through the DSH Host API trust fence. A bot token can also come from the `TELEGRAM_BOT_TOKEN` environment variable; environment-provided credentials are intentionally read-only in the Web page.

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

`tokenRef` contains only the reserved DSH credential reference name `TELEGRAM_BOT_TOKEN`; the secret value belongs in the managed DSH credential store or an environment variable with that name. Other reference names are rejected.

> **Important:** the adapter is disabled by default. When it is enabled with an empty `allowedChatIds`, the plugin ignores every incoming Telegram message. Group chats are also disabled by default; to enable them, set `privateChatsOnly: false` and explicitly list authorized operators in `allowedUserIds`.

### Operator trust model

Every authorized Telegram operator is trusted as a Host-wide DSH operator. They can list and bind any live top-level session, send follow-ups or steering, request cancellation, and receive mirrored assistant text. In a group, mirrored output is visible to every group member even though only IDs in `allowedUserIds` can issue commands. Use a private bot chat unless all group participants may see the connected session.

The credential reference is fixed to `TELEGRAM_BOT_TOKEN` so this plugin cannot resolve, overwrite, or remove credentials owned by another integration. Token values are checked for Telegram bot-token syntax before any request is sent to Telegram.

Inbound commands use at-most-once delivery. Each Telegram update is acknowledged individually before its DSH action starts, preventing a failed reply or restart from replaying a prompt, steering command, or cancellation. A crash or ambiguous acknowledgement can instead drop that one update; resend the command if no response appears.

## Architecture

```text
TelegramAdapter ─┐
YandexAdapter  ──┼─> MessengerBridge ─> ctx.agents ─> DSH session
DiscordAdapter ──┘          ^                  |
                            └─ session/event ──┘
```

- An adapter is responsible only for its messaging platform protocol.
- `MessengerBridge` owns commands, allowlists, bindings, and routing.
- Incoming messages are created through `createUserMessage()` with the `plugin: messenger` source.
- Outgoing responses are read from durable DSH `assistant/message` events.

Bindings are currently process-local and reset when the plugin restarts.

## Roadmap

- Persist bindings through DSH settings or storage.
- Add connection diagnostics and bot identity to the Web GUI.
- Create and resume DSH sessions directly from a messenger.
- Edit streamed responses while generation is in progress.
- Support attachments, images, and files.
- Add a Yandex Messenger adapter.
- Add a Discord adapter.
- Add roles and granular access control for group chats.

## License

MIT
