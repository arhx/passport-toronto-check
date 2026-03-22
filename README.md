# passport-toronto-check

Мониторинг свободных дат записи на приём в [toronto.pasport.org.ua](https://toronto.pasport.org.ua/solutions/e-queue).

При появлении свободных дат воспроизводит звуковой сигнал и отправляет уведомление в Telegram.

## Как работает

1. Открывает сайт через Playwright
2. Обходит Cloudflare Turnstile через [anti-captcha.com](https://anti-captcha.com)
3. Делает POST-запрос к API сайта для проверки доступных дат
4. При нахождении дат — играет звук и шлёт Telegram-сообщение

## Установка

```bash
npm install
npx playwright install chromium
```

## Настройка

В `refresh.mjs` задаются константы:

| Константа | Описание |
|---|---|
| `ANTI_CAPTCHA_KEY` | API-ключ от [anti-captcha.com](https://anti-captcha.com) |
| `HEADLESS` | `true` — браузер скрытый, `false` — показывать окно браузера |

В `check.mjs`:

| Константа | Описание |
|---|---|
| `TG_TOKEN` | Токен Telegram-бота |
| `TG_CHAT` | ID чата/канала для уведомлений |

## Запуск

### Одна проверка
```bash
node check.mjs
```

### Мониторинг (каждые 5 минут по умолчанию)
```bash
node check.mjs --watch
```

### Мониторинг с кастомным интервалом (в минутах)
```bash
node check.mjs --watch 10
```

### Только обновить cf_clearance (без проверки)
```bash
node refresh.mjs
```

### Тест звукового оповещения
```bash
node sound.mjs
```

## Первый запуск

При первом запуске (или когда куки протухли) скрипт автоматически откроет браузер, пройдёт CF-challenge через anti-captcha и сохранит `cf_clearance` в `cookies.txt`.

## Требования

- Node.js 18+
- Windows (звук через PowerShell/Windows Media)
- Аккаунт на [anti-captcha.com](https://anti-captcha.com) с балансом
