/**
 * Проверка доступных дат на toronto.pasport.org.ua
 *
 * Запуск:
 *   node check.mjs              — одна проверка
 *   node check.mjs --watch      — мониторинг каждые 5 минут (продлевает cf_clearance автоматически)
 *   node check.mjs --watch 10   — мониторинг каждые 10 минут
 *
 * При первом запуске (или когда куки протухли):
 *   1. Открой https://toronto.pasport.org.ua/solutions/e-queue в браузере
 *   2. DevTools → Network → любой запрос к сайту → Headers → Cookie
 *   3. Вставь строку куков в cookies.txt
 *
 * CSRF берётся свежий с каждым запросом — вручную обновлять не нужно.
 * cf_clearance продлевается автоматически при каждом успешном GET.
 */

import https from 'https';
import zlib from 'zlib';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { refreshCookies } from './refresh.mjs';
import { playAlert } from './sound.mjs';
import { TG_TOKEN, TG_CHAT } from './config.mjs';

function tgSend(text) {
    const body = Buffer.from(JSON.stringify({ chat_id: TG_CHAT, text, parse_mode: 'HTML' }));
    return new Promise((resolve) => {
        const r = https.request({
            hostname: 'api.telegram.org',
            path: `/bot${TG_TOKEN}/sendMessage`,
            method: 'POST',
            headers: { 'content-type': 'application/json', 'content-length': body.length },
        }, res => { res.resume(); res.on('end', resolve); });
        r.on('error', e => { console.error('[tg] Ошибка:', e.message); resolve(); });
        r.write(body);
        r.end();
    });
}

const __dir = path.dirname(fileURLToPath(import.meta.url));
const COOKIES_FILE = path.join(__dir, 'cookies.txt');
const TARGET = 'https://toronto.pasport.org.ua/solutions/e-queue';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36';
// Аналитические куки — сервер их проверяет
const ANALYTICS_COOKIES = 'dpuniq=68f4e56d703a0a8ebb856b79c42a70a1; _ga=GA1.3.568634719.1774197447; _gid=GA1.3.1152477025.1774197447; _gcl_au=1.1.1893235250.1774197447; _ga_8S4FFWEDL2=GS2.1.s1774197446';

// ─── HTTP ────────────────────────────────────────────────────────────────────

function req(opts, body) {
    return new Promise((resolve, reject) => {
        const r = https.request(opts, res => {
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

// ─── Куки ────────────────────────────────────────────────────────────────────

function loadCookies() {
    if (!fs.existsSync(COOKIES_FILE)) return '';
    return fs.readFileSync(COOKIES_FILE, 'utf-8').trim().split('\n')[0].trim();
}

function saveCookies(str) {
    fs.writeFileSync(COOKIES_FILE, str + '\n', 'utf-8');
}

function mergeCookies(base, setCookies) {
    const jar = {};
    for (const p of base.split(';')) {
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

// ─── Одна проверка ───────────────────────────────────────────────────────────

async function check() {
    let saved = loadCookies();
    if (!saved) {
        console.log('[check] cookies.txt пуст — получаем cf_clearance...');
        saved = await refreshCookies();
    }

    // Берём только cf_clearance + добавляем аналитические куки (сервер их проверяет)
    const cfPart = saved.split(';').find(c => c.trim().startsWith('cf_clearance'))?.trim() || saved.trim();
    let cookies = cfPart + '; ' + ANALYTICS_COOKIES;

    // Шаг 1: GET — свежий CSRF + PHP-сессия + продление cf_clearance
    const page = await req({
        hostname: 'toronto.pasport.org.ua', path: '/solutions/e-queue',
        headers: {
            'accept': 'text/html,application/xhtml+xml,*/*;q=0.9',
            'accept-encoding': 'gzip, deflate, br',
            'accept-language': 'uk,en-US;q=0.9,en;q=0.8,ru;q=0.7',
            'user-agent': UA,
            'sec-fetch-dest': 'document',
            'sec-fetch-mode': 'navigate',
            'sec-fetch-site': 'none',
            'cookie': cookies,
        }
    });

    if (page.status === 403 || page.body.includes('Just a moment')) {
        console.log('[check] CF заблокировал — получаем новый cf_clearance...');
        saved = await refreshCookies();
        const cf = saved.split(';').find(c => c.trim().startsWith('cf_clearance'))?.trim() || saved.trim();
        cookies = cf + '; ' + ANALYTICS_COOKIES;
        return check();
    }

    // Добавляем PHP-сессию из GET-ответа к нашим кукам
    cookies = mergeCookies(cookies, page.setCookies);
    // Сохраняем только cf_clearance (аналитика статична)
    const cfUpdated = page.setCookies.find(c => c.startsWith('cf_clearance'))?.split(';')[0] || cfPart;
    saveCookies(cfUpdated);

    const csrfMatch = page.body.match(/csrf:\s*['"]([a-f0-9]{32})['"]/);
    if (!csrfMatch) {
        console.error('[error] CSRF не найден на странице.');
        process.exit(1);
    }
    const csrf = csrfMatch[1];

    // Шаг 2: POST check_services
    const boundary = '----WebKitFormBoundaryABCDEFGH12345678';
    const body = [
        '--' + boundary, 'Content-Disposition: form-data; name="form"',            '', 'check_services',
        '--' + boundary, 'Content-Disposition: form-data; name="ServiceCenterId"', '', '46',
        '--' + boundary, 'Content-Disposition: form-data; name="ServiceId"',        '', '4',
        '--' + boundary, `Content-Disposition: form-data; name="${csrf}"`,          '', '1',
        '--' + boundary + '--',
    ].join('\r\n') + '\r\n';

    const bodyBuf = Buffer.from(body);
    const post = await req({
        hostname: 'toronto.pasport.org.ua', path: '/solutions/e-queue', method: 'POST',
        headers: {
            'accept': 'application/json, text/plain, */*',
            'accept-encoding': 'gzip, deflate, br',
            'accept-language': 'uk,en-US;q=0.9,en;q=0.8,ru;q=0.7',
            'content-type': 'multipart/form-data; boundary=' + boundary,
            'content-length': bodyBuf.length,
            'origin': 'https://toronto.pasport.org.ua',
            'referer': TARGET,
            'sec-fetch-dest': 'empty',
            'sec-fetch-mode': 'cors',
            'sec-fetch-site': 'same-origin',
            'priority': 'u=1, i',
            'user-agent': UA,
            'cookie': cookies,
        }
    }, bodyBuf);

    if (post.setCookies.length > 0) {
        saveCookies(mergeCookies(cookies, post.setCookies));
    }

    let data;
    try {
        data = JSON.parse(post.body);
    } catch {
        console.error('[error] Неожиданный ответ:', post.body.slice(0, 200));
        return false;
    }

    const now = new Date().toLocaleString('uk-UA', { timeZone: 'America/Toronto' });
    console.log(`[${now}] Відповідь сервера:`, JSON.stringify(data));

    if (data.days === false) {
        console.log('→ Місць немає');
        return false;
    } else {
        console.log('→ ✅ Є ВІЛЬНІ ДАТИ!');
        console.log(JSON.stringify(data, null, 2));
        const msg = `✅ <b>Є вільні дати!</b>\n${now}\n\n<pre>${JSON.stringify(data, null, 2)}</pre>`;
        await Promise.all([playAlert(), tgSend(msg)]);
        return true;
    }
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
        console.log(`[${ts()}] Наступна спроба через ${intervalMin} хв...`);
    }
    setInterval(async () => {
        console.log(`[${ts()}] --- Запуск перевірки ---`);
        try { await check(); } catch (e) {
            console.error(`[${ts()}] [error]`, e.message);
            console.log(`[${ts()}] Наступна спроба через ${intervalMin} хв...`);
        }
    }, intervalMin * 60 * 1000);
} else {
    await check();
}
