'use strict';

// Vercel (Node 20, CommonJS)
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
  return { from: `${dd}/${mm}/${yyyy}`, to: `${dd}/${mm}/${yyyy}` };
}

function readEnvs() {
  const WS = process.env.BROWSERLESS_WS || '';
  const RAW = process.env.UPS_COOKIES_JSON || '';
  if (!WS) throw new Error('BROWSERLESS_WS ausente');
  if (!RAW) throw new Error('UPS_COOKIES_JSON ausente');

  const trimmed = RAW.trim().replace(/^"+|"+$/g, '');
  let cookies;
  try { cookies = JSON.parse(trimmed); } catch { throw new Error('UPS_COOKIES_JSON não é um JSON válido de array'); }
  if (!Array.isArray(cookies)) throw new Error('UPS_COOKIES_JSON deve ser um array JSON');
  return { WS, cookies };
}

function normalizeCookies(cookies) {
  return cookies.map((c) => ({
    domain: c.domain || 'app.upseller.com',
    path: c.path || '/',
    httpOnly: !!c.httpOnly,
    secure: c.secure !== false,
    sameSite: typeof c.sameSite === 'string' ? c.sameSite : 'Lax',
    name: c.name, value: c.value,
  })).filter((c) => c && c.name && c.value);
}

function swapRegion(url, from, to) {
  return url.includes(from) ? url.replace(from, to) : url;
}
async function connectWithRetryAndFallback(primaryWs, triesPerRegion = 2) {
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
        const waitMs = Math.floor((800 * Math.pow(2, i)) + Math.random()*400);
        if (is429 || isConn) await new Promise(r => setTimeout(r, waitMs));
        else throw err;
      }
    }
  }
  throw lastErr;
}

/* Handler -------------------------------------------------- */
module.exports = async function handler(req, res) {
  const started = Date.now();
  let browser, context, page;
  const diag = { steps: [], openerCandidates: [], openerClicked: null, dropdownDetected: false };

  try {
    const mode = (req.query.mode || '').toString().toLowerCase();
    if (mode === 'ping') {
      const { WS } = readEnvs();
      return json(res, 200, { ok: true, ping: 'alive', hasWS: !!WS });
    }

    let range = null;
    try { range = buildDateStrings({ d: req.query.d, m: req.query.m, y: req.query.y }); }
    catch (_) { if (mode !== 'html') throw new Error('Parâmetros d/m/y obrigatórios (?d=DD&m=MM&y=YYYY)'); }

    const { WS, cookies } = readEnvs();
    const normCookies = normalizeCookies(cookies);

    browser = await connectWithRetryAndFallback(WS, 2);
    context = browser.contexts()[0] || await browser.newContext({ ignoreHTTPSErrors: true });
    if (normCookies.length) { try { await context.addCookies(normCookies); } catch {} }

    page = await context.newPage();
    page.setDefaultTimeout(25000);

    const targetUrl = 'https://app.upseller.com/pt/analytics/store-sales';
    await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });

    await page.waitForLoadState('load', { timeout: 20000 });
    await page.waitForFunction(
      () => document.readyState === 'complete' || document.title.toLowerCase().includes('upseller'),
      null, { timeout: 15000 }
    );

    // Guarda de estabilidade: espera existir algo "date-like" no DOM
    await page.waitForFunction(() => {
      const q = (sel) => document.querySelector(sel);
      const has =
        q('.ant-picker-input input') || q('.ant-picker-range') || q('.ant-picker') ||
        q('.ant-calendar-picker') || q('input[placeholder*="Data"]') ||
        q('[data-testid*="date"]') || q('[class*="date"]') || q('[class*="calendar"]');
      return has && document.readyState === 'complete';
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

    // ► COLETA CANDIDATOS DE DATEPICKER (no DOM)
    const candidates = await page.evaluate(() => {
      const sels = [
        '.ant-picker-input input', '.ant-picker-range', '.ant-picker',
        '.ant-calendar-picker', '[data-testid*="date"]',
        'input[placeholder*="Data"]', 'input[placeholder*="Período"]',
        '[class*="date"]', '[class*="calendar"]',
        'button', 'div[role="button"]', 'span[role="button"]'
      ];
      const uniq = new Set();
      const results = [];
      for (const sel of sels) {
        document.querySelectorAll(sel).forEach(el => {
          if (!el) return;
          if (!(el.offsetWidth > 0 && el.offsetHeight > 0)) return;
          const path = (el.className || el.tagName || '').toString().slice(0, 120);
          if (uniq.has(el)) return;
          uniq.add(el);
          const rect = el.getBoundingClientRect();
          results.push({
            tag: el.tagName.toLowerCase(),
            sel,
            className: (el.className || '').toString(),
            text: (el.textContent || '').trim().slice(0, 60),
            rect: { x: rect.x, y: rect.y, w: rect.width, h: rect.height }
          });
        });
      }
      // ordena por "provável filtro no topo": y pequeno e largura razoável
      results.sort((a, b) => (a.rect.y - b.rect.y) || (b.rect.w - a.rect.w));
      return results.slice(0, 30);
    });
    diag.openerCandidates = candidates;

    // ► TENTA ABRIR: estratégia 1 (click direto em candidatos mais prováveis)
    const trySelectors = [
      '.ant-picker-input input', '.ant-picker-range', '.ant-picker',
      '.ant-calendar-picker', '[data-testid*="date"]',
      'input[placeholder*="Data"]', 'input[placeholder*="Período"]',
      '[class*="date"]', '[class*="calendar"]'
    ];
    let opened = false;

    for (const sel of trySelectors) {
      const el = await page.$(sel);
      if (!el) continue;
      try {
        await el.click({ delay: 10 });
        // verifica dropdown
        const ddSel = await page.waitForSelector(
          '.ant-picker-dropdown, .ant-picker-panel, .ant-calendar-picker-container, [role="dialog"]',
          { timeout: 1500 }
        ).catch(() => null);
        if (ddSel) {
          opened = true;
          diag.openerClicked = sel;
          diag.dropdownDetected = true;
          break;
        }
      } catch {}
    }

    // ► Estratégia 2: click no centro do bounding box do melhor candidato
    if (!opened && candidates.length) {
      const best = candidates[0];
      await page.evaluate((c) => {
        const el = document.querySelector(c.sel);
        if (!el) return;
        const r = el.getBoundingClientRect();
        const x = r.left + Math.min(r.width - 2, Math.max(8, r.width * 0.5));
        const y = r.top + Math.min(r.height - 2, Math.max(8, r.height * 0.5));
        window.scrollTo({ top: Math.max(0, r.top - 120) });
        const target = document.elementFromPoint(x, y);
        target?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        el.click?.();
      }, best);

      const ddSel = await page.waitForSelector(
        '.ant-picker-dropdown, .ant-picker-panel, .ant-calendar-picker-container, [role="dialog"]',
        { timeout: 1500 }
      ).catch(() => null);
      if (ddSel) {
        opened = true;
        diag.openerClicked = `${best.sel} (bbox)`;
        diag.dropdownDetected = true;
      }
    }

    if (!opened) throw new Error('Datepicker não encontrado');

    // Sucesso até abrir o datepicker — paramos aqui por enquanto
    const took = Date.now() - started;
    return json(res, 200, {
      ok: true,
      reached: 'datepicker-opened',
      url: page.url(),
      title: await page.title().catch(() => null),
      diag,
      tookMs: took
    });

  } catch (err) {
    const took = Date.now() - started;
    return json(res, 200, { ok: false, error: String(err && err.message || err), diag, tookMs: took });

  } finally {
    try { if (page) await page.close(); } catch {}
    try { if (context) await context.close(); } catch {}
    try { if (browser) await browser.close(); } catch {}
  }
};
