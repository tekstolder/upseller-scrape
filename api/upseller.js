'use strict';

// Vercel (Node 20, CommonJS)
const { chromium } = require('playwright-core');

/* -------------------------- Helpers -------------------------- */
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

/* -------------------------- Core -------------------------- */
module.exports = async function handler(req, res) {
  const started = Date.now();
  let browser, context, page;

  // modos de diagnóstico
  const mode = (req.query.mode || '').toString().toLowerCase();
  if (mode === 'ping') {
    try {
      const { WS } = readEnvs();
      return json(res, 200, { ok: true, ping: 'alive', hasWS: !!WS });
    } catch (err) {
      return json(res, 200, { ok: false, error: String(err && err.message || err) });
    }
  }

  let range = null;
  try { range = buildDateStrings({ d: req.query.d, m: req.query.m, y: req.query.y }); }
  catch (_) { if (mode !== 'html') return json(res, 200, { ok: false, error: 'Parâmetros d/m/y obrigatórios (?d=DD&m=MM&y=YYYY)' }); }

  try {
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

    if (mode === 'html') {
      const html = await page.content();
      const out = { ok: true, diag: { title: await page.title().catch(() => null), url: page.url(), len: html.length }, html };
      try { await browser.close(); } catch {}
      return json(res, 200, out);
    }

    // --- guarda de estabilidade: presença de algo "date-like" no DOM ---
    await page.waitForFunction(() => {
      const q = (sel) => document.querySelector(sel);
      const has =
        q('.ant-picker-input input') || q('.ant-picker-range') || q('.ant-picker') ||
        q('.ant-calendar-picker') || q('input[placeholder*="Data"]') ||
        q('[data-testid*="date"]') || q('[class*="date"]') || q('[class*="calendar"]');
      return has && document.readyState === 'complete';
    }, null, { timeout: 15000 });
    await page.waitForTimeout(300);

    // --- abrir datepicker (duas tentativas, lida com SPA re-render) ---
    const openerSelectors = [
      '.ant-calendar-picker',
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
          if (!el) continue;
          await el.click({ delay: 10 });
          const dd = await page.waitForSelector(
            '.ant-picker-dropdown, .ant-picker-panel, .ant-calendar-picker-container, [role="dialog"]',
            { timeout: 1500 }
          ).catch(() => null);
          if (dd) { opened = true; break; }
        }
        if (!opened) throw new Error('Datepicker não encontrado');
      } catch (err) {
        if (String(err).includes('Execution context was destroyed')) {
          await page.waitForLoadState('load', { timeout: 8000 }).catch(() => {});
          await page.waitForTimeout(600);
          continue;
        }
        throw err;
      }
    }
    if (!opened) return json(res, 200, { ok: false, error: 'Datepicker não encontrado' });

    // --- preencher os DOIS inputs (início e fim) dentro do dropdown ---
    // localiza os inputs na dropdown/painel de calendário
    let inputs = await page.$$('.ant-picker-dropdown .ant-picker-input input');
    if (inputs.length < 2) {
      inputs = await page.$$('.ant-picker-panel .ant-picker-input input');
    }
    if (inputs.length < 2) {
      // fallback ultra genérico: pega inputs visíveis na dropdown
      inputs = await page.$$('.ant-picker-dropdown input, .ant-picker-panel input');
    }
    if (!inputs.length) {
      return json(res, 200, { ok: false, error: 'Inputs do date-range não encontrados' });
    }

    // define start (índice 0) e end (índice 1 ou o mesmo se não houver dois)
    const startInput = inputs[0];
    const endInput = inputs[1] || inputs[0];

    async function typeOrSet(el, value) {
      try {
        await el.click({ clickCount: 3 });
        await page.keyboard.type(value);
        return 'typed';
      } catch {
        await page.evaluate((e, v) => {
          e.value = v;
          e.dispatchEvent(new Event('input', { bubbles: true }));
          e.dispatchEvent(new Event('change', { bubbles: true }));
        }, el, value);
        return 'setValue';
      }
    }

    const stratA = await typeOrSet(startInput, range.from);
    await page.waitForTimeout(150);
    const stratB = await typeOrSet(endInput, range.to);

    // aplica o filtro: tecla Enter ou botão OK
    let applied = false;
    try { await page.keyboard.press('Enter'); applied = true; } catch {}
    if (!applied) {
      const okBtn = await page.$('.ant-picker-dropdown .ant-picker-ok button, .ant-calendar-ok-btn');
      if (okBtn) { await okBtn.click().catch(() => {}); applied = true; }
    }

    // aguarda atualização do painel
    await page.waitForTimeout(1000);
    await page.waitForFunction(() => {
      // presença de tabela ou estatísticas
      const hasTable = document.querySelector('.ant-table, [class*="table"]');
      const hasStat = document.querySelector('.ant-statistic, [class*="statistic"]');
      return !!(hasTable || hasStat);
    }, null, { timeout: 8000 }).catch(() => {});

    // --- coleta KPIs (tentativas comuns na UI do Ant e variações do painel) ---
    const kpis = await page.evaluate(() => {
      function pickText(el) { return (el && (el.textContent || '') || '').trim(); }
      function parseNumberLike(s) {
        if (!s) return null;
        // troca ponto de milhar BR e vírgula decimal
        const norm = s.replace(/\s/g, '').replace(/\./g, '').replace(',', '.').replace(/[^0-9.\-]/g, '');
        const val = Number(norm);
        return Number.isFinite(val) ? val : null;
      }
      const out = {};

      // 1) cards do Ant Statistic
      document.querySelectorAll('.ant-statistic').forEach((card) => {
        const label = pickText(card.querySelector('.ant-statistic-title')) || pickText(card.previousElementSibling);
        const valTxt = pickText(card.querySelector('.ant-statistic-content, .ant-statistic-content-value'));
        if (label && valTxt) out[label.toLowerCase()] = valTxt;
      });

      // 2) títulos/metas rápidas
      document.querySelectorAll('.ant-card .ant-card-meta-title, .ant-card-head-title').forEach((el) => {
        const lbl = pickText(el);
        const sibling = el.parentElement?.parentElement?.querySelector('.ant-statistic-content, .ant-typography, .ant-card-meta-description');
        const valTxt = pickText(sibling);
        if (lbl && valTxt) out[lbl.toLowerCase()] = valTxt;
      });

      // 3) possíveis labels comuns
      const knownLabels = ['faturamento', 'pedidos', 'ticket', 'ticket médio', 'conversão', 'itens por pedido'];
      knownLabels.forEach((lbl) => {
        const node = Array.from(document.querySelectorAll('*')).find(n => (n.textContent || '').toLowerCase().includes(lbl));
        if (node) {
          // pega o número mais próximo dentro do mesmo bloco
          const block = node.closest('.ant-card, .ant-statistic, .ant-col, .ant-typography, div');
          const txt = pickText(block);
          // última ocorrência de um número dentro do bloco
          const m = txt.match(/-?\d{1,3}(\.\d{3})*(,\d+)?|R\$\s*\d[\d\.\,]*/g);
          if (m && !out[lbl]) out[lbl] = m[m.length - 1];
        }
      });

      // normaliza chaves
      const normalized = {};
      Object.entries(out).forEach(([k, v]) => {
        const key = k.normalize('NFD').replace(/[\u0300-\u036f]/g, '')
          .replace(/[^\w\s]/g, '').replace(/\s+/g, ' ').trim();
        normalized[key] = v;
      });
      return normalized;
    });

    // --- coleta amostra da tabela (primeiras 10 linhas x colunas) ---
    const tableSample = await page.evaluate(() => {
      const table = document.querySelector('.ant-table');
      if (!table) return null;
      const rows = Array.from(table.querySelectorAll('tbody tr')).slice(0, 10).map(tr =>
        Array.from(tr.querySelectorAll('td')).map(td => (td.textContent || '').trim())
      );
      const headers = Array.from(table.querySelectorAll('thead th')).map(th => (th.textContent || '').trim());
      return { headers, rows };
    });

    const tookMs = Date.now() - started;
    return json(res, 200, {
      ok: true,
      period: { from: range.from, to: range.to },
      page: { title: await page.title().catch(() => null), url: page.url() },
      kpis,
      tableSample,
      tookMs
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
