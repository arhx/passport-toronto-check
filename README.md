# passport-toronto-check

Мониторинг свободных дат записи на приём в [toronto.pasport.org.ua](https://toronto.pasport.org.ua/solutions/e-queue).

При появлении свободных дат воспроизводит звуковой сигнал и отправляет уведомление в Telegram.

## Как работает

1. Подключается напрямую к реальному IP сервера (`178.20.157.25`), минуя Cloudflare
2. Делает GET-запрос к странице очереди
3. Если страница содержит текст «На разі всі місця зайняті» — мест нет
4. Если форма доступна — делает POST-запрос к API для проверки дат
5. При нахождении дат — играет звук и шлёт Telegram-сообщение

> Никаких браузеров, капчи и сторонних сервисов не требуется.

## Установка

```bash
npm install
```

## Настройка

Скопируй файл конфигурации и заполни своими значениями:

```bash
cp config.example.mjs config.mjs
```

Отредактируй `config.mjs`:

```js
export const TG_TOKEN = 'YOUR_TELEGRAM_BOT_TOKEN';  // токен бота от @BotFather
export const TG_CHAT  = 'YOUR_TELEGRAM_CHAT_ID';    // ID чата или канала
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

### Тест звукового оповещения
```bash
node sound.mjs
```

## Требования

- Node.js 20+
- Windows (звук через PowerShell/Windows Media)
