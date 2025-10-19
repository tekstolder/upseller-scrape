// api/upseller.js — Vercel (Node 20, ESM)
// Requer as envs: BROWSERLESS_WS (wss://production-sfo.browserless.io/chromium?token=...)
//                UPS_COOKIES_JSON (JSON array dos cookies, incluindo JSESSIONID e us_u)

import puppeteer from 'puppeteer-core';

const TARGET = 'https://app.upseller.com/pt/analytics/store-sales';

function toDDMMYYYY({ d, m, y }) {
  const dd = String(d).padStart(2, '0');
  const mm = String(m).padStart(2, '0');
  const yyyy = String(y);
  return `${dd}/${mm}/${yyyy}`;
}

function parseQuery(req) {
  const u = new URL(req.url || `http://x.local${req.query ? '?' + new URLSearchParams(req.query) : ''}`);
  const d = Number(u.searchParams.get('d'));
  const m = Number(u.searchParams.get('m'));
  const y = Number(u.searchParams.get('y'));
  if (!d || !m || !y) throw new Error('Parâmetros inválidos: use ?d=DD&m=MM&y=YYYY');
  return { d, m, y };
}

async function waitVisible(page, selectors, timeout = 8000) {
  const tried = [];
  for (const sel of selectors) {
    try {
      const el = await page.waitForSelector(sel, { visible: true, timeout });
      if (el) return { el, sel };
    } catch (e) {
      tried.push(sel);
    }
  }
  const err = new Error('Nenhum seletor ficou visível');
  err.meta = { tried };
  throw err;
}

async function setInputValue(page, selector, value) {
  // Tenta via teclado primeiro
  try {
    const handle = await page.$(selector);
    if (!handle) throw new Error(`Input não encontrado: ${selector}`);
    await handle.click({ clickCount: 3 });
    await page.keyboard.type(value);
    return 'typed';
  } catch {
    // Fallback: set value + dispatch events
    await page.evaluate(
      (sel, val) => {
        const input = document.querySelector(sel);
        if (!input) return 'no-input';
        input.value = val;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
        return 'setValue';
      },
      selector,
      value
    );
    return 'setValue';
  }
}

export default async function handler(req, res) {
  const t0 = Date.now();
  let browser;
  let context;
  let page;
  const diag = {
    steps: [],
    openerMatched: null,
    fillStrategy: null,
    urlAfter: null,
    title: null,
  };

  try {
    // 1) Params
    const { d, m, y } = parseQuery(req);
    const start = toDDMMYYYY({ d, m, y });
    const end = start; // filtro de 1 dia

    // 2) Conecta no Browserless
    const WS = process.env.BROWSERLESS_WS;
    if (!WS) throw new Error('BROWSERLESS_WS ausente.');
    browser = await puppeteer.connect({ browserWSEndpoint: WS });

    context = await browser.createIncognitoBrowserContext();

    // 3) Injeta cookies
    const raw = process.env.UPS_COOKIES_JSON;
    if (!raw) throw new Error('UPS_COOKIES_JSON ausente.');
    let cookies = JSON.parse(raw);
    if (!Array.isArray(cookies)) cookies = [];
    // Normaliza campos essenciais
    cookies = cookies.map((c) => ({
      ...c,
      domain: c.domain || 'app.upseller.com',
      path: c.path || '/',
      secure: true,
      sameSite: c.sameSite === 'unspecified' ? 'Lax' : c.sameSite || 'Lax',
    }));

    page = await context.newPage();
    await page.setDefaultTimeout(20000);
    await context.addCookies(cookies);

    // 4) Abre a página e espera estabilizar
    await page.goto(TARGET, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForLoadState?.('load').catch(() => {});
    await page.waitForFunction(
      () => document.readyState === 'complete' || document.title.toLowerCase().includes('upseller'),
      { timeout: 8000 }
    );
    await page.waitForTimeout(800); // pequeno buffer

    diag.title = await page.title();
    diag.urlAfter = page.url();
    diag.steps.push('Página carregada');

    // 5) Localiza abertura do date-range
    const openers = [
      '.ant-picker',                            // Ant v4/v5 padrão
      '.ant-calendar-picker',                   // legacy
      '[class*="ant-picker"]:not([aria-hidden="true"])',
      '[data-testid*="date"]',
      'input[placeholder*="Data"]',
      'input[placeholder*="Período"]',
      'button:has(svg)',
    ];
    const { el: opener, sel: openerSel } = await waitVisible(page, openers, 8000);
    diag.openerMatched = openerSel;

    // Alguns layouts têm o input dentro do wrapper. Clique “inteligente”
    await page.evaluate((node) => {
      const r = node.getBoundingClientRect();
      const x = r.left + r.width - 10;
      const y = r.top + r.height / 2;
      window.scrollTo({ top: r.top - 100 });
      const e = document.elementFromPoint(x, y);
      e?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    }, opener);
    await page.waitForTimeout(150);

    // Confirma se o painel abriu
    const dropdownSelectors = ['.ant-picker-dropdown', '.ant-picker-panel', '.ant-calendar-picker-container'];
    await waitVisible(page, dropdownSelectors, 4000).catch(async () => {
      // caso não abra com o click “inteligente”, clica direto no opener
      await page.click(openerSel, { delay: 30 }).catch(() => {});
      await waitVisible(page, dropdownSelectors, 4000);
    });
    diag.steps.push('Datepicker aberto');

    // 6) Preenche os 2 inputs do range
    // Na maioria dos Ant pickers os inputs ficam assim:
    // .ant-picker-input input (primeiro = início; segundo = fim)
    const startInputSel = '.ant-picker-dropdown .ant-picker-input input, .ant-picker-panel .ant-picker-input input';
    const endInputSel =
      '.ant-picker-dropdown .ant-picker-input input:nth-of-type(2), .ant-picker-panel .ant-picker-input input:nth-of-type(2)';

    // Fallback final: se não encontrar “nth-of-type(2)”, procura o segundo manualmente
    const inputsCount = await page.$$eval(startInputSel, (els) => els.length).catch(() => 0);
    if (!inputsCount) throw new Error('Inputs do date-range não encontrados');

    // Preenche início
    const stratA = await setInputValue(page, startInputSel, start);

    // Preenche fim (se só tiver 1 input — alguns layouts usam um só — repete no mesmo)
    let endSelectorToUse = endInputSel;
    const endExists = await page.$(endInputSel);
    if (!endExists) endSelectorToUse = startInputSel;
    const stratB = await setInputValue(page, endSelectorToUse, end);

    diag.fillStrategy = { start: stratA, end: stratB };

    // Pressiona Enter para fechar e aplicar
    await page.keyboard.press('Enter').catch(() => {});
    await page.waitForTimeout(500);

    // 7) Aguarda efeito do filtro (alguma mudança na tela)
    await page.waitForFunction(
      () => !!document.querySelector('.ant-table') || !!document.querySelector('[class*="chart"]'),
      { timeout: 8000 }
    ).catch(() => {}); // alguns dashboards podem não ter tabela/chart explícitos

    diag.title = await page.title();
    diag.urlAfter = page.url();
    diag.steps.push('Filtro aplicado');

    // 8) (Opcional) Leia um KPI simples como prova de vida
    const kpiText =
      (await page.$eval('.ant-statistic-content, .ant-card-meta-title, .kpi, [data-testid*="kpi"]', (el) => el.textContent.trim()).catch(() => null)) ||
      null;

    const tookMs = Date.now() - t0;
    res.status(200).json({
      ok: true,
      tookMs,
      diag,
      sample: { kpiText },
    });
  } catch (err) {
    const tookMs = Date.now() - t0;
    res.status(200).json({
      ok: false,
      error: String(err && err.message ? err.message : err),
      tookMs,
      diag,
    });
  } finally {
    try { if (page) await page.close(); } catch {}
    try { if (context) await context.close(); } catch {}
    try { if (browser) await browser.disconnect(); } catch {}
  }
}
