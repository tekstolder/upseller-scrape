'use strict';

// api/upseller.js — Vercel (Node 20, CommonJS)
const { chromium } = require('playwright-core');

/* Helpers -------------------------------------------------- */
function json(res, code, obj) {
  res.status(code).setHeader('content-type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(obj));
}

function buildDateStrings({ d, m, y }) {
  const dd = String(d || '').padStart(2, '0');
  const mm = String(m || '').padStart(2, '0');
  const yyyy = String(y || '');
  if (dd.length !== 2 || mm.length !== 2 || yyyy.length !== 4) {
    throw new Error('Parâmetros de data inválidos. Use ?d=DD&m=MM&y=YYYY');
  }
  const from = `${dd}/${mm}/${yyyy}`;
  const to = `${dd}/${mm}/${yyyy}`; // range de 1 dia
  return { from, to };
}

function readEnvs() {
  const WS = process.env.BROWSERLESS_WS || '';
  const RAW = process.env.UPS_COOKIES_JSON || '';
  if (!WS) throw new Error('BROWSERLESS_WS ausente');
  if (!RAW) throw new Error('UPS_COOKIES_JSON ausente');

  // Remove aspas acidentais em volta do JSON
  const trimmed = RAW.trim().replace(/^"+|"+$/g, '');
  let cookies;
  try {
    cookies = JSON.parse(trimmed);
  } catch {
    throw new Error('UPS_COOKIES_JSON não é um JSON válido de array');
  }
  if (!Array.isArray(cookies)) throw new Error('UPS_COOKIES_JSON deve ser um array JSON');
  return { WS, cookies };
}

function normalizeCookies(cookies) {
  return cookies
    .map((c) => ({
      domain: c.domain || 'app.upseller.com',
      path: c.path || '/',
      httpOnly: !!c.httpOnly,
      secure: c.secure !== false, // default true
      sameSite: typeof c.sameSite === 'string' ? c.sameSite : 'Lax',
      name: c.name,
      value: c.value,
    }))
    .filter((c) => c && c.name && c.value);
}

async function waitVisible(page, selectors, timeout = 8000) {
  const tried = [];
  for (const sel of selectors) {
    try {
      const el = await page.waitForSelector(sel, { visible: true, timeout });
      if (el) return { el, sel };
    } catch {
      tried.push(sel);
    }
  }
  const err = new Error('Nenhum seletor ficou visível');
  err.meta = { tried };
  throw err;
}

/* Conexão WS com retry + fallback de região ---------------- */
function swapRegion(url, from, to) {
  return url.includes(from) ? url.replace(from, to) : url;
}

async function connectWithRetryAndFallback(primaryWs, triesPerRegion = 3) {
  const candidates = [
    primaryWs,
    swapRegion(primaryWs, 'production-sfo.', 'production-ams.'),
    swapRegion(primaryWs, 'production-ams.', 'production-sfo.'),
  ].filter(Boolean);

  let lastErr;
  for (const ws of candidates) {
    for (let i = 0; i < triesPerRegion; i++) {
      try {
        return await chromium.connectOverCDP(ws);
      } catch (err) {
        lastErr = err;
        const msg = String(err && err.message || err);
        const is429 = /429|Too Many Requests/i.test(msg);
        const isConn = /WebSocket|connect|closed before/i.test(msg);
        // backoff progressivo com jitter leve
        const waitMs = Math.floor((1000 * Math.pow(2, i)) + Math.random() * 500);
        if (is429 || isConn) await new Promise(r => setTimeout(r, waitMs));
        else throw err; // erro "real"
      }
    }
  }
  throw lastErr;
}

/* Handler -------------------------------------------------- */
module.exports = async function handler(req, res) {
  const started = Date.now();
  let browser, context, page;

  try {
    // Modos de diagnóstico
    const mode = (req.query.mode || '').toString().toLowerCase();
    if (mode === 'ping') {
      const { WS } = readEnvs();
      return json(res, 200, { ok: true, ping: 'alive', hasWS: !!WS });
    }

    // Datas (para fluxo normal)
    let range = null;
    try {
      range = buildDateStrings({ d: req.query.d, m: req.query.m, y: req.query.y });
    } catch (_) {
      if (mode !== 'html') throw new Error('Parâmetros d/m/y obrigatórios (use ?d=DD&m=MM&y=YYYY)');
    }

    const { WS, cookies } = readEnvs();
    const normCookies = normalizeCookies(cookies);

    // Conecta no Browserless com retry + fallback
    browser = await connectWithRetryAndFallback(WS, 2);

    // Contexto (em CDP geralmente já vem 1)
    context = browser.contexts()[0] || await browser.newContext({ ignoreHTTPSErrors: true });
    if (normCookies.length) {
      try { await context.addCookies(normCookies); } catch {}
    }

    page = await context.newPage();
    page.setDefaultTimeout(25000);

    const targetUrl = 'https://app.upseller.com/pt/analytics/store-sales';
    await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });

    // Estabiliza SPA: load → título → presença de elementos-chave
    await page.waitForLoadState('load', { timeout: 20000 });
    await page.waitForFunction(
      () => document.readyState === 'complete' || document.title.toLowerCase().includes('upseller'),
      null, { timeout: 15000 }
    );
    // guarda de estabilidade: espera o datepicker existir no DOM
    await page.waitForFunction(() => {
      const hasPicker =
        document.querySelector('.ant-picker-input input') ||
        document.querySelector('.ant-picker') ||
        document.querySelector('.ant-calendar-picker');
      return hasPicker && document.readyState === 'complete';
    }, null, { timeout: 15000 });
    await page.waitForTimeout(400);

    if (mode === 'html') {
      const html = await page.content();
      const out = {
        ok: true,
        diag: { title: await page.title().catch(() => null), url: page.url(), len: html.length },
        html
      };
      try { await browser.close(); } catch {}
      return json(res, 200, out);
    }

    // ABRIR DATEPICKER com retry curto contra "execution context was destroyed"
    const openerSelectors = [
      '.ant-picker-input input',
      '.ant-picker-range',
      '.ant-picker',
      '[data-testid="date-picker"]',
      'input[placeholder*="Data"]',
      "button[aria-label*='Data']",
    ];

    let opened = false;
    for (let attempt = 0; attempt < 2 && !opened; attempt++) {
      try {
        await page.waitForFunction(() => document.readyState === 'complete', null, { timeout: 5000 });

        for (const sel of openerSelectors) {
          const el = await page.$(sel);
          if (el) {
            await el.click();
            opened = true;
            break;
          }
        }
        if (!opened) throw new Error('Datepicker não encontrado');
      } catch (err) {
        const msg = String(err && err.message || err);
        if (msg.includes('Execution context was destroyed')) {
          await page.waitForLoadState('load', { timeout: 8000 }).catch(() => {});
          await page.waitForTimeout(600);
          continue; // tenta de novo
        }
        throw err;
      }
    }
    if (!opened) throw new Error('Datepicker não encontrado');

    // (Opcional) aqui você pode preencher a data; por ora retornamos a prova de vida:
    const took = Date.now() - started;
    return json(res, 200, {
      ok: true,
      reached: 'datepicker-opened',
      url: page.url(),
      title: await page.title().catch(() => null),
      tookMs: took
    });

  } catch (err) {
    const took = Date.now() - started;
    return json(res, 200, { ok: false, error: String(err && err.message || err), tookMs: took });

  } finally {
    try { if (page) await page.close(); } catch {}
    try { if (context) await context.close(); } catch {}
    try { if (browser) await browser.close(); } catch {}
  }
};
