/**
 * Проверка доступных дат на toronto.pasport.org.ua
 * Использует реальный IP сервера (178.20.157.25) для обхода Cloudflare.
 *
 * Запуск:
 *   node check.mjs              — одна проверка
 *   node check.mjs --watch      — мониторинг каждые 5 минут
 *   node check.mjs --watch 10   — мониторинг каждые 10 минут
 */

import https from 'https';
import zlib from 'zlib';
import { playAlert } from './sound.mjs';
import { TG_TOKEN, TG_CHAT } from './config.mjs';

const REAL_IP  = '178.20.157.25';
const HOST     = 'toronto.pasport.org.ua';
const PATH     = '/solutions/e-queue';
const TARGET   = `https://${HOST}${PATH}`;
const UA       = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36';

// Всегда резолвим в реальный IP — обходим Cloudflare
// Node.js 20+ (Happy Eyeballs) вызывает lookup с { all: true } и ожидает массив
function lookup(hostname, options, callback) {
    if (options && options.all) {
        callback(null, [{ address: REAL_IP, family: 4 }]);
    } else {
        callback(null, REAL_IP, 4);
    }
}

// ─── Состояния ────────────────────────────────────────────────────────────────

const STATE = {
    NO_FORM:         'NO_FORM',         // нет формы, текст "всі місця зайняті"
    FORM_NO_SLOTS:   'FORM_NO_SLOTS',   // форма есть, но days === false
    SLOTS_AVAILABLE: 'SLOTS_AVAILABLE', // есть свободные даты
};

// Персистентная память состояния между итерациями мониторинга
let lastState     = null;  // предыдущее состояние (null = неизвестно)
let lastMessageId = null;  // ID последнего отправленного сообщения в Telegram

// ─── Telegram ─────────────────────────────────────────────────────────────────

function tgRequest(apiMethod, payload) {
    const body = Buffer.from(JSON.stringify(payload));
    return new Promise((resolve) => {
        const r = https.request({
            hostname: 'api.telegram.org',
            path: `/bot${TG_TOKEN}/${apiMethod}`,
            method: 'POST',
            headers: { 'content-type': 'application/json', 'content-length': body.length },
        }, res => {
            const chunks = [];
            res.on('data', c => chunks.push(c));
            res.on('end', () => {
                try { resolve(JSON.parse(Buffer.concat(chunks).toString())); }
                catch { resolve(null); }
            });
        });
        r.on('error', e => { console.error('[tg] Ошибка:', e.message); resolve(null); });
        r.write(body);
        r.end();
    });
}

async function tgSend(text) {
    const res = await tgRequest('sendMessage', { chat_id: TG_CHAT, text, parse_mode: 'HTML' });
    return res?.result?.message_id ?? null;
}

async function tgEdit(messageId, text) {
    await tgRequest('editMessageText', { chat_id: TG_CHAT, message_id: messageId, text, parse_mode: 'HTML' });
}

const HEADER = `📋 <b>passport-toronto-check</b>`;

function stateMessage(state, now, data) {
    switch (state) {
        case STATE.NO_FORM:
            return `${HEADER}\n\n❌ <b>Форми немає</b> — всі місця зайняті (текст на сторінці)\n\n🕐 Актуально: ${now}`;
        case STATE.FORM_NO_SLOTS:
            return `${HEADER}\n\n⚠️ <b>Форма є</b>, але місць немає (<code>days: false</code>)\n\n🔗 ${TARGET}\n\n🕐 Актуально: ${now}`;
        case STATE.SLOTS_AVAILABLE:
            return `${HEADER}\n\n✅ <b>Є вільні дати!</b>\n\n🔗 ${TARGET}\n\n<pre>${JSON.stringify(data, null, 2)}</pre>\n\n🕐 Актуально: ${now}`;
    }
}

async function notifyState(state, now, data) {
    const text = stateMessage(state, now, data);
    if (lastState === null || lastState !== state) {
        // первый запуск или состояние изменилось — новое сообщение
        const msgId = await tgSend(text);
        lastState     = state;
        lastMessageId = msgId;
        console.log(`[tg] Новое сообщение (state=${state}), id=${msgId}`);
    } else {
        // состояние не изменилось — обновляем дату в существующем сообщении
        if (lastMessageId) {
            await tgEdit(lastMessageId, text);
            console.log(`[tg] Обновлено сообщение id=${lastMessageId} (state=${state})`);
        }
    }
}

// ─── HTTP ─────────────────────────────────────────────────────────────────────

function req(opts, body) {
    return new Promise((resolve, reject) => {
        const r = https.request({ lookup, ...opts }, res => {
            const chunks = [];
            const enc = res.headers['content-encoding'];
            let stream = res;
            if (enc === 'gzip')    stream = res.pipe(zlib.createGunzip());
            else if (enc === 'br') stream = res.pipe(zlib.createBrotliDecompress());
            stream.on('data', c => chunks.push(c));
            stream.on('end', () => resolve({
                status: res.statusCode,
                setCookies: res.headers['set-cookie'] || [],
                body: Buffer.concat(chunks).toString(),
            }));
        });
        r.on('error', reject);
        if (body) r.write(body);
        r.end();
    });
}

function mergeCookies(base, setCookies) {
    const jar = {};
    for (const p of (base || '').split(';')) {
        const i = p.indexOf('=');
        if (i > 0) jar[p.slice(0, i).trim()] = p.slice(i + 1).trim();
    }
    for (const line of setCookies) {
        const p = line.split(';')[0];
        const i = p.indexOf('=');
        if (i > 0) jar[p.slice(0, i).trim()] = p.slice(i + 1).trim();
    }
    return Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
}

// ─── Одна проверка ────────────────────────────────────────────────────────────

async function check() {
    // GET — получаем HTML страницы
    const page = await req({
        hostname: HOST, path: PATH,
        headers: {
            'accept': 'text/html,application/xhtml+xml,*/*;q=0.9',
            'accept-encoding': 'gzip, deflate, br',
            'accept-language': 'uk,en-US;q=0.9,en;q=0.8,ru;q=0.7',
            'user-agent': UA,
            'sec-fetch-dest': 'document',
            'sec-fetch-mode': 'navigate',
            'sec-fetch-site': 'none',
        }
    });

    if (page.status !== 200) {
        console.error(`[error] Сервер відповів ${page.status}`);
        return false;
    }

    const now = new Date().toLocaleString('uk-UA', { timeZone: 'America/Toronto' }) + ' (Toronto)';

    // Случай 1: форма отсутствует — места закончились (текст на странице)
    if (page.body.includes('На разі всі місця зайняті')) {
        console.log(`[${now}] → Місць немає (текст на сторінці)`);
        await notifyState(STATE.NO_FORM, now, null);
        return false;
    }

    // Случай 2: форма есть — делаем POST check_services
    const csrfMatch = page.body.match(/csrf:\s*['"]([a-f0-9]{32})['"]/);
    if (!csrfMatch) {
        console.error('[error] CSRF не знайдено і тексту "всі місця зайняті" немає — невідомий стан сторінки.');
        console.error(page.body.slice(0, 300));
        return false;
    }
    const csrf = csrfMatch[1];

    let cookies = mergeCookies('', page.setCookies);

    const boundary = '----WebKitFormBoundaryABCDEFGH12345678';
    const postBody = [
        '--' + boundary, 'Content-Disposition: form-data; name="form"',            '', 'check_services',
        '--' + boundary, 'Content-Disposition: form-data; name="ServiceCenterId"', '', '46',
        '--' + boundary, 'Content-Disposition: form-data; name="ServiceId"',        '', '4',
        '--' + boundary, `Content-Disposition: form-data; name="${csrf}"`,          '', '1',
        '--' + boundary + '--',
    ].join('\r\n') + '\r\n';

    const bodyBuf = Buffer.from(postBody);
    const post = await req({
        hostname: HOST, path: PATH, method: 'POST',
        headers: {
            'accept': 'application/json, text/plain, */*',
            'accept-encoding': 'gzip, deflate, br',
            'accept-language': 'uk,en-US;q=0.9,en;q=0.8,ru;q=0.7',
            'content-type': 'multipart/form-data; boundary=' + boundary,
            'content-length': bodyBuf.length,
            'origin': `https://${HOST}`,
            'referer': TARGET,
            'sec-fetch-dest': 'empty',
            'sec-fetch-mode': 'cors',
            'sec-fetch-site': 'same-origin',
            'priority': 'u=1, i',
            'user-agent': UA,
            'cookie': cookies,
        }
    }, bodyBuf);

    let data;
    try {
        data = JSON.parse(post.body);
    } catch {
        console.error('[error] Неочікувана відповідь POST:', post.body.slice(0, 200));
        return false;
    }

    console.log(`[${now}] Відповідь сервера:`, JSON.stringify(data));

    if (data.days === false) {
        console.log('→ Місць немає');
        await notifyState(STATE.FORM_NO_SLOTS, now, null);
        return false;
    }

    console.log('→ ✅ Є ВІЛЬНІ ДАТИ!');
    console.log(JSON.stringify(data, null, 2));
    await Promise.all([playAlert(), notifyState(STATE.SLOTS_AVAILABLE, now, data)]);
    return true;
}

// ─── Запуск ───────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const watchMode = args.includes('--watch');
const intervalMin = parseInt(args.find(a => /^\d+$/.test(a)) || '5', 10);

function ts() {
    return new Date().toLocaleTimeString('ru-RU');
}

if (watchMode) {
    console.log(`[${ts()}] Моніторинг кожні ${intervalMin} хв. Ctrl+C для зупинки.`);
    try { await check(); } catch (e) {
        console.error(`[${ts()}] [error]`, e.message);
    }
    setInterval(async () => {
        console.log(`[${ts()}] --- Запуск перевірки ---`);
        try { await check(); } catch (e) {
            console.error(`[${ts()}] [error]`, e.message);
        }
    }, intervalMin * 60 * 1000);
} else {
    await check();
}
