// api/upseller.js
const { chromium } = require('playwright-core');

/** Utilidades -------------------------------------------------------------- */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const json = (res, status, data) => {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(data, null, 2));
};
const getWs = () => {
  let ws = process.env.BROWSERLESS_WS || '';
  // aceita wss://production-xxx.browserless.io e wss://.../chromium
  if (ws && !/\/chromium($|\?)/.test(ws)) {
    // se já vier com query (?token=...), mantemos
    const [base, q] = ws.split('?');
    ws = `${base.replace(/\/+$/, '')}/chromium${q ? `?${q}` : ''}`;
  }
  return ws;
};

// pt-BR: "3.683,65" -> 3683.65
function brToNumber(txt) {
  if (txt == null) return 0;
  const s = String(txt).replace(/\./g, '').replace(',', '.').replace(/[^\d.-]/g, '');
  const n = Number(s);
  return Number.isFinite(n) ? n : 0;
}

/** Seleciona o range de datas (dois inputs) -------------------------------- */
async function setDateRange(page, fromBr, toBr) {
  // abre o datepicker (tenta seletores antigos e novos)
  const openerSelectors = [
    '.ant-picker',
    '.ant-calendar-picker',
    '.ant-picker-range'
  ];

  let opened = false;
  for (const sel of openerSelectors) {
    const el = await page.$(sel);
    if (el) {
      await el.click({ delay: 10 });
      opened = true;
      break;
    }
  }
  if (!opened) throw new Error('Datepicker não encontrado');

  // garante que os inputs renderizaram
  // novos: .ant-picker-input input
  // antigos: .ant-calendar-range-picker-input
  let inputs = await page.$$('.ant-picker-input input');
  if (!inputs || inputs.length < 2) {
    inputs = await page.$$('.ant-calendar-range-picker-input');
  }
  if (!inputs || inputs.length < 2) {
    throw new Error('Inputs do date-range não encontrados');
  }

  // preenche os dois inputs (Ctrl/Meta + A) e Enter para aplicar
  for (let i = 0; i < 2; i++) {
    await inputs[i].click({ clickCount: 3 });
    await page.keyboard.press('ControlOrMeta+A');
    await page.keyboard.type(i === 0 ? fromBr : toBr, { delay: 20 });
  }
  await page.keyboard.press('Enter');

  // aguarda a tabela recarregar / DOM estabilizar
  await page.waitForLoadState('domcontentloaded', { timeout: 20000 }).catch(() => {});
  // pequena folga para requests internas
  await sleep(1200);
}

/** Lê a tabela visível, mapeando cabeçalhos por texto ---------------------- */
async function parseSalesTable(page) {
  return await page.evaluate(() => {
    const norm = (s) =>
      (s || '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/\s+/g, ' ')
        .trim()
        .toLowerCase();

    const table = document.querySelector('.ant-table');
    if (!table) return { headers: [], rows: [] };

    const headers = Array.from(table.querySelectorAll('thead th')).map((th) =>
      (th.textContent || '').trim()
    );

    const headerIndex = {};
    headers.forEach((h, idx) => {
      const n = norm(h);
      if (n.includes('loja')) headerIndex.loja = idx;
      if (n.includes('pedidos válidos') || n.includes('pedidos validos')) headerIndex.pedidosValidos = idx;
      if (n.includes('valor de vendas válidas') || n.includes('valor de vendas validas')) headerIndex.valorVendasValidas = idx;
      if (headerIndex.loja == null && n === 'loja') headerIndex.loja = idx;
    });

    const rows = Array.from(table.querySelectorAll('tbody tr'))
      .map((tr) => Array.from(tr.querySelectorAll('td')).map((td) => (td.textContent || '').trim()))
      .filter((r) => r.length);

    return { headers, rows, headerIndex };
  });
}

/** Agrupa por prefixo (MELI / SPEE), soma e ordena ------------------------- */
function groupAndTop(data) {
  // mapeia linhas cruas em objetos fortes
  const mapped = data.rows.map((cols) => {
    const loja = cols[data.headerIndex.loja] || '';
    const pedidosValidosTxt = data.headerIndex.pedidosValidos != null ? cols[data.headerIndex.pedidosValidos] : '0';
    const valorVendasTxt   = data.headerIndex.valorVendasValidas != null ? cols[data.headerIndex.valorVendasValidas] : '0';

    return {
      loja,
      pedidosValidos: Number(String(pedidosValidosTxt).replace(/[^\d]/g, '')) || 0,
      valorVendasValidas: brToNumber(valorVendasTxt)
    };
  });

  // separa por prefixo
  const meli = mapped.filter((r) => /^MELI\b/i.test(r.loja));
  const spee = mapped.filter((r) => /^SPEE\b/i.test(r.loja));

  // ordena por valor desc
  const sortDesc = (a, b) => b.valorVendasValidas - a.valorVendasValidas;

  // pega top 7 de cada
  const topMeli = meli.sort(sortDesc).slice(0, 7);
  const topSpee = spee.sort(sortDesc).slice(0, 7);

  // só retorna colunas pedidas
  const pick = (r) => ({
    loja: r.loja,
    pedidosValidos: r.pedidosValidos,
    valorVendasValidas: r.valorVendasValidas
  });

  return {
    meli: topMeli.map(pick),
    spee: topSpee.map(pick)
  };
}

/** Handler principal -------------------------------------------------------- */
module.exports = async (req, res) => {
  const started = Date.now();

  // querystring: ?d=DD&m=MM&y=YYYY&mode=...
  const { d, m, y, mode } = Object.fromEntries(new URL(req.url, 'http://x').searchParams);
  const from = `${d || '01'}/${m || '01'}/${y || '2025'}`;
  const to   = `${d || '01'}/${m || '01'}/${y || '2025'}`;

  // diagnósticos rápidos
  if (mode === 'ping') {
    const ws = getWs();
    return json(res, 200, { ok: !!ws, ping: 'alive', hasWS: !!ws });
  }

  const wsEndpoint = getWs();
  if (!wsEndpoint) {
    return json(res, 500, { ok: false, error: 'BROWSERLESS_WS não configurado' });
  }

  const targetUrl = 'https://app.upseller.com/pt/analytics/store-sales';

  let browser;
  let context;
  let page;

  try {
    browser = await chromium.connectOverCDP(wsEndpoint);
    // CDP do Chromium geralmente cria 1 contexto persistente
    context = browser.contexts()[0] || (await browser.newContext?.());

    // injeta cookies (se houver) para já entrar logado
    const cookiesJson = process.env.UPS_COOKIES_JSON;
    if (cookiesJson) {
      try {
        const raw = JSON.parse(cookiesJson);
        const cookies = Array.isArray(raw)
          ? raw
          : Array.isArray(raw.cookies)
          ? raw.cookies
          : [];
        if (cookies.length) await context.addCookies(cookies);
      } catch {
        // se quebrar o JSON, apenas ignora para não interromper
      }
    }

    page = await context.newPage();

    // carrega a página
    await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });

    // diagnóstico de HTML bruto
    if (mode === 'html') {
      const html = await page.content();
      return json(res, 200, {
        ok: true,
        diag: {
          title: await page.title().catch(() => null),
          url: page.url(),
          len: html.length
        },
        html
      });
    }

    // garante título correto e DOM pronto
    await page.waitForFunction(
      () =>
        document.readyState === 'complete' ||
        (document.title || '').toLowerCase().includes('upseller'),
      { timeout: 20000 }
    ).catch(() => {});
    await sleep(500);

    // aplica período
    await setDateRange(page, from, to);

    // carrega tabela e mapeia colunas
    const table = await parseSalesTable(page);

    if (
      !table ||
      !table.rows ||
      !table.rows.length ||
      table.headerIndex.loja == null ||
      table.headerIndex.pedidosValidos == null ||
      table.headerIndex.valorVendasValidas == null
    ) {
      return json(res, 200, {
        ok: true,
        page: { title: await page.title().catch(() => null), url: page.url() },
        info: 'Tabela não encontrada ou cabeçalhos ausentes',
        diag: { headers: table?.headers || [], headerIndex: table?.headerIndex || {} },
        tookMs: Date.now() - started
      });
    }

    // agrupa e ordena
    const grupos = groupAndTop(table);

    return json(res, 200, {
      ok: true,
      period: { from, to },
      page: { title: await page.title().catch(() => null), url: page.url() },
      result: {
        meli: grupos.meli, // top 7 MELI
        spee: grupos.spee  // top 7 SPEE
      },
      diag: {
        headers: table.headers,
        headerIndex: table.headerIndex,
        totalRows: table.rows.length
      },
      tookMs: Date.now() - started
    });
  } catch (err) {
    return json(res, 200, {
      ok: false,
      error: String(err && err.message || err),
      tookMs: Date.now() - started
    });
  } finally {
    // fecha página/contexto (o Browserless encerra a sessão em seguida)
    try { if (page) await page.close(); } catch {}
    try { if (context && context !== browser.contexts?.[0]) await context.close(); } catch {}
    try { if (browser) await browser.close(); } catch {}
  }
};
