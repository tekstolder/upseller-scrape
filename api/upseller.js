// api/upseller.js
// Node.js (CommonJS) – Vercel serverless
const { chromium } = require('playwright-core');

// ----------------- helpers -----------------
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function json(res, status, body) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.status(status).send(JSON.stringify(body, null, 2));
}

const deaccent = (s) =>
  (s || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim();

function brDate(d, m, y) {
  // d, m, y strings ("01","01","2025")
  return `${String(d).padStart(2, '0')}/${String(m).padStart(2, '0')}/${String(y).padStart(4, '0')}`;
}

function parseMoneyBR(txt) {
  // "1.234,56" -> 1234.56
  if (!txt) return 0;
  const only = String(txt).replace(/\s/g, '').replace(/[R$\u00A0]/g, '');
  const norm = only.replace(/\./g, '').replace(/,/g, '.');
  const num = Number(norm);
  return Number.isFinite(num) ? num : 0;
}

function parseIntSafe(txt) {
  const n = Number(String(txt).replace(/[^\d\-]/g, ''));
  return Number.isFinite(n) ? n : 0;
}

// -------------- playwright connect --------------
async function connect() {
  const ws = process.env.BROWSERLESS_WS;
  if (!ws) throw new Error('BROWSERLESS_WS não configurado');
  const browser = await chromium.connectOverCDP(ws, { timeout: 30000 });
  const [context] = browser.contexts().length
    ? browser.contexts()
    : [await browser.newContext({ userAgent: undefined })];
  return { browser, context };
}

// -------------- cookies -----------------
async function applyCookies(context) {
  const raw = process.env.UPS_COOKIES_JSON;
  if (!raw) return;

  let cookies = [];
  try {
    cookies = JSON.parse(raw);
  } catch {
    // pode estar em string (Share Cookie) -> tenta converter
    if (raw.trim().startsWith('[')) throw new Error('UPS_COOKIES_JSON inválido (JSON malformado).');
  }
  // transforma no formato playwright
  const pwCookies = cookies
    .map((c) => {
      const isApp = (c.domain || '').includes('upseller.com');
      const domain = c.domain || (isApp ? 'app.upseller.com' : undefined);
      return {
        name: c.name,
        value: c.value,
        domain,
        path: c.path || '/',
        httpOnly: !!c.httpOnly,
        secure: typeof c.secure === 'boolean' ? c.secure : true,
        sameSite: c.sameSite === 'lax' || c.sameSite === 'Lax' ? 'Lax'
          : c.sameSite === 'strict' || c.sameSite === 'Strict' ? 'Strict'
          : 'None',
        expires: c.expirationDate ? Math.floor(Number(c.expirationDate)) : undefined
      };
    })
    .filter((c) => !!c.name && !!c.value);

  if (pwCookies.length) {
    await context.addCookies(pwCookies);
  }
}

// ---------------- waits robustos ----------------
async function waitForTableReady(page) {
  // espera a tabela aparecer
  await page.waitForSelector('.ant-table', { timeout: 20000 }).catch(() => {});
  // espera spinner sumir e linhas estabilizarem
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

async function setDateRange(page, fromBr, toBr) {
  // garante que temos DOM
  await page.waitForLoadState('domcontentloaded', { timeout: 30000 }).catch(() => {});
  await sleep(300);

  // tenta abrir o datepicker
  const openerSelectors = ['.ant-picker', '.ant-calendar-picker', '.ant-picker-range'];
  let opened = false;
  for (const sel of openerSelectors) {
    const handle = await page.$(sel).catch(() => null);
    if (handle) {
      await handle.click({ delay: 20 }).catch(() => {});
      opened = true;
      break;
    }
  }
  if (!opened) throw new Error('Datepicker não encontrado');

  // encontra inputs do range
  let inputs = await page.$$('.ant-picker-input input').catch(() => []);
  if (!inputs || inputs.length < 2) {
    inputs = await page.$$('.ant-calendar-range-picker-input').catch(() => []);
  }
  if (!inputs || inputs.length < 2) {
    throw new Error('Inputs do date-range não encontrados');
  }

  // preenche os 2 campos
  for (let i = 0; i < 2; i++) {
    await inputs[i].click({ clickCount: 3 }).catch(() => {});
    await page.keyboard.press('ControlOrMeta+A').catch(() => {});
    await page.keyboard.type(i === 0 ? fromBr : toBr, { delay: 18 }).catch(() => {});
  }
  await page.keyboard.press('Enter').catch(() => {});

  // espera rede/DOM assentarem
  await Promise.race([
    page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {}),
    sleep(1500)
  ]);
  // e depois esperamos a tabela estabilizar
  await waitForTableReady(page);
}

// ---------------- tabela + agrupamento ----------------
async function parseSalesTable(page) {
  // captura cabeçalhos e até 500 linhas (performance boa e sobra)
  const data = await page.evaluate(() => {
    function txt(el) { return (el && (el.textContent || '') || '').trim(); }
    const table = document.querySelector('.ant-table');
    if (!table) return null;

    const headers = Array.from(table.querySelectorAll('thead th')).map(th =>
      (th.textContent || '').trim()
    );

    const rows = Array.from(table.querySelectorAll('tbody tr')).slice(0, 500).map(tr =>
      Array.from(tr.querySelectorAll('td')).map(td => (td.textContent || '').trim())
    );

    return { headers, rows };
  });

  if (!data || !data.headers || !data.rows) {
    return { headers: [], rows: [] };
  }
  return data;
}

function locateColumns(headers) {
  // normaliza e localiza por aproximação
  const norm = headers.map(h => deaccent(h).toLowerCase());
  const idx = {
    loja: -1,
    pedidosValidos: -1,
    valorVendasValidas: -1
  };

  for (let i = 0; i < norm.length; i++) {
    const h = norm[i];
    if (idx.loja < 0 && /^(loja|store)/.test(h)) idx.loja = i;
    if (idx.pedidosValidos < 0 && (h.includes('pedidos valid') || h.includes('pedidosvalid'))) idx.pedidosValidos = i;
    if (idx.valorVendasValidas < 0 && (h.includes('valor de vendas valid') || h.includes('valor devendas valid'))) idx.valorVendasValidas = i;
  }
  return idx;
}

function groupAndTop(rows, idx) {
  const items = [];
  for (const r of rows) {
    const loja = r[idx.loja] || '';
    const prefix = (loja || '').trim().toUpperCase();
    const pv = parseIntSafe(r[idx.pedidosValidos]);
    const vv = parseMoneyBR(r[idx.valorVendasValidas]);
    if (!loja) continue;

    items.push({ loja, pedidosValidos: pv, valorVendasValidas: vv });
  }

  const meli = items
    .filter(it => it.loja.trim().toUpperCase().startsWith('MELI'))
    .sort((a, b) => b.valorVendasValidas - a.valorVendasValidas)
    .slice(0, 7);

  const spee = items
    .filter(it => it.loja.trim().toUpperCase().startsWith('SPEE'))
    .sort((a, b) => b.valorVendasValidas - a.valorVendasValidas)
    .slice(0, 7);

  return { meli, spee, totalRows: items.length };
}

// ---------------- handler ----------------
module.exports = async (req, res) => {
  const t0 = Date.now();
  const { d, m, y, mode } = req.query || {};
  const target = 'https://app.upseller.com/pt/analytics/store-sales';

  // modos de diagnóstico
  if (mode === 'ping') {
    try {
      const { browser, context } = await connect();
      await browser.close().catch(() => {});
      return json(res, 200, { ok: true, ping: 'alive', hasWS: true });
    } catch (err) {
      return json(res, 200, { ok: false, ping: 'fail', error: String(err && err.message || err) });
    }
  }

  if (mode === 'html') {
    try {
      const { browser, context } = await connect();
      await applyCookies(context);
      const page = await context.newPage();
      await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 45000 });
      await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
      const html = await page.evaluate(() => document.documentElement.outerHTML);
      const diag = {
        title: await page.title().catch(() => null),
        url: page.url(),
        len: (html || '').length
      };
      await browser.close().catch(() => {});
      return json(res, 200, { ok: true, diag, html });
    } catch (err) {
      return json(res, 200, { ok: false, error: String(err && err.message || err) });
    }
  }

  // fluxo normal
  const from = brDate(d || '01', m || '01', y || '2025');
  const to = from; // conforme seu pedido: mesma data nos dois campos

  let browser, context, page;
  try {
    ({ browser, context } = await connect());
    await applyCookies(context);

    page = await context.newPage();
    page.setDefaultTimeout(20000);

    await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 45000 });
    // aguarda título ou DOM “quieto”
    await Promise.race([
      page.waitForFunction(() => /UpSeller/i.test(document.title) || document.readyState === 'complete', { timeout: 8000 }),
      sleep(1200)
    ]).catch(() => {});

    // aplica período e espera a tabela
    await setDateRange(page, from, to);

    // coleta tabela
    const table = await parseSalesTable(page);
    const idx = locateColumns(table.headers || []);
    if (idx.loja < 0 || idx.pedidosValidos < 0 || idx.valorVendasValidas < 0) {
      throw new Error('Não consegui localizar colunas (Loja / Pedidos Válidos / Valor de Vendas Válidas).');
    }
    const grouped = groupAndTop(table.rows || [], idx);

    const out = {
      ok: true,
      period: { from, to },
      page: { title: await page.title().catch(() => null), url: page.url() },
      groups: {
        meli: grouped.meli,
        spee: grouped.spee
      },
      totals: {
        meli: {
          pedidosValidos: grouped.meli.reduce((s, r) => s + r.pedidosValidos, 0),
          valorVendasValidas: grouped.meli.reduce((s, r) => s + r.valorVendasValidas, 0)
        },
        spee: {
          pedidosValidos: grouped.spee.reduce((s, r) => s + r.pedidosValidos, 0),
          valorVendasValidas: grouped.spee.reduce((s, r) => s + r.valorVendasValidas, 0)
        }
      },
      tableSample: {
        headers: table.headers,
        sampleRows: (table.rows || []).slice(0, 5)
      },
      tookMs: Date.now() - t0
    };

    await browser.close().catch(() => {});
    return json(res, 200, out);
  } catch (err) {
    const took = Date.now() - t0;
    // fecha browser se abriu
    if (browser) await browser.close().catch(() => {});
    return json(res, 200, { ok: false, error: String(err && err.message || err), tookMs: took });
  }
};
