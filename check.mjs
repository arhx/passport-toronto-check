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

// ─── Telegram ─────────────────────────────────────────────────────────────────

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

    const now = new Date().toLocaleString('uk-UA', { timeZone: 'America/Toronto' });

    // Случай 1: форма отсутствует — места закончились (текст на странице)
    if (page.body.includes('На разі всі місця зайняті')) {
        console.log(`[${now}] → Місць немає (текст на сторінці)`);
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
        return false;
    }

    console.log('→ ✅ Є ВІЛЬНІ ДАТИ!');
    console.log(JSON.stringify(data, null, 2));
    const msg = `✅ <b>Є вільні дати!</b>\n${now}\n\n<pre>${JSON.stringify(data, null, 2)}</pre>`;
    await Promise.all([playAlert(), tgSend(msg)]);
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
