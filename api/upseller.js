import { chromium } from 'playwright-core';

export default async function handler(req, res) {
  try {
    const isGet = req.method === 'GET';
    const { d, m, y } = isGet ? req.query : req.body;
    if (!d || !m || !y) return res.status(400).json({ ok:false, error: 'Missing d/m/y' });

    const ws = process.env.BROWSERLESS_WS; // wss://production-sfo.browserless.io/chromium?token=SEU_TOKEN
    if (!ws) return res.status(500).json({ ok:false, error:'Missing BROWSERLESS_WS' });

    const browser = await chromium.connectOverCDP(ws);
    const context = await browser.newContext();

    const cookies = JSON.parse(process.env.UPS_COOKIES_JSON || '[]').map(c => ({ ...c, sameSite: 'Lax' }));
    if (cookies.length) await context.addCookies(cookies);

    const page = await context.newPage();
    await page.goto('https://app.upseller.com/pt/analytics/store-sales', { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('networkidle', { timeout: 90000 });

    // Abrir calendário
    await page.click('.ant-calendar-picker');
    await page.waitForSelector('.ant-calendar-picker-container:not([style*=display: none])', { timeout: 60000 });

    const meses = ['janeiro','fevereiro','marco','abril','maio','junho','julho','agosto','setembro','outubro','novembro','dezembro'];
    const mesOntem = meses[parseInt(m,10)-1];

    // Descobrir painel com o mês correto
    const painel = await page.evaluate(({ mesOntem }) => {
      const c = document.querySelector('.ant-calendar-picker-container:not([style*=display: none])');
      const L = c?.querySelector('.ant-calendar-range-left');
      const R = c?.querySelector('.ant-calendar-range-right');
      const has = p => (p?.querySelector('.ant-calendar-month-select')?.textContent||'').toLowerCase().includes(mesOntem);
      if (has(L)) return 'left';
      if (has(R)) return 'right';
      return null;
    }, { mesOntem });
    if (!painel) throw new Error(`Mês ${mesOntem} não visível no calendário`);

    // Selecionar ontem (duplo clique para range 1-dia)
    await page.evaluate(({ painel, d }) => {
      const c = document.querySelector('.ant-calendar-picker-container:not([style*=display: none])');
      const root = painel === 'left' ? c.querySelector('.ant-calendar-range-left') : c.querySelector('.ant-calendar-range-right');
      const ds = Array.from(root.querySelectorAll('.ant-calendar-date'));
      const alvo = ds.find(el => parseInt(el.textContent.trim()) === parseInt(d,10) && !el.classList.contains('ant-calendar-disabled-cell'));
      if (!alvo) throw new Error(`Dia ${d} não encontrado`);
      alvo.click(); setTimeout(() => alvo.click(), 600);
    }, { painel, d });

    await page.waitForTimeout(1200);

    // Trocar para a aba "Por Loja"
    await page.evaluate(() => {
      const tab = Array.from(document.querySelectorAll('.ant-tabs-tab')).find(t => t.textContent.includes('Por Loja'));
      if (!tab) throw new Error('Aba Por Loja não encontrada');
      tab.click();
    });
    await page.waitForTimeout(7000);

    // Extrair tabela
    const result = await page.evaluate(() => {
      const rows = document.querySelectorAll('table tbody tr');
      const M = [], S = [];
      const parseV = v => parseFloat(v.replace(/[^0-9,]/g,'').replace(',','.'))||0;

      rows.forEach(r => {
        const tds = r.querySelectorAll('td');
        if (tds.length >= 6) {
          const loja = tds[0].textContent.trim();
          const pedidos = parseInt(tds[4].textContent.trim())||0;
          const valorTxt = tds[5].textContent.trim();
          const valor = parseV(valorTxt);
          const item = { loja, pedidos, valorTxt, valor };
          if (loja.startsWith('MELI')) M.push(item);
          else if (loja.startsWith('SPEE') || loja.startsWith('SHOPEE')) S.push(item);
        }
      });

      const sum = arr => arr.reduce((s,{pedidos,valor}) => ({ pedidos: s.pedidos+pedidos, valor: s.valor+valor }), { pedidos:0, valor:0 });
      return { meli:{ lojas:M, totais:sum(M) }, shopee:{ lojas:S, totais:sum(S) } };
    });

    await context.close();
    await browser.close();

    return res.status(200).json({
      ok: true, d, m, y,
      ...result,
      total: {
        lojas: result.meli.lojas.length + result.shopee.lojas.length,
        pedidos: result.meli.totais.pedidos + result.shopee.totais.pedidos,
        valor: result.meli.totais.valor + result.shopee.totais.valor
      }
    });
  } catch (e) {
    return res.status(500).json({ ok:false, error: e.message });
  }
}
