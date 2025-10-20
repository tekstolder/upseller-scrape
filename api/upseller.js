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
  return { from: `${dd}/${mm}/${yyyy}`, to: `${dd}/${mm}/${yyyy}`, dd, mm, yyyy };
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

/* ------------------ Calendar helpers (Ant Design) ------------------ */
async function waitDropdown(page) {
  const dd = await page.waitForSelector(
    '.ant-picker-dropdown, .ant-picker-panel, .ant-calendar-picker-container, [role="dialog"]',
    { timeout: 4000 }
  ).catch(() => null);
  if (!dd) throw new Error('Dropdown do calendário não abriu');
}

async function ensureMonthYear(page, y, m) {
  // Tenta detectar mês/ano atuais em ambos os painéis (esquerdo/direito)
  // e usa header prev/next até chegar no alvo.
  const alvo = { y: Number(y), m: Number(m) }; // 1..12
  const maxSteps = 24; // limite de iterações

  function monthIndexPT(txt) {
    const t = (txt || '').toLowerCase();
    const nomes = ['janeiro','fevereiro','mar','março','abril','maio','junho','julho','agosto','setembro','outubro','novembro','dezembro'];
    for (let i = 0; i < nomes.length; i++) {
      if (t.includes(nomes[i])) {
        // 'mar' cobre 'março'
        if (nomes[i] === 'mar' && !t.includes('mar')) continue;
        return i % 12; // 0..11
      }
    }
    return -1;
  }

  for (let step = 0; step < maxSteps; step++) {
    const pos = await page.evaluate(() => {
      function readPanel(root) {
        if (!root) return null;
        const mBtn = root.querySelector('.ant-picker-month-btn, .ant-calendar-month-select');
        const yBtn = root.querySelector('.ant-picker-year-btn, .ant-calendar-year-select');
        const mt = (mBtn?.textContent || '').trim();
        const yt = (yBtn?.textContent || '').trim();
        return { mt, yt };
      }
      const dd = document.querySelector('.ant-picker-dropdown, .ant-picker-panel, .ant-calendar-picker-container') || document;
      const panels = Array.from(dd.querySelectorAll('.ant-picker-panel'));
      const legacyLeft  = dd.querySelector('.ant-calendar-range-left');
      const legacyRight = dd.querySelector('.ant-calendar-range-right');
      const L = panels[0] || legacyLeft;
      const R = panels[1] || legacyRight;
      return { left: readPanel(L), right: readPanel(R) };
    });

    const candidates = [pos.left, pos.right].filter(Boolean);
    let found = false;
    for (const p of candidates) {
      const mi = monthIndexPT(p.mt);
      const yy = parseInt(p.yt, 10);
      if (mi >= 0 && yy) {
        const cur = { y: yy, m: mi + 1 };
        if (cur.y === alvo.y && cur.m === alvo.m) {
          found = true; break;
        }
      }
    }
    if (found) return;

    // decide ir para trás ou frente: se ano/mes alvo é anterior ao atual (primeiro painel)
    const goPrev = await page.evaluate(({ monthIndexPTStr, alvo }) => {
      function monthIndexPT(txt) {
        const t = (txt || '').toLowerCase();
        const nomes = ['janeiro','fevereiro','mar','março','abril','maio','junho','julho','agosto','setembro','outubro','novembro','dezembro'];
        for (let i = 0; i < nomes.length; i++) {
          if (t.includes(nomes[i])) return i % 12;
        }
        return -1;
      }
      const dd = document.querySelector('.ant-picker-dropdown, .ant-picker-panel, .ant-calendar-picker-container') || document;
      const panel = dd.querySelector('.ant-picker-panel') || dd;
      const mBtn = panel.querySelector('.ant-picker-month-btn, .ant-calendar-month-select');
      const yBtn = panel.querySelector('.ant-picker-year-btn, .ant-calendar-year-select');
      const mi = monthIndexPT(mBtn?.textContent || '');
      const yy = parseInt(yBtn?.textContent || '0', 10);
      if (!yy || mi < 0) return false;
      // comparar curr (yy, mi+1) com alvo (y, m)
      if (yy > alvo.y) return true;
      if (yy < alvo.y) return false;
      // mesmo ano
      return (mi + 1) > alvo.m;
    }, { monthIndexPTStr: monthIndexPT.toString(), alvo });

    const btnSel = goPrev
      ? '.ant-picker-header-prev-btn, .ant-calendar-prev-month-btn'
      : '.ant-picker-header-next-btn, .ant-calendar-next-month-btn';
    const btn = await page.$(btnSel);
    if (btn) await btn.click({ delay: 10 });
    await page.waitForTimeout(200);
  }

  throw new Error('Não foi possível posicionar mês/ano no calendário');
}

async function clickDayTwice(page, d) {
  // Seleciona o dia no(s) painel(is) visíveis (novo e legado)
  const dia = String(parseInt(d, 10));
  // tenta no painel novo
  const selNew = `.ant-picker-cell-in-view .ant-picker-cell-inner:text-is("${dia}")`;
  const elNew = await page.$(selNew).catch(() => null);
  if (elNew) {
    await elNew.click();
    await page.waitForTimeout(250);
    await elNew.click();
    return 'new';
  }
  // tenta no legado
  const selOld = `.ant-calendar-date:text-is("${dia}")`;
  const elOld = await page.$(selOld).catch(() => null);
  if (elOld) {
    await elOld.click();
    await page.waitForTimeout(250);
    await elOld.click();
    return 'old';
  }
  // fallback: procura por células de dia e compara texto
  const ok = await page.evaluate((dia) => {
    const cells = Array.from(document.querySelectorAll('.ant-picker-cell-inner, .ant-calendar-date'));
    const alvo = cells.find(el => (el.textContent || '').trim() === dia);
    if (!alvo) return false;
    alvo.click(); setTimeout(() => alvo.click(), 250);
    return true;
  }, dia);
  if (ok) return 'fallback';
  throw new Error(`Dia ${dia} não encontrado no calendário`);
}

/* -------------------------- Core -------------------------- */
module.exports = async function handler(req, res) {
  const started = Date.now();
  let browser, context, page;

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

    // -------- abrir o datepicker --------
    await page.waitForFunction(() => {
      const q = (sel) => document.querySelector(sel);
      const has =
        q('.ant-picker') || q('.ant-calendar-picker') || q('.ant-picker-range') ||
        q('.ant-picker-input input') || q('[data-testid*="date"]') ||
        q('input[placeholder*="Data"]') || q('[class*="date"]') || q('[class*="calendar"]');
      return has && document.readyState === 'complete';
    }, null, { timeout: 15000 });
    await page.waitForTimeout(200);

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
          await page.waitForTimeout(500);
          continue;
        }
        throw err;
      }
    }
    if (!opened) return json(res, 200, { ok: false, error: 'Datepicker não encontrado' });

    // -------- se não há inputs, navega mês/ano e clica dia duas vezes --------
    let inputs = await page.$$('.ant-picker-dropdown .ant-picker-input input');
    if (inputs.length < 2) inputs = await page.$$('.ant-picker-panel .ant-picker-input input');
    if (inputs.length >= 2) {
      // há inputs: preenche normalmente
      const startInput = inputs[0];
      const endInput = inputs[1] || inputs[0];
      async function typeOrSet(el, value) {
        try { await el.click({ clickCount: 3 }); await page.keyboard.type(value); return 'typed'; }
        catch { await page.evaluate((e, v) => { e.value = v; e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new Event('change', { bubbles: true })); }, el, value); return 'setValue'; }
      }
      await typeOrSet(startInput, range.from);
      await page.waitForTimeout(120);
      await typeOrSet(endInput, range.to);
    } else {
      // sem inputs → usa clique na célula (navegando pro mês/ano)
      await ensureMonthYear(page, range.yyyy, range.mm);
      await clickDayTwice(page, range.dd);
    }

    // aplica: Enter ou botão OK
    let applied = false;
    try { await page.keyboard.press('Enter'); applied = true; } catch {}
    if (!applied) {
      const okBtn = await page.$('.ant-picker-dropdown .ant-picker-ok button, .ant-calendar-ok-btn');
      if (okBtn) { await okBtn.click().catch(() => {}); applied = true; }
    }

    // espera painel atualizar
    await page.waitForTimeout(1000);
    await page.waitForFunction(() => {
      const hasTable = document.querySelector('.ant-table, [class*="table"]');
      const hasStat = document.querySelector('.ant-statistic, [class*="statistic"]');
      return !!(hasTable || hasStat);
    }, null, { timeout: 8000 }).catch(() => {});

    // KPIs
    const kpis = await page.evaluate(() => {
      function pickText(el) { return (el && (el.textContent || '') || '').trim(); }
      const out = {};
      // estatísticas
      document.querySelectorAll('.ant-statistic').forEach((card) => {
        const label = pickText(card.querySelector('.ant-statistic-title')) || pickText(card.previousElementSibling);
        const valTxt = pickText(card.querySelector('.ant-statistic-content, .ant-statistic-content-value'));
        if (label && valTxt) out[label.toLowerCase()] = valTxt;
      });
      // cards
      document.querySelectorAll('.ant-card .ant-card-meta-title, .ant-card-head-title').forEach((el) => {
        const lbl = pickText(el);
        const valTxt = pickText(el.closest('.ant-card')?.querySelector('.ant-statistic-content, .ant-typography, .ant-card-meta-description'));
        if (lbl && valTxt) out[lbl.toLowerCase()] = valTxt;
      });
      // normaliza chaves
      const normalized = {};
      Object.entries(out).forEach(([k, v]) => {
        const key = k.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^\w\s]/g, '').replace(/\s+/g, ' ').trim();
        normalized[key] = v;
      });
      return normalized;
    });

    // Tabela (amostra)
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
