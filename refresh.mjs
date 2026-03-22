/**
 * Получение свежего cf_clearance через Playwright + anti-captcha
 * Запускается автоматически из check.mjs когда куки протухли,
 * или вручную: node refresh.mjs
 */

import { chromium } from 'playwright';
import ac from '@antiadmin/anticaptchaofficial';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { ANTI_CAPTCHA_KEY, HEADLESS } from './config.mjs';

const __dir = path.dirname(fileURLToPath(import.meta.url));
const COOKIES_FILE = path.join(__dir, 'cookies.txt');
const TARGET = 'https://toronto.pasport.org.ua/solutions/e-queue';

ac.setAPIKey(ANTI_CAPTCHA_KEY);
ac.setSoftId(0);

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }
function cookiesToString(cookies) { return cookies.map(c => `${c.name}=${c.value}`).join('; '); }

const t0 = { val: 0 };
function log(...args) {
    const elapsed = t0.val ? `+${((Date.now() - t0.val) / 1000).toFixed(1)}s` : '';
    const time = new Date().toLocaleTimeString('ru-RU');
    console.log(`[${time}${elapsed ? ' ' + elapsed : ''}]`, ...args);
}

// Инжектируется через page.evaluate() после domcontentloaded.
// НЕ используем addInitScript/context.addInitScript — они ломают CF challenge.
const INIT_SCRIPT = `
    window.__turnstileParams = null;
    window.__cfCallback = null;
    let _ts;
    Object.defineProperty(window, 'turnstile', {
        configurable: true,
        get() { return _ts; },
        set(val) {
            _ts = new Proxy(val, {
                get(target, prop) {
                    if (prop !== 'render') return target[prop];
                    return function(el, opts) {
                        window.__turnstileParams = {
                            websiteURL:  window.location.href,
                            websiteKey:  opts.sitekey,
                            action:      opts.action      || '',
                            cData:       opts.cData       || '',
                            chlPageData: opts.chlPageData || '',
                        };
                        window.__cfCallback = opts.callback;
                        return target.render.apply(target, arguments);
                    };
                }
            });
        }
    });
`;

export async function refreshCookies() {
    t0.val = Date.now();
    log('[refresh] Запуск браузера...');
    const browser = await chromium.launch({
        headless: HEADLESS,
        args: ['--no-sandbox'],
    });

    try {
        const context = await browser.newContext({
            userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36',
            viewport: { width: 1280, height: 800 },
        });

        const page = await context.newPage();

        // Временное логирование всех запросов для диагностики
        page.on('request', req => {
            const url = req.url();
            if (url.includes('cloudflare') || url.includes('challenge') || url.includes('turnstile')) {
                log('[req]', req.resourceType().padEnd(8), url.slice(0, 150));
            }
        });

        // Перехватываем оркестровый скрипт CF и вшиваем обёртку на turnstile.render()
        // прямо в его тело — это гарантирует перехват ДО вызова render().
        await page.route(/\/cdn-cgi\/challenge-platform\/.+\/orchestrate\//, async (route) => {
            log('[refresh] Перехватываем оркестровый скрипт CF...');
            try {
                const response = await route.fetch();
                const body = await response.text();
                const prefix = `;(function(){
                    var _done = false;
                    function wrap() {
                        if (_done || !window.turnstile || !window.turnstile.render) return;
                        var orig = window.turnstile.render.bind(window.turnstile);
                        window.turnstile.render = function(el, opts) {
                            if (!_done) {
                                _done = true;
                                window.__turnstileParams = {
                                    websiteURL:  window.location.href,
                                    websiteKey:  opts.sitekey,
                                    action:      opts.action      || '',
                                    cData:       opts.cData       || '',
                                    chlPageData: opts.chlPageData || '',
                                };
                                window.__cfCallback = opts.callback;
                            }
                            return orig(el, opts);
                        };
                    }
                    var _iv = setInterval(function(){ wrap(); if (_done) clearInterval(_iv); }, 30);
                })();\n`;
                await route.fulfill({ response, body: prefix + body });
            } catch (e) {
                log('[refresh] Ошибка перехвата скрипта:', e.message);
                await route.continue();
            }
        });

        log('[refresh] Загружаем страницу...');
        await page.goto(TARGET, { waitUntil: 'domcontentloaded', timeout: 30000 });

        const title = await page.title();
        log('[refresh] Title:', title);

        // CF не потребовался — собираем куки и выходим
        if (!title.includes('moment') && !title.includes('момент')) {
            log('[refresh] CF не потребовался, собираем куки...');
            const cookies = await context.cookies();
            const cfCookie = cookies.find(c => c.name === 'cf_clearance');
            if (!cfCookie) throw new Error('cf_clearance не найден (CF не блокировал, но куки нет?)');
            const cfStr = `${cfCookie.name}=${cfCookie.value}`;
            fs.writeFileSync(COOKIES_FILE, cfStr + '\n');
            return cfStr;
        }

        log('[refresh] CF challenge обнаружен, ожидаем turnstile params или cf_clearance...');

        let cfAutoPassCookie = null;
        let lastSec = 0;
        const raceResult = await Promise.race([
            // Поллим cf_clearance раз в секунду
            (async () => {
                for (let i = 1; i <= 40; i++) {
                    await delay(1000);
                    lastSec = i;
                    if (i % 5 === 0) log(`[refresh] Ожидание... ${i}s (cf_clearance не появился)`);
                    const cookies = await context.cookies();
                    const cf = cookies.find(c => c.name === 'cf_clearance');
                    if (cf) { cfAutoPassCookie = cf; return 'cookie'; }
                }
                return null;
            })(),
            // Ждём параметры turnstile
            page.waitForFunction(() => window.__turnstileParams && window.__turnstileParams.websiteKey, { timeout: 40000 })
                .then(() => 'turnstile').catch(() => null),
        ]);

        log('[refresh] Race result:', raceResult ?? 'null (timeout)');

        if (!raceResult) {
            throw new Error('CF challenge не пройден за 40 сек');
        }

        // CF прошёл сам (JS-challenge) — cf_clearance уже есть
        if (raceResult === 'cookie') {
            const cfStr = `${cfAutoPassCookie.name}=${cfAutoPassCookie.value}`;
            fs.writeFileSync(COOKIES_FILE, cfStr + '\n');
            log('[refresh] CF прошёл автоматически, cf_clearance сохранён');
            return cfStr;
        }

        // Нужна капча — решаем через anti-captcha
        const params = await page.evaluate(() => window.__turnstileParams);
        log('[refresh] Turnstile params получены:', {
            websiteKey:  params.websiteKey,
            cData:       params.cData?.slice(0, 30),
            chlPageData: params.chlPageData?.slice(0, 30),
        });

        log('[refresh] Отправляем в anti-captcha...');
        const token = await ac.solveTurnstileProxyless(
            params.websiteURL || TARGET,
            params.websiteKey,
            params.action,
            params.cData,
            params.chlPageData,
        );
        log('[refresh] Токен получен:', token.slice(0, 40) + '...');
        ac.getBalance().then(b => log(`[refresh] Баланс anti-captcha: $${b}`)).catch(() => {});

        // Цикл: решаем капчу, ждём cf_clearance или новой капчи (CF может выдать несколько раундов)
        let cfCookie = null;
        let currentToken = token;
        for (let round = 1; round <= 5 && !cfCookie; round++) {
            log(`[refresh] Отправляем токен в CF callback (раунд ${round})...`);
            await page.evaluate((t) => {
                if (window.__cfCallback) window.__cfCallback(t);
            }, currentToken);

            // Сбрасываем params чтобы поймать новую капчу если CF выдаст ещё раунд
            await page.evaluate(() => {
                window.__turnstileParams = null;
                window.__cfCallback = null;
            });

            log(`[refresh] Ожидаем cf_clearance или новую капчу (раунд ${round})...`);
            const result2 = await Promise.race([
                // Поллим cf_clearance
                (async () => {
                    for (let i = 1; i <= 30; i++) {
                        await delay(1000);
                        if (i % 5 === 0) log(`[refresh] Ожидание cf_clearance... ${i}s`);
                        const cookies = await context.cookies();
                        const cf = cookies.find(c => c.name === 'cf_clearance');
                        if (cf) { cfCookie = cf; return 'cookie'; }
                    }
                    return null;
                })(),
                // Ждём новые параметры turnstile (проверяем наличие websiteKey, не просто non-null)
                page.waitForFunction(() => window.__turnstileParams && window.__turnstileParams.websiteKey, { timeout: 30000 })
                    .then(() => 'turnstile').catch(() => null),
            ]);

            if (cfCookie || result2 === 'cookie') break;

            if (result2 === 'turnstile') {
                const params2 = await page.evaluate(() => window.__turnstileParams);
                log(`[refresh] Новый раунд капчи (${round + 1}), отправляем в anti-captcha...`);
                log('[refresh] Turnstile params:', {
                    websiteKey:  params2.websiteKey,
                    cData:       params2.cData?.slice(0, 30),
                    chlPageData: params2.chlPageData?.slice(0, 30),
                });
                currentToken = await ac.solveTurnstileProxyless(
                    params2.websiteURL || TARGET,
                    params2.websiteKey,
                    params2.action,
                    params2.cData,
                    params2.chlPageData,
                );
                log('[refresh] Токен получен:', currentToken.slice(0, 40) + '...');
            } else {
                log('[refresh] Таймаут — cf_clearance не появился и новой капчи нет');
                break;
            }
        }

        if (!cfCookie) throw new Error('cf_clearance не появился после решения капчи');

        const cfStr = `${cfCookie.name}=${cfCookie.value}`;
        fs.writeFileSync(COOKIES_FILE, cfStr + '\n');
        log('[refresh] cf_clearance получен и сохранён');
        return cfStr;

    } finally {
        log('[refresh] Закрываем браузер...');
        await browser.close();
        log('[refresh] Браузер закрыт');
    }
}

// Прямой запуск
if (process.argv[1] === fileURLToPath(import.meta.url)) {
    refreshCookies()
        .then(() => { log('[refresh] Готово!'); process.exit(0); })
        .catch(e => { console.error('[refresh] Ошибка:', e.message); process.exit(1); });
}
