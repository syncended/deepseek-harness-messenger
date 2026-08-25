# DeepSeek Harness Messenger

A bridge plugin between [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) and messaging platforms. Telegram Bot API is the initial transport, while the architecture is designed to support Yandex Messenger, Discord, and additional adapters.

## Current features

- Telegram bot connectivity through a DSH credential reference;
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

Install the plugin into a DSH web profile from a local checkout:

```bash
dsh plugin --profile web add /absolute/path/to/deepseek-harness-messenger
```

Or install it directly from GitHub:

```bash
dsh plugin --profile web add github:syncended/deepseek-harness-messenger
```

## DSH configuration

Add the entry from [`cordis.patch.example.yml`](./cordis.patch.example.yml) to your profile patch and provide the allowed Telegram chat IDs:

```yaml
- insert:
    - id: messenger
      name: deepseek-harness-messenger
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

The token is never stored in the plugin configuration. `tokenRef` is the name of a DSH credential reference. It defaults to `TELEGRAM_BOT_TOKEN`; its value can be stored in the managed DSH credential store or supplied through an environment variable with the same name.

> **Important:** when `allowedChatIds` is empty, the plugin starts but ignores every incoming Telegram message. This is the secure default. Group chats are disabled by default; to enable them, set `privateChatsOnly: false` and explicitly list authorized operators in `allowedUserIds`.

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
- Add onboarding and token management to the Web GUI.
- Create and resume DSH sessions directly from a messenger.
- Edit streamed responses while generation is in progress.
- Support attachments, images, and files.
- Add a Yandex Messenger adapter.
- Add a Discord adapter.
- Add roles and granular access control for group chats.

## License

MIT
