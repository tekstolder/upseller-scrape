// api/upseller.js
// Node 20 (CommonJS) — Vercel Serverless
const { chromium } = require('playwright-core');

/* ----------------------------- Utils ----------------------------- */
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function json(res, status, body) {
  res.status(status).setHeader('content-type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(body, null, 2));
}

const deaccent = (s) =>
  (s || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim();

function brDate(d, m, y) {
  return `${String(d).padStart(2, '0')}/${String(m).padStart(2, '0')}/${String(y).padStart(4, '0')}`;
}

function parseMoneyBR(txt) {
  // "R$ 1.234,56" -> 1234.56
  if (!txt) return 0;
  const only = String(txt).replace(/\s/g, '').replace(/[R$\u00A0]/g, '');
  const norm = only.replace(/\./g, '').replace(',', '.');
  const num = Number(norm);
  return Number.isFinite(num) ? num : 0;
}
function parseIntSafe(txt) {
  const n = Number(String(txt).replace(/[^\d-]/g, ''));
  return Number.isFinite(n) ? n : 0;
}

/* ----------------------- Browser / Cookies ----------------------- */
async function connect() {
  const ws = process.env.BROWSERLESS_WS;
  if (!ws) throw new Error('BROWSERLESS_WS não configurado');
  const browser = await chromium.connectOverCDP(ws, { timeout: 30000 });
  const ctx = browser.contexts()[0] || (await browser.newContext({}));
  return { browser, context: ctx };
}

async function applyCookies(context) {
  const raw = process.env.UPS_COOKIES_JSON;
  if (!raw) return;
  let arr;
  try {
    arr = JSON.parse(raw);
  } catch {
    throw new Error('UPS_COOKIES_JSON inválido (não é JSON de array).');
  }
  if (!Array.isArray(arr)) throw new Error('UPS_COOKIES_JSON deve ser um array JSON.');

  const cookies = arr
    .map((c) => ({
      name: c.name, value: c.value,
      domain: c.domain || 'app.upseller.com',
      path: c.path || '/',
      httpOnly: !!c.httpOnly,
      secure: typeof c.secure === 'boolean' ? c.secure : true,
      sameSite:
        /strict/i.test(c.sameSite) ? 'Strict' :
        /lax/i.test(c.sameSite) ? 'Lax' : 'None',
      expires: c.expirationDate ? Math.floor(Number(c.expirationDate)) : undefined,
    }))
    .filter((c) => c.name && c.value);
  if (cookies.length) await context.addCookies(cookies);
}

/* -------------------- Waits e Datepicker -------------------- */
async function waitForTableReady(page) {
  // espera a tabela existir
  await page.waitForSelector('.ant-table', { timeout: 20000 }).catch(() => {});
  // spinner sumir + linhas estáveis
  let last = null, stable = 0;
  for (let i = 0; i < 40; i++) {
    const state = await page.evaluate(() => {
      const spinning = !!document.querySelector('.ant-spin-spinning');
      const tbody = document.querySelector('.ant-table tbody');
      const rows = tbody ? tbody.querySelectorAll('tr').length : 0;
      return { spinning, rows };
    }).catch(() => ({ spinning: false, rows: 0 }));

    if (last && last.spinning === state.spinning && last.rows === state.rows) stable++;
    else stable = 0;

    last = state;
    if (!state.spinning && state.rows > 0 && stable >= 2) return true;
    await sleep(350);
  }
  return false;
}

async function openDatepicker(page) {
  // tenta abrir com vários seletores (novo/antigo AntD)
  const openers = [
    '.ant-picker-range',
    '.ant-picker',
    '.ant-calendar-picker',
    '[class*="picker"][class*="range"]',
  ];
  for (const sel of openers) {
    const el = await page.$(sel).catch(() => null);
    if (!el) continue;
    try {
      await page.locator(sel).first().click({ force: true, delay: 20 });
    } catch {
      await el.click({ delay: 20 }).catch(() => {});
    }
    // espera dropdown
    const dd = await page.waitForSelector('.ant-picker-dropdown, .ant-calendar-picker-container', { timeout: 2500 }).catch(() => null);
    if (dd) return true;
  }
  return false;
}

async function ensureMonthYear(page, yyyy, mm) {
  // navega pelos botões prev/next até chegar no mês/ano desejado (para calendário sem inputs)
  const alvo = { y: Number(yyyy), m: Number(mm) }; // 1..12
  const max = 24;

  function monthIdxPT(text) {
    const t = (text || '').toLowerCase();
    const L = ['janeiro','fevereiro','mar','março','abril','maio','junho','julho','agosto','setembro','outubro','novembro','dezembro'];
    for (let i = 0; i < L.length; i++) if (t.includes(L[i])) return i % 12;
    return -1;
  }

  for (let i = 0; i < max; i++) {
    const pos = await page.evaluate(() => {
      function readPanel(root) {
        const mBtn = root?.querySelector('.ant-picker-month-btn, .ant-calendar-month-select');
        const yBtn = root?.querySelector('.ant-picker-year-btn, .ant-calendar-year-select');
        return { mt: (mBtn?.textContent || '').trim(), yt: (yBtn?.textContent || '').trim() };
      }
      const host = document.querySelector('.ant-picker-dropdown, .ant-calendar-picker-container') || document;
      const panels = host.querySelectorAll('.ant-picker-panel');
      const L = panels[0] || host.querySelector('.ant-calendar-range-left');
      const R = panels[1] || host.querySelector('.ant-calendar-range-right');
      return { left: readPanel(L), right: readPanel(R) };
    });
    const now = [pos.left, pos.right].filter(Boolean).map(p => ({ y: parseInt(p.yt, 10), m: monthIdxPT(p.mt) + 1 })).find(x => x.y && x.m);
    if (now && now.y === alvo.y && now.m === alvo.m) return;

    const goPrev = await page.evaluate(({ alvoY, alvoM }) => {
      const host = document.querySelector('.ant-picker-dropdown, .ant-calendar-picker-container') || document;
      const panel = host.querySelector('.ant-picker-panel') || host;
      const mBtn = panel.querySelector('.ant-picker-month-btn, .ant-calendar-month-select');
      const yBtn = panel.querySelector('.ant-picker-year-btn, .ant-calendar-year-select');
      function monthIdxPT(text) {
        const t = (text || '').toLowerCase();
        const L = ['janeiro','fevereiro','mar','março','abril','maio','junho','julho','agosto','setembro','outubro','novembro','dezembro'];
        for (let i = 0; i < L.length; i++) if (t.includes(L[i])) return i % 12;
        return -1;
      }
      const mi = monthIdxPT(mBtn?.textContent || '');
      const yy = parseInt(yBtn?.textContent || '0', 10);
      if (!yy || mi < 0) return false;
      if (yy > alvoY) return true;
      if (yy < alvoY) return false;
      return (mi + 1) > alvoM;
    }, { alvoY: alvo.y, alvoM: alvo.m });

    const btnSel = goPrev ? '.ant-picker-header-prev-btn, .ant-calendar-prev-month-btn' : '.ant-picker-header-next-btn, .ant-calendar-next-month-btn';
    const btn = await page.$(btnSel);
    if (btn) await btn.click({ delay: 20 });
    await sleep(180);
  }
  throw new Error('Não foi possível posicionar mês/ano no calendário');
}

async function clickDayTwice(page, dd) {
  const day = String(parseInt(dd, 10));
  // novo Ant (ant-picker)
  const elNew = await page.$(`.ant-picker-cell-in-view .ant-picker-cell-inner:text-is("${day}")`).catch(() => null);
  if (elNew) {
    await elNew.click(); await sleep(160); await elNew.click(); return;
  }
  // antigo Ant (ant-calendar)
  const elOld = await page.$(`.ant-calendar-date:text-is("${day}")`).catch(() => null);
  if (elOld) {
    await elOld.click(); await sleep(160); await elOld.click(); return;
  }
  // fallback
  const ok = await page.evaluate((d) => {
    const cells = Array.from(document.querySelectorAll('.ant-picker-cell-inner, .ant-calendar-date'));
    const alvo = cells.find(el => (el.textContent || '').trim() === d);
    if (!alvo) return false;
    alvo.click(); setTimeout(() => alvo.click(), 150);
    return true;
  }, day);
  if (!ok) throw new Error(`Dia ${day} não encontrado no calendário`);
}

async function setDateRange(page, fromBr, toBr, dd, mm, yyyy) {
  // garante DOM pronto
  await page.waitForLoadState('domcontentloaded', { timeout: 30000 }).catch(() => {});
  await sleep(250);

  // abre datepicker
  const opened = await openDatepicker(page);
  if (!opened) throw new Error('Datepicker não encontrado');

  // tenta inputs na dropdown (novo/antigo)
  let inputs = await page.$$('.ant-picker-dropdown .ant-picker-input input').catch(() => []);
  if (inputs.length < 2) {
    inputs = await page.$$('.ant-calendar-picker-container .ant-calendar-range-picker-input').catch(() => []);
  }

  if (inputs.length >= 2) {
    // preenche os dois inputs
    for (let i = 0; i < 2; i++) {
      try { await inputs[i].click({ clickCount: 3, delay: 10 }); } catch {}
      await page.keyboard.press('ControlOrMeta+A').catch(() => {});
      await page.keyboard.type(i === 0 ? fromBr : toBr, { delay: 18 }).catch(() => {});
    }
  } else {
    // sem inputs: navega mês/ano e clica o dia 2x
    await ensureMonthYear(page, yyyy, mm);
    await clickDayTwice(page, dd);
  }

  // confirma (Enter ou botão OK)
  await page.keyboard.press('Enter').catch(() => {});
  const okBtn = await page.$('.ant-picker-dropdown .ant-picker-ok button, .ant-calendar-ok-btn').catch(() => null);
  if (okBtn) await okBtn.click().catch(() => {});

  // espera a rede/DOM e a tabela estabilizarem
  await Promise.race([
    page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {}),
    sleep(1200),
  ]);
  await waitForTableReady(page);
}

/* ------------------------ Tabela e Agrupamento ------------------------ */
async function parseSalesTable(page) {
  // pega headers e até 500 linhas
  const data = await page.evaluate(() => {
    const table = document.querySelector('.ant-table');
    if (!table) return null;
    const headers = Array.from(table.querySelectorAll('thead th')).map(th => (th.textContent || '').trim());
    const rows = Array.from(table.querySelectorAll('tbody tr')).slice(0, 500).map(tr =>
      Array.from(tr.querySelectorAll('td')).map(td => (td.textContent || '').trim())
    );
    return { headers, rows };
  });
  if (!data) return { headers: [], rows: [] };
  return data;
}

function locateColumns(headers) {
  const norm = headers.map(h => deaccent(h).toLowerCase());
  const idx = { loja: -1, pedidosValidos: -1, valorVendasValidas: -1 };
  for (let i = 0; i < norm.length; i++) {
    const h = norm[i];
    if (idx.loja < 0 && /^loja\b/.test(h)) idx.loja = i;
    if (idx.pedidosValidos < 0 && (h.includes('pedidos valid'))) idx.pedidosValidos = i;
    if (idx.valorVendasValidas < 0 && (h.includes('valor de vendas valid'))) idx.valorVendasValidas = i;
  }
  return idx;
}

function groupAndTop(rows, idx) {
  const items = rows.map((r) => {
    const loja = r[idx.loja] || '';
    const pv = parseIntSafe(r[idx.pedidosValidos]);
    const vv = parseMoneyBR(r[idx.valorVendasValidas]);
    return { loja, pedidosValidos: pv, valorVendasValidas: vv };
  }).filter(r => r.loja);

  const DESC = (a,b) => b.valorVendasValidas - a.valorVendasValidas;

  const meli = items.filter(r => r.loja.trim().toUpperCase().startsWith('MELI')).sort(DESC).slice(0,7);
  const spee = items.filter(r => r.loja.trim().toUpperCase().startsWith('SPEE')).sort(DESC).slice(0,7);

  return { meli, spee, allCount: items.length };
}

/* ------------------------------- Handler ------------------------------- */
module.exports = async (req, res) => {
  const t0 = Date.now();
  const q = req.query || {};
  const d = q.d || '01';
  const m = q.m || '01';
  const y = q.y || '2025';
  const mode = (q.mode || '').toString().toLowerCase();

  const target = 'https://app.upseller.com/pt/analytics/store-sales';

  // Diagnóstico: ping
  if (mode === 'ping') {
    try {
      const { browser } = await connect();
      await browser.close().catch(() => {});
      return json(res, 200, { ok: true, ping: 'alive', hasWS: true });
    } catch (err) {
      return json(res, 200, { ok: false, ping: 'fail', error: String(err && err.message || err) });
    }
  }

  // Diagnóstico: html
  if (mode === 'html') {
    let browser;
    try {
      const conn = await connect();
      browser = conn.browser;
      await applyCookies(conn.context);
      const page = await conn.context.newPage();
      await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 45000 });
      await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
      const html = await page.evaluate(() => document.documentElement.outerHTML);
      const diag = { title: await page.title().catch(() => null), url: page.url(), len: (html || '').length };
      await browser.close().catch(() => {});
      return json(res, 200, { ok: true, diag, html });
    } catch (err) {
      try { await browser?.close(); } catch {}
      return json(res, 200, { ok: false, error: String(err && err.message || err) });
    }
  }

  // Fluxo normal
  const from = brDate(d, m, y);
  const to   = from;

  let browser, context, page;
  try {
    ({ browser, context } = await connect());
    await applyCookies(context);

    page = await context.newPage();
    page.setDefaultTimeout(25000);

    await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await Promise.race([
      page.waitForFunction(() => /upseller/i.test(document.title) || document.readyState === 'complete', { timeout: 12000 }),
      sleep(1200)
    ]).catch(() => {});
    await sleep(200);

    // Seleciona o período (com inputs ou por calendário)
    await setDateRange(page, from, to, d, m, y);

    // Lê tabela
    const table = await parseSalesTable(page);
    const idx = locateColumns(table.headers || []);
    if (idx.loja < 0 || idx.pedidosValidos < 0 || idx.valorVendasValidas < 0) {
      return json(res, 200, {
        ok: false,
        error: 'Não consegui localizar colunas (Loja / Pedidos Válidos / Valor de Vendas Válidas).',
        diag: { headers: table.headers || [] },
        tookMs: Date.now() - t0
      });
    }

    const grouped = groupAndTop(table.rows || [], idx);

    return json(res, 200, {
      ok: true,
      period: { from, to },
      page: { title: await page.title().catch(() => null), url: page.url() },
      grupos: {
        Meli: grouped.meli.map(r => ({
          Loja: r.loja,
          'Pedidos Válidos': r.pedidosValidos,
          'Valor de Vendas Válidas': r.valorVendasValidas
        })),
        SPEE: grouped.spee.map(r => ({
          Loja: r.loja,
          'Pedidos Válidos': r.pedidosValidos,
          'Valor de Vendas Válidas': r.valorVendasValidas
        }))
      },
      totais: {
        Meli: grouped.meli.reduce((s, r) => s + r.valorVendasValidas, 0),
        SPEE: grouped.spee.reduce((s, r) => s + r.valorVendasValidas, 0)
      },
      tookMs: Date.now() - t0
    });

  } catch (err) {
    return json(res, 200, { ok: false, error: String(err && err.message || err), tookMs: Date.now() - t0 });

  } finally {
    try { await page?.close(); } catch {}
    try { await context?.close(); } catch {}
    try { await browser?.close(); } catch {}
  }
};
