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

Скопируй файл конфигурации и заполни своими значениями:

```bash
cp config.example.mjs config.mjs
```

Отредактируй `config.mjs`:

```js
export const TG_TOKEN         = 'YOUR_TELEGRAM_BOT_TOKEN';   // токен бота от @BotFather
export const TG_CHAT          = 'YOUR_TELEGRAM_CHAT_ID';     // ID чата или канала
export const ANTI_CAPTCHA_KEY = 'YOUR_ANTICAPTCHA_KEY';      // ключ с anti-captcha.com
export const HEADLESS         = true;  // false — показывать окно браузера
```

> `config.mjs` добавлен в `.gitignore` и не попадает в репозиторий.

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

Чтобы наблюдать за процессом — поставь `HEADLESS = false` в `config.mjs`.

## Требования

- Node.js 18+
- Windows (звук через PowerShell/Windows Media)
- Аккаунт на [anti-captcha.com](https://anti-captcha.com) с балансом
