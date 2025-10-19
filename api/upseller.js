'use strict';

const { chromium } = require('playwright-core');

/**
 * Helper: devolve JSON padronizado
 */
function json(res, code, obj) {
  res.status(code).setHeader('content-type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(obj));
}

/**
 * Helper: parse de datas (DD/MM/YYYY) a partir de d,m,y
 */
function buildDateStrings({ d, m, y }) {
  const dd = String(d || '').padStart(2, '0');
  const mm = String(m || '').padStart(2, '0');
  const yyyy = String(y || '');
  if (dd.length !== 2 || mm.length !== 2 || yyyy.length !== 4) {
    throw new Error('Parâmetros de data inválidos. Use ?d=DD&m=MM&y=YYYY');
  }
  const from = `${dd}/${mm}/${yyyy}`;
  const to = `${dd}/${mm}/${yyyy}`;
  return { from, to };
}

/**
 * Lê e valida envs
 */
function readEnvs() {
  const WS = process.env.BROWSERLESS_WS || '';
  const RAW = process.env.UPS_COOKIES_JSON || '';
  if (!WS) throw new Error('BROWSERLESS_WS ausente');
  if (!RAW) throw new Error('UPS_COOKIES_JSON ausente');

  // Remover aspas involuntárias
  const trimmed = RAW.trim().replace(/^"+|"+$/g, '');
  let cookies;
  try {
    cookies = JSON.parse(trimmed);
  } catch (e) {
    throw new Error('UPS_COOKIES_JSON não é um JSON válido de array');
  }
  if (!Array.isArray(cookies)) {
    throw new Error('UPS_COOKIES_JSON deve ser um array JSON de cookies');
  }

  return { WS, cookies };
}

/**
 * Ajusta cookies para domínio app.upseller.com se faltar domain/path
 */
function normalizeCookies(cookies) {
  return cookies.map((c) => ({
    domain: c.domain || 'app.upseller.com',
    path: c.path || '/',
    httpOnly: !!c.httpOnly,
    secure: c.secure !== false, // default true
    sameSite: c.sameSite && typeof c.sameSite === 'string' ? c.sameSite : 'Lax',
    name: c.name,
    value: c.value
  })).filter((c) => c && c.name && c.value);
}

module.exports = async function handler(req, res) {
  const started = Date.now();

  try {
    // Modos de diagnóstico
    const mode = (req.query.mode || '').toString().toLowerCase();
    if (mode === 'ping') {
      const { WS } = readEnvs(); // valida presença
      return json(res, 200, { ok: true, ping: 'alive', hasWS: !!WS });
    }

    // Datas (se faltar, não quebra — o modo html não precisa)
    let range;
    try {
      range = buildDateStrings({ d: req.query.d, m: req.query.m, y: req.query.y });
    } catch (_) {
      // só reclama mais à frente se for realmente usar
      range = null;
    }

    const { WS, cookies } = readEnvs();
    const normCookies = normalizeCookies(cookies);

    console.log('[upseller] connectOverCDP →', WS.slice(0, 40) + '...');
    const browser = await chromium.connectOverCDP(WS);

    // Em conexões CDP, normalmente já existe 1 contexto
    let context = browser.contexts()[0];
    if (!context) context = await browser.newContext({ ignoreHTTPSErrors: true });

    if (normCookies.length) {
      console.log('[upseller] addCookies:', normCookies.length);
      try {
        await context.addCookies(normCookies);
      } catch (e) {
        console.warn('[upseller] addCookies falhou (vai seguir mesmo assim):', e.message);
      }
    }

    const page = await context.newPage();
    page.setDefaultTimeout(25000);

    const targetUrl = 'https://app.upseller.com/pt/analytics/store-sales';
    console.log('[upseller] goto:', targetUrl);
    await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });

    // Espera o título ficar estável / página pronta
    await page.waitForLoadState('load', { timeout: 20000 });
    await page.waitForFunction(
      () => document.readyState === 'complete' || document.title.toLowerCase().includes('upseller'),
      null,
      { timeout: 15000 }
    );

    // Se modo=html → devolve HTML para inspecionarmos seletores do datepicker
    if (mode === 'html') {
      const html = await page.content();
      await browser.close().catch(() => {});
      return json(res, 200, {
        ok: true,
        diag: {
          title: await page.title().catch(() => null),
          url: page.url(),
          len: html.length
        },
        html // cuidado: pode ser grande; use só pra diagnóstico
      });
    }

    // Daqui pra baixo é o fluxo normal: abrir o datepicker etc.
    if (!range) throw new Error('Parâmetros d/m/y obrigatórios para o fluxo normal');

    console.log('[upseller] procurando datepicker...');
    const openerSelectors = [
      '.ant-picker',
      '.ant-calendar-picker',
      "[class^='ant'][class*='picker'][class*='range']",
      "[data-testid='date-picker']",
      "input[placeholder*='Data']",
      "button[aria-label*='Data']"
    ];

    let opened = false;
    for (const sel of openerSelectors) {
      const el = await page.$(sel);
      if (el) {
        try {
          await el.click({ timeout: 3000 });
          opened = true;
          console.log('[upseller] datepicker aberto via', sel);
          break;
        } catch (e) {
          // tenta o próximo
        }
      }
    }
    if (!opened) throw new Error('Datepicker não encontrado');

    // 👉 aqui entram as ações de preenchimento da data (a depender do widget real)
    // Por ora, só retornamos o diagnóstico para validar que chegamos até aqui.

    const took = Date.now() - started;
    await browser.close().catch(() => {});
    return json(res, 200, {
      ok: true,
      reached: 'datepicker-opened',
      url: targetUrl,
      title: await page.title().catch(() => null),
      tookMs: took
    });

  } catch (err) {
    console.error('[upseller] ERROR:', err && err.stack || err);
    const took = Date.now() - started;
    return json(res, 500, { ok: false, error: String(err && err.message || err), tookMs: took });
  }
};
