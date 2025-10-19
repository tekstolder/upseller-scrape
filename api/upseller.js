import chromium from "@sparticuz/chromium";
import puppeteer from "puppeteer-core";

export default async function handler(req, res) {
  const start = Date.now();

  try {
    const d = req.query.d || "01";
    const m = req.query.m || "01";
    const y = req.query.y || "2025";

    // === ENVIRONMENT VARIABLES ===
    const browserlessWs = process.env.BROWSERLESS_WS;
    const cookiesJson = process.env.UPS_COOKIES_JSON;

    if (!browserlessWs) throw new Error("Variável BROWSERLESS_WS ausente");
    if (!cookiesJson) throw new Error("Variável UPS_COOKIES_JSON ausente");

    const cookies = JSON.parse(cookiesJson);

    // === CONEXÃO COM O BROWSERLESS (WEBSOCKET) ===
    const browser = await puppeteer.connect({
      browserWSEndpoint: browserlessWs,
      defaultViewport: { width: 1366, height: 768 },
    });

    const context = await browser.createIncognitoBrowserContext();
    if (cookies.length) await context.addCookies(cookies);

    const page = await context.newPage();
    page.setDefaultTimeout(20000);

    const target = "https://app.upseller.com/pt/analytics/store-sales";

    await page.goto(target, { waitUntil: "domcontentloaded", timeout: 45000 });

    // Aguarda redirect pós-login (até 8 segundos) e o título da página correta
    await page.waitForLoadState("load", { timeout: 8000 });
    await page.waitForFunction(
      () =>
        document.title.includes("UpSeller") ||
        document.readyState === "complete",
      { timeout: 8000 }
    );

    // pequeno delay adicional para renderização do painel
    await page.waitForTimeout(1200);

    // === ABRIR DATEPICKER ===
    const openerSelectors = [
      ".ant-picker-input input", // campo interno novo
      ".ant-picker-range", // container do range
      ".ant-picker", // fallback
      '[data-testid="date-picker"]', // alternativa moderna
      'input[placeholder*="Data"]', // fallback genérico
    ];

    let opened = false;
    await page.waitForSelector(openerSelectors[0], { timeout: 8000 });

    for (const sel of openerSelectors) {
      const el = await page.$(sel);
      if (el) {
        await el.click();
        opened = true;
        break;
      }
    }

    if (!opened) throw new Error("Datepicker não encontrado");

    // === SELECIONA INTERVALO DE DATAS ===
    // Exemplo: escreve manualmente o intervalo
    await page.keyboard.type(`${d}/${m}/${y}`);
    await page.waitForTimeout(800);
    await page.keyboard.press("Enter");

    // Espera filtro atualizar
    await page.waitForTimeout(1500);

    // === CAPTURA ALGUMA INFORMAÇÃO VISUAL ===
    const title = await page.title();
    const url = page.url();
    const filtro = await page.evaluate(() => {
      const chips = Array.from(document.querySelectorAll(".ant-tag")).map((el) =>
        el.textContent.trim()
      );
      const input = document
        .querySelector("input[placeholder*='Data']")
        ?.value?.trim();
      return { inputValue: input || null, chips };
    });

    await browser.disconnect();

    return res.status(200).json({
      ok: true,
      ui: { title, url, filtro },
      tookMs: Date.now() - start,
    });
  } catch (err) {
    return res.status(500).json({
      ok: false,
      error: err.message,
      tookMs: Date.now() - start,
    });
  }
}
