import { chromium } from 'playwright-core';

export default async function handler(req, res) {
  const t0 = Date.now();
  try {
    const isGet = req.method === 'GET';
    const { d, m, y } = isGet ? req.query : req.body || {};
    // não vamos usar d/m/y agora — só diagnóstico
    const ws = process.env.BROWSERLESS_WS;
    const cookiesJson = process.env.UPS_COOKIES_JSON || '[]';

    if (!ws) return res.status(500).json({ ok:false, error:'Missing BROWSERLESS_WS' });

    const browser = await chromium.connectOverCDP(ws);
    const context = await browser.newContext();

    // cookies exatamente como estão na env
    const cookies = JSON.parse(cookiesJson).map(c => ({
      ...c,
      sameSite: c.sameSite || 'Lax',
      secure: c.secure !== false // força true por segurança
    }));
    if (cookies.length) await context.addCookies(cookies);

    const page = await context.newPage();

    // 1) abrir a URL e não usar networkidle (deixa scripts rodarem)
    const urlTarget = 'https://app.upseller.com/pt/analytics/store-sales';
    const resp = await page.goto(urlTarget, { waitUntil: 'domcontentloaded', timeout: 90000 });

    // 2) coletar sinais sem clicar em nada
    const currentUrl = page.url();
    const title = await page.title();
    const status = resp?.status();
    // pega só um pedaço do HTML para identificar login vs app
    const html = await page.content();
    const snippet = html.slice(0, 1500);

    // heurísticas de login/redirect
    const looksLikeLogin =
      /login|entrar|acessar/i.test(title) ||
      /password|senha|email/i.test(snippet) ||
      /auth|sso|sign-?in/i.test(snippet) ||
      /Upseller.*Login/i.test(snippet);

    // fecha gentilmente
    await context.close();
    await browser.close();

    return res.status(200).json({
      ok: true,
      diag: {
        loadMs: Date.now() - t0,
        target: urlTarget,
        status,
        title,
        currentUrl,
        looksLikeLogin
      }
    });
  } catch (e) {
    return res.status(200).json({
      ok: false,
      error: String(e?.message || e),
      where: 'diagnostic',
      tookMs: Date.now() - t0
    });
  }
}
