import { chromium } from 'playwright-core';

export default async function handler(req, res) {
  const t0 = Date.now();
  try {
    const isGet = req.method === 'GET';
    const { d, m, y } = isGet ? req.query : (req.body || {});
    if (!d || !m || !y) return res.status(400).json({ ok:false, error:'Missing d/m/y' });

    const ws = process.env.BROWSERLESS_WS;
    const cookiesJson = process.env.UPS_COOKIES_JSON || '[]';
    if (!ws) return res.status(500).json({ ok:false, error:'Missing BROWSERLESS_WS' });

    const browser = await chromium.connectOverCDP(ws);
    const context = await browser.newContext();
    const cookies = JSON.parse(cookiesJson).map(c => ({ ...c, sameSite: c.sameSite || 'Lax', secure: true }));
    if (cookies.length) await context.addCookies(cookies);

    const page = await context.newPage();
    const target = 'https://app.upseller.com/pt/analytics/store-sales';
    await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 90000 });
    await page.waitForLoadState('networkidle', { timeout: 90000 });

    // 1) abrir o datepicker (tente classes novas e antigas do Ant Design)
    const openers = [
      '.ant-picker',                           // AntD v4+
      '.ant-calendar-picker',                  // AntD antigo
      '[class*=picker][class*=ant]-range',     // fallback
    ];
    let opened = false;
    for (const sel of openers) {
      const ok = await page.$(sel);
      if (ok) {
        await ok.click();
        opened = true;
        break;
      }
    }
    if (!opened) throw new Error('Datepicker não encontrado');

    // 2) aguardar o dropdown visível (novas/antigas classes)
    const dropdownSelectors = [
      '.ant-picker-dropdown:not([style*=display: none])',
      '.ant-calendar-picker-container:not([style*=display: none])'
    ];
    let ddSel = null;
    for (const s of dropdownSelectors) {
      if (await page.$(s)) { ddSel = s; break; }
      try { await page.waitForSelector(s, { timeout: 4000 }); ddSel = s; break; } catch {}
    }
    if (!ddSel) throw new Error('Dropdown do calendário não apareceu');

    // 3) localizar painel (esquerdo/direito) que mostra o mês/ano desejado
    const meses = ['janeiro','fevereiro','marco','abril','maio','junho','julho','agosto','setembro','outubro','novembro','dezembro'];
    const mesNome = meses[parseInt(m,10)-1];
    const ano = String(y);

    const painel = await page.evaluate(({ ddSel, mesNome, ano }) => {
      const dd = document.querySelector(ddSel);
      const L = dd?.querySelector('.ant-picker-panel-container .ant-picker-panels .ant-picker-panel:nth-child(1)') ||
                dd?.querySelector('.ant-calendar-range-left');
      const R = dd?.querySelector('.ant-picker-panel-container .ant-picker-panels .ant-picker-panel:nth-child(2)') ||
                dd?.querySelector('.ant-calendar-range-right');

      const mm = (root) => {
        if (!root) return '';
        const a = root.querySelector('.ant-picker-month-btn, .ant-calendar-month-select');
        const y = root.querySelector('.ant-picker-year-btn, .ant-calendar-year-select');
        const mt = (a?.textContent || '').toLowerCase();
        const yt = (y?.textContent || '').toLowerCase();
        return (mt.includes(mesNome) && yt.includes(ano)) ? 'ok' : '';
      };

      if (mm(L)) return 'left';
      if (mm(R)) return 'right';
      return null;
    }, { ddSel, mesNome, ano });

    // Se o mês/ano não estiverem visíveis, tentamos navegar com setas até cair no mês correto
    if (!painel) {
      for (let i=0; i<6; i++) {
        // tentar botão "mês anterior"
        const prev = await page.$(`${ddSel} .ant-picker-header-prev-btn, ${ddSel} .ant-calendar-prev-month-btn`);
        if (prev) await prev.click();
        await page.waitForTimeout(300);
        const okNow = await page.evaluate(({ ddSel, mesNome, ano }) => {
          const dd = document.querySelector(ddSel);
          const L = dd?.querySelector('.ant-picker-panel-container .ant-picker-panels .ant-picker-panel:nth-child(1)') ||
                    dd?.querySelector('.ant-calendar-range-left');
          const R = dd?.querySelector('.ant-picker-panel-container .ant-picker-panels .ant-picker-panel:nth-child(2)') ||
                    dd?.querySelector('.ant-calendar-range-right');
          const mm = (root) => {
            if (!root) return '';
            const a = root.querySelector('.ant-picker-month-btn, .ant-calendar-month-select');
            const y = root.querySelector('.ant-picker-year-btn, .ant-calendar-year-select');
            const mt = (a?.textContent || '').toLowerCase();
            const yt = (y?.textContent || '').toLowerCase();
            return (mt.includes(mesNome) && yt.includes(ano)) ? 'ok' : '';
          };
          if (mm(L)) return 'left';
          if (mm(R)) return 'right';
          return null;
        }, { ddSel, mesNome, ano });
        if (okNow) break;
      }
    }

    const lado = await page.evaluate(({ ddSel, mesNome, ano }) => {
      const dd = document.querySelector(ddSel);
      const L = dd?.querySelector('.ant-picker-panel-container .ant-picker-panels .ant-picker-panel:nth-child(1)') ||
                dd?.querySelector('.ant-calendar-range-left');
      const R = dd?.querySelector('.ant-picker-panel-container .ant-picker-panels .ant-picker-panel:nth-child(2)') ||
                dd?.querySelector('.ant-calendar-range-right');
      const mm = (root) => {
        if (!root) return '';
        const a = root.querySelector('.ant-picker-month-btn, .ant-calendar-month-select');
        const y = root.querySelector('.ant-picker-year-btn, .ant-calendar-year-select');
        const mt = (a?.textContent || '').toLowerCase();
        const yt = (y?.textContent || '').toLowerCase();
        return (mt.includes(mesNome) && yt.includes(ano)) ? 'ok' : '';
      };
      if (mm(L)) return 'left';
      if (mm(R)) return 'right';
      return null;
    }, { ddSel, mesNome, ano });

    if (!lado) throw new Error(`Mês/ano desejado não visíveis: ${mesNome}/${ano}`);

    // 4) clicar no dia D duas vezes para range de um dia
    await page.evaluate(({ ddSel, lado, d }) => {
      const dd = document.querySelector(ddSel);
      const root = lado === 'left'
        ? (dd.querySelector('.ant-picker-panel-container .ant-picker-panels .ant-picker-panel:nth-child(1)') || dd.querySelector('.ant-calendar-range-left'))
        : (dd.querySelector('.ant-picker-panel-container .ant-picker-panels .ant-picker-panel:nth-child(2)') || dd.querySelector('.ant-calendar-range-right'));
      const cells = Array.from(root.querySelectorAll('.ant-picker-cell-inner, .ant-calendar-date'));
      const alvo = cells.find(el => parseInt(el.textContent.trim(), 10) === parseInt(d, 10));
      if (!alvo) throw new Error(`Dia ${d} não encontrado`);
      (alvo as HTMLElement).click();
      setTimeout(() => (alvo as HTMLElement).click(), 500);
    }, { ddSel, lado, d });

    await page.waitForTimeout(1500);

    // 5) coletar alguma pista visual de que filtrou (texto do input do picker, chips, etc.)
    const filtro = await page.evaluate(() => {
      const input = document.querySelector('.ant-picker-input input') as HTMLInputElement | null;
      const chips = Array.from(document.querySelectorAll('.ant-tag')).map(e => e.textContent?.trim()).filter(Boolean);
      return { inputValue: input?.value || null, chips };
    });

    const out = {
      ok: true,
      ui: {
        title: await page.title(),
        url: page.url(),
        filtro
      }
    };

    await context.close();
    await browser.close();

    return res.status(200).json(out);
  } catch (e) {
    return res.status(200).json({ ok:false, error:String(e?.message||e) });
  }
}
