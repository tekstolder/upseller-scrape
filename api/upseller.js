// api/upseller.js
// Node.js 20.x on Vercel — CommonJS (sem "type": "module")
const { chromium } = require('playwright-core');

/* ==================== utils ==================== */
function json(res, status, body) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(body));
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function brToNumber(txt) {
  // "3.683,65" -> 3683.65
  if (typeof txt !== 'string') return 0;
  const clean = txt.replace(/\./g, '').replace(',', '.').replace(/[^\d.-]/g, '');
  const n = parseFloat(clean);
  return isNaN(n) ? 0 : n;
}

function norm(s) {
  return (s || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().trim();
}

/* ==================== scraping helpers ==================== */
async function connectBrowserless() {
  const ws = process.env.BROWSERLESS_WS;
  if (!ws) throw new Error('BROWSERLESS_WS não configurado');
  // Browserless CDP
  const browser = await chromium.connectOverCDP(ws);
  return browser;
}

async function applyCookies(context) {
  const raw = process.env.UPS_COOKIES_JSON || '[]';
  let cookies = [];
  try { cookies = JSON.parse(raw); } catch (e) { /* ignore */ }
  if (!Array.isArray(cookies)) cookies = [];
  if (cookies.length) {
    // Playwright aceita domain/path; url é opcional
    await context.addCookies(cookies.map(c => ({
      name: c.name,
      value: c.value,
      domain: c.domain,
      path: c.path || '/',
      httpOnly: !!c.httpOnly,
      secure: !!c.secure,
      sameSite: (c.sameSite || 'Lax').toLowerCase() === 'lax' ? 'Lax'
        : (c.sameSite || 'None') === 'None' ? 'None' : 'Strict',
      expires: c.expirationDate ? Math.floor(c.expirationDate) : undefined
    })));
  }
}

async function setDateRange(page, fromBr, toBr) {
  // garante que algo já carregou antes de clicar
  await page.waitForLoadState('domcontentloaded', { timeout: 30000 }).catch(() => {});
  await sleep(300);

  // tenta abrir o datepicker (novos e antigos seletores)
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

  // espera os inputs do range aparecerem
  let inputs = await page.$$('.ant-picker-input input').catch(() => []);
  if (!inputs || inputs.length < 2) {
    inputs = await page.$$('.ant-calendar-range-picker-input').catch(() => []);
  }
  if (!inputs || inputs.length < 2) {
    throw new Error('Inputs do date-range não encontrados');
  }

  // preenche os 2 campos e aplica
  for (let i = 0; i < 2; i++) {
    await inputs[i].click({ clickCount: 3 }).catch(() => {});
    await page.keyboard.press('ControlOrMeta+A').catch(() => {});
    await page.keyboard.type(i === 0 ? fromBr : toBr, { delay: 20 }).catch(() => {});
  }
  await page.keyboard.press('Enter').catch(() => {});

  // deixa a navegação/requests acontecerem
  await Promise.race([
    page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {}),
    sleep(1500)
  ]);
}

async function waitForTableReady(page) {
  // espera a tabela surgir
  await page.waitForSelector('.ant-table', { timeout: 20000 }).catch(() => {});
  // aguarda o spinner sumir e a contagem de linhas ficar estável
  let last = null, stableCount = 0;
  for (let i = 0; i < 40; i++) {
    const state = await page.evaluate(() => {
      const spinning = !!document.querySelector('.ant-spin-spinning');
      const tbody = document.querySelector('.ant-table tbody');
      const rows = tbody ? tbody.querySelectorAll('tr').length : 0;
      return { spinning, rows };
    }).catch(() => ({ spinning: false, rows: 0 }));

    if (last && last.rows === state.rows && last.spinning === state.spinning) {
      stableCount++;
    } else {
      stableCount = 0;
    }
    last = state;

    if (!state.spinning && state.rows > 0 && stableCount >= 2) return true;
    await sleep(350);
  }
  return false; // segue mesmo assim
}

async function parseSalesTable(page) {
  // coleta headers e linhas (texto puro)
  const data = await page.evaluate(() => {
    const table = document.querySelector('.ant-table');
    if (!table) return { headers: [], rows: [] };
    const headers = Array.from(table.querySelectorAll('thead th')).map(th => (th.textContent || '').trim());
    const rows = Array.from(table.querySelectorAll('tbody tr')).map(tr =>
      Array.from(tr.querySelectorAll('td')).map(td => (td.textContent || '').trim())
    );
    return { headers, rows };
  });

  // mapeia colunas por nome aproximado
  const headerNorm = data.headers.map(h => (h || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/\s+/g, ' ').trim());

  const colLoja = headerNorm.findIndex(h => /^(loja|store)/.test(h));
  // variações de "Pedidos Válidos"
  const colPedidosValidos = headerNorm.findIndex(h => h.includes('pedidos valid'));
  // variações de "Valor de Vendas Válidas"
  let colValorValidas = headerNorm.findIndex(h =>
    h.includes('valor de vendas valid') || h.includes('vendas validas') || h.includes('valor valido') || h.includes('vendas valid'));
  if (colValorValidas < 0) {
    // fallback: usar "Valor Total de Vendas" se a coluna "válidas" não estiver visível nessa view
    colValorValidas = headerNorm.findIndex(h => h.includes('valor total de vendas') || h.includes('valor de vendas'));
  }

  if (colLoja < 0 || colPedidosValidos < 0 || colValorValidas < 0) {
    return { headers: data.headers, rows: data.rows, parsed: [] };
  }

  const parsed = data.rows.map(r => ({
    loja: r[colLoja] || '',
    pedidosValidos: brToNumber(r[colPedidosValidos]),
    valorVendasValidas: brToNumber(r[colValorValidas]),
  })).filter(x => x.loja);

  return { headers: data.headers, rows: data.rows, parsed };
}

function groupTop(parsed) {
  const isMeli = (name) => /^meli\b/i.test(name.trim());
  const isSpee = (name) => /^spee\b/i.test(name.trim());

  const meli = parsed.filter(x => isMeli(x.loja))
    .sort((a, b) => b.valorVendasValidas - a.valorVendasValidas)
    .slice(0, 7);

  const spee = parsed.filter(x => isSpee(x.loja))
    .sort((a, b) => b.valorVendasValidas - a.valorVendasValidas)
    .slice(0, 7);

  return { meli, spee };
}

/* ==================== handler ==================== */
module.exports = async (req, res) => {
  const started = Date.now();
  const url = new URL(req.url, `http://${req.headers.host}`);
  const q = Object.fromEntries(url.searchParams.entries());
  const mode = (q.mode || '').toLowerCase();

  const d = q.d || '01';
  const m = q.m || '01';
  const y = q.y || '2025';
  const from = `${d}/${m}/${y}`;
  const to = `${d}/${m}/${y}`;

  const target = 'https://app.upseller.com/pt/analytics/store-sales';

  /* ---------- diagnósticos rápidos ---------- */
  if (mode === 'ping') {
    try {
      const browser = await connectBrowserless();
      await browser.close();
      return json(res, 200, { ok: true, ping: 'alive', hasWS: true });
    } catch (e) {
      return json(res, 200, { ok: false, error: String(e && e.message || e) });
    }
  }

  if (mode === 'html') {
    let browser;
    try {
      browser = await connectBrowserless();
      const context = browser.contexts()[0] || await browser.newContext();
      await applyCookies(context);
      const page = await context.newPage();
      await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 60000 });
      // dá um tempinho para o título estabilizar
      await Promise.race([page.waitForLoadState('networkidle', { timeout: 10000 }).catch(()=>{}), sleep(1000)]);
      const html = await page.content();
      const title = await page.title().catch(() => null);
      const urlNow = page.url();
      return json(res, 200, { ok: true, diag: { title, url: urlNow, len: (html || '').length }, html });
    } catch (e) {
      return json(res, 200, { ok: false, error: String(e && e.message || e) });
    } finally {
      try { if (browser) await browser.close(); } catch {}
    }
  }

  /* ---------- fluxo normal ---------- */
  let browser;
  try {
    browser = await connectBrowserless();
    const context = browser.contexts()[0] || await browser.newContext();
    await applyCookies(context);

    const page = await context.newPage();
    page.setDefaultTimeout(20000);

    await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await Promise.race([
      page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {}),
      sleep(1500)
    ]);

    // aplica período
    await setDateRange(page, from, to);
    // aguarda tabela estabilizar
    await waitForTableReady(page);

    // lê tabela
    const table = await parseSalesTable(page);
    const grouped = groupTop(table.parsed || []);

    const tookMs = Date.now() - started;
    return json(res, 200, {
      ok: true,
      period: { from, to },
      page: { title: await page.title().catch(() => null), url: page.url() },
      columns: ['Loja', 'Pedidos Válidos', 'Valor de Vendas Válidas'],
      // devolve amostra completa (se quiser conferir no log)
      tableSample: {
        headers: table.headers,
        first5: (table.parsed || []).slice(0, 5)
      },
      result: {
        MELI: grouped.meli,
        SPEE: grouped.spee
      },
      tookMs
    });
  } catch (err) {
    const tookMs = Date.now() - started;
    return json(res, 200, { ok: false, error: String(err && err.message || err), tookMs });
  } finally {
    try { if (browser) await browser.close(); } catch {}
  }
};
