# DeepSeek Harness Messenger

Плагин-мост между [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) и мессенджерами. Базовый транспорт — Telegram Bot API; архитектура рассчитана на добавление Яндекс Мессенджера, Discord и других адаптеров.

## Что уже есть

- подключение Telegram-бота через credential reference DSH;
- allowlist Telegram chat ID — неизвестные чаты игнорируются;
- привязка Telegram-чата к живой DSH-сессии;
- отправка follow-up и steering сообщений в Harness;
- отмена активного turn из Telegram;
- зеркалирование текстовых `assistant/message` событий обратно в Telegram;
- разбиение длинных ответов по лимиту Telegram;
- общий интерфейс `MessengerAdapter` для следующих транспортов.

## Команды бота

| Команда | Действие |
| --- | --- |
| `/sessions` | Показать живые корневые DSH-чаты |
| `/use <session-id>` | Привязать текущий Telegram-чат к DSH-чату |
| `/status` | Показать текущую привязку и статус агента |
| `/steer <text>` | Отправить steering в активный turn |
| `/cancel` | Запросить отмену активного turn |
| `/unbind` | Удалить привязку |
| `/help` | Показать справку |

Обычный текст отправляется как отдельный follow-up в привязанный DSH-чат.

## Установка для разработки

Требуются Node.js 22+ и pnpm 10.

```bash
pnpm install
pnpm check
pnpm test
pnpm build
```

Установка плагина в web-профиль DSH из локального checkout:

```bash
dsh plugin --profile web add /absolute/path/to/deepseek-harness-messenger
```

Или после публикации GitHub-репозитория:

```bash
dsh plugin --profile web add github:syncended/deepseek-harness-messenger
```

## Конфигурация DSH

Добавьте entry из [`cordis.patch.example.yml`](./cordis.patch.example.yml) в patch вашего профиля и укажите разрешённые Telegram chat ID:

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

Токен не хранится в конфигурации плагина. `tokenRef` — имя credential reference в DSH. По умолчанию это `TELEGRAM_BOT_TOKEN`; значение можно сохранить в managed credential store DSH или передать через переменную окружения с тем же именем.

> **Важно:** при пустом `allowedChatIds` плагин запускается, но игнорирует все входящие Telegram-сообщения. Это безопасное поведение по умолчанию. Групповые чаты по умолчанию запрещены; чтобы включить их, задайте `privateChatsOnly: false` и обязательно перечислите управляющих пользователей в `allowedUserIds`.

## Архитектура

```text
TelegramAdapter ─┐
YandexAdapter  ──┼─> MessengerBridge ─> ctx.agents ─> DSH session
DiscordAdapter ──┘          ^                  |
                            └─ session/event ──┘
```

- адаптер отвечает только за протокол конкретного мессенджера;
- `MessengerBridge` отвечает за команды, allowlist, привязки и маршрутизацию;
- входящие сообщения создаются через `createUserMessage()` с источником `plugin: messenger`;
- исходящие ответы читаются из durable `assistant/message` событий DSH.

Привязки пока process-local и сбрасываются при перезапуске плагина.

## Roadmap

- сохранение привязок в DSH settings/storage;
- onboarding и управление токенами из Web GUI;
- создание и возобновление DSH-сессий прямо из мессенджера;
- потоковое редактирование ответа во время генерации;
- вложения, изображения и файлы;
- адаптер Яндекс Мессенджера;
- адаптер Discord;
- роли и granular access control для групповых чатов.

## Лицензия

MIT
