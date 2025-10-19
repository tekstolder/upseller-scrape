// api/upseller.js
const { chromium } = require('playwright-core');

async function connectWithRetry(wsUrl, maxAttempts = 3) {
  let lastErr;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await chromium.connectOverCDP(wsUrl);
    } catch (e) {
      lastErr = e;
      const msg = String(e && e.message ? e.message : e);
      // Só tenta de novo se for erro de rate/conexão
      const retriable = /429|Too Many Requests|ECONNRESET|ENETUNREACH|closed before the connection/i.test(msg);
      if (!retriable || attempt === maxAttempts) throw e;
      // backoff simples: 800ms, 1600ms, 2400ms
      const wait = 800 * attempt;
      await new Promise(r => setTimeout(r, wait));
    }
  }
  throw lastErr;
}

module.exports = async function handler(req, res) {
  const t0 = Date.now();
  let browser;
  let context;

  try {
    const isGet = req.method === 'GET';
    const body = isGet ? (req.query || {}) : (req.body || {});
    const d = body.d, m = body.m, y = body.y;
    if (!d || !m || !y) {
      return res.status(400).json({ ok: false, error: 'Missing d/m/y' });
    }

    const ws = process.env.BROWSERLESS_WS;
    const cookiesJson = process.env.UPS_COOKIES_JSON || '[]';
    if (!ws) return res.status(500).json({ ok: false, error: 'Missing BROWSERLESS_WS' });

    // 1) Conecta com retry (resolve 429/latência entre chamadas)
    browser = await connectWithRetry(ws, 3);

    // 2) Contexto e defaults
    context = await browser.newContext();
    const cookies = JSON.parse(cookiesJson).map(c => ({
      ...c,
      sameSite: c.sameSite || 'Lax',
      secure: true,
    }));
    if (cookies.length) await context.addCookies(cookies);

    const page = await context.newPage();
    page.setDefaultTimeout(20000);

    const target = 'https://app.upseller.com/pt/analytics/store-sales';
    await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(1200); // evita networkidle (SPA)

    // 1) Abre o datepicker (suporta antigos e novos seletores)
    const openerSelectors = [
      '.ant-picker',
      '.ant-calendar-picker',
      '[class*=ant][class*=picker][class*=range]',
    ];
    let opened = false;
    for (const sel of openerSelectors) {
      const el = await page.$(sel);
      if (el) { await el.click(); opened = true; break; }
    }
    if (!opened) throw new Error('Datepicker não encontrado');

    // 2) Dropdown visível
    const dropdownSelectors = [
      '.ant-picker-dropdown:not([style*=display: none])',
      '.ant-calendar-picker-container:not([style*=display: none])',
    ];
    let ddSel = null;
    for (const s of dropdownSelectors) {
      const exists = await page.$(s);
      if (exists) { ddSel = s; break; }
      try { await page.waitForSelector(s, { timeout: 4000 }); ddSel = s; break; } catch {}
    }
    if (!ddSel) throw new Error('Dropdown do calendário não apareceu');

    // 3) Garantir mês/ano visíveis
    const meses = ['janeiro','fevereiro','marco','abril','maio','junho','julho','agosto','setembro','outubro','novembro','dezembro'];
    const mesNome = meses[parseInt(m, 10) - 1];
    const ano = String(y);

    async function painelComMesAno() {
      return page.evaluate(({ ddSel, mesNome, ano }) => {
        const dd = document.querySelector(ddSel);
        const L = dd && (dd.querySelector('.ant-picker-panel-container .ant-picker-panels .ant-picker-panel:nth-child(1)') ||
                         dd.querySelector('.ant-calendar-range-left'));
        const R = dd && (dd.querySelector('.ant-picker-panel-container .ant-picker-panels .ant-picker-panel:nth-child(2)') ||
                         dd.querySelector('.ant-calendar-range-right'));

        function match(root) {
          if (!root) return false;
          const a = root.querySelector('.ant-picker-month-btn, .ant-calendar-month-select');
          const y = root.querySelector('.ant-picker-year-btn, .ant-calendar-year-select');
          const mt = (a && a.textContent ? a.textContent : '').toLowerCase();
          const yt = (y && y.textContent ? y.textContent : '').toLowerCase();
          return mt.includes(mesNome) && yt.includes(ano);
        }
        if (match(L)) return 'left';
        if (match(R)) return 'right';
        return null;
      }, { ddSel, mesNome, ano });
    }

    let lado = await painelComMesAno();
    if (!lado) {
      for (let i = 0; i < 6 && !lado; i++) {
        const prev = await page.$(`${ddSel} .ant-picker-header-prev-btn, ${ddSel} .ant-calendar-prev-month-btn`);
        if (prev) { await prev.click(); await page.waitForTimeout(250); }
        lado = await painelComMesAno();
      }
    }
    if (!lado) throw new Error(`Mês/ano desejado não visíveis: ${mesNome}/${ano}`);

    // 4) Seleciona o dia (duplo clique → range de 1 dia)
    await page.evaluate(({ ddSel, lado, d }) => {
      const dd = document.querySelector(ddSel);
      const root = lado === 'left'
        ? ((dd && dd.querySelector('.ant-picker-panel-container .ant-picker-panels .ant-picker-panel:nth-child(1)')) ||
           (dd && dd.querySelector('.ant-calendar-range-left')))
        : ((dd && dd.querySelector('.ant-picker-panel-container .ant-picker-panels .ant-picker-panel:nth-child(2)')) ||
           (dd && dd.querySelector('.ant-calendar-range-right')));

      const cells = root ? Array.from(root.querySelectorAll('.ant-picker-cell-inner, .ant-calendar-date')) : [];
      const alvo = cells.find(el => {
        const txt = (el.textContent || '').trim();
        const num = parseInt(txt, 10);
        return num === parseInt(d, 10);
      });
      if (!alvo) throw new Error(`Dia ${d} não encontrado`);
      alvo.click();
      setTimeout(() => alvo.click(), 450);
    }, { ddSel, lado, d });

    await page.waitForTimeout(1200);

    // 5) Sinal de filtro aplicado
    const filtro = await page.evaluate(() => {
      const inputEl = document.querySelector('.ant-picker-input input');
      const inputValue = inputEl && inputEl.value ? inputEl.value : null;
      const chips = Array.from(document.querySelectorAll('.ant-tag'))
        .map(e => (e.textContent || '').trim())
        .filter(Boolean);
      return { inputValue, chips };
    });

    const out = {
      ok: true,
      ui: {
        title: await page.title(),
        url: page.url(),
        filtro
      },
      tookMs: Date.now() - t0
    };

    await context.close();
    await browser.close();
    return res.status(200).json(out);

  } catch (e) {
    // Cleanup defensivo
    try { if (context) await context.close(); } catch {}
    try { if (browser) await browser.close(); } catch {}

    return res.status(200).json({
      ok: false,
      error: String(e && e.message ? e.message : e),
      tookMs: Date.now() - t0,
    });
  }
};
