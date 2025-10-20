// api/upseller.js
// Node 20.x — Serverless on Vercel

import { chromium } from "playwright-core";

function json(res, status, body) {
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body, null, 2));
}

function parseDateParams(q) {
  const from = `${q.d?.padStart?.(2, "0")}/${q.m?.padStart?.(2, "0")}/${q.y}`;
  const to = from;
  return { from, to };
}

// -----------------------------
// FUNÇÃO: setDateRangeSmart()
// -----------------------------
async function setDateRangeSmart(page, fromStr, toStr, opts = {}) {
  const {
    preferQuickLabel, // ex: "Últimos 30 dias"
    debug = false,
    openTimeout = 8000,
  } = opts;

  // abre o dropdown do datepicker
  const openPicker = async () => {
    // existem duas abas “Por Data / Por Loja”; usamos o range visível ao lado dos botões de atalho
    // seletores genéricos (v4 antd ainda usa essas classes)
    const openerCandidates = [
      ".ant-calendar-picker",
      ".ant-picker-range", // ant v4
      ".ant-calendar-range-picker",
    ];
    for (const sel of openerCandidates) {
      const ok = await page.$(sel);
      if (ok) {
        await ok.click({ delay: 40 });
        return true;
      }
    }
    return false;
  };

  // tenta abrir
  await openPicker();
  await page.waitForTimeout(200);

  // 1) quick label (se pedido)
  if (preferQuickLabel) {
    try {
      await page.waitForSelector(".ant-calendar-range-quick-selector", {
        timeout: 1500,
      });
      const hit = await page.evaluate((label) => {
        const wraps = document.querySelectorAll(
          ".ant-calendar-range-quick-selector"
        );
        for (const w of wraps) {
          const spans = w.querySelectorAll("span");
          for (const s of spans) {
            if (s.textContent?.trim() === label) {
              s.click();
              return true;
            }
          }
        }
        return false;
      }, preferQuickLabel);

      if (hit) {
        if (debug) console.log("Quick label aplicado:", preferQuickLabel);
        // o painel costuma fechar sozinho; se não, pressiona o botão OK
        const okBtn =
          (await page.$(".ant-calendar-ok-btn")) ||
          (await page.$(".ant-picker-ok button"));
        if (okBtn) await okBtn.click();
        await page.waitForLoadState("networkidle", { timeout: 5000 }).catch(
          () => {}
        );
        return true;
      }
    } catch (_) {
      // segue
    }
  }

  // 2) digitar nos inputs (removendo readonly + disparando evento React)
  // garante que o dropdown está aberto
  if (!(await page.$(".ant-calendar-range, .ant-picker-dropdown"))) {
    await openPicker();
    await page.waitForSelector(".ant-calendar-range, .ant-picker-dropdown", {
      timeout: openTimeout,
    });
  }

  const typedOk = await page
    .evaluate(
      ({ fromStr, toStr }) => {
        function dispatchReactInput(el, value) {
          const desc = Object.getOwnPropertyDescriptor(
            window.HTMLInputElement.prototype,
            "value"
          );
          desc.set.call(el, value);
          el.dispatchEvent(new Event("input", { bubbles: true }));
          el.dispatchEvent(new Event("change", { bubbles: true }));
          el.blur?.();
        }

        // aceita v3 (ant-calendar-*) e v4 (ant-picker-*)
        const inputs =
          document.querySelectorAll(".ant-calendar-range-picker-input") ??
          [];
        const inputsV4 =
          document.querySelectorAll(".ant-picker-range input") ?? [];

        let start, end;
        if (inputs.length >= 2) {
          [start, end] = [inputs[0], inputs[1]];
        } else if (inputsV4.length >= 2) {
          [start, end] = [inputsV4[0], inputsV4[1]];
        } else {
          return false;
        }

        // remove readonly enquanto digita
        start.removeAttribute("readonly");
        end.removeAttribute("readonly");
        dispatchReactInput(start, fromStr);
        dispatchReactInput(end, toStr);

        // restaura readonly
        start.setAttribute("readonly", "true");
        end.setAttribute("readonly", "true");

        return true;
      },
      { fromStr, toStr }
    )
    .catch(() => false);

  if (typedOk) {
    // fecha/ok caso necessário
    const okBtn =
      (await page.$(".ant-calendar-ok-btn")) ||
      (await page.$(".ant-picker-ok button"));
    if (okBtn) await okBtn.click().catch(() => {});
    await page.waitForTimeout(400);
    return true;
  }

  // 3) fallback: clicar dias (mesmo mês)
  const [d1, m1, y1] = fromStr.split("/").map((v) => parseInt(v, 10));
  const [d2, m2, y2] = toStr.split("/").map((v) => parseInt(v, 10));
  if (y1 === y2 && m1 === m2) {
    try {
      // garante dropdown
      if (!(await page.$(".ant-calendar-range, .ant-picker-dropdown"))) {
        await openPicker();
      }
      await page.waitForSelector(".ant-calendar-date, .ant-picker-cell", {
        timeout: openTimeout,
      });

      // clica dia inicial
      await page.evaluate((d) => {
        const pickers = document.querySelectorAll(".ant-calendar-date");
        for (const el of pickers) {
          if (el.textContent?.trim() === String(d)) {
            el.click();
            break;
          }
        }
      }, d1);
      await page.waitForTimeout(250);

      // clica dia final
      await page.evaluate((d) => {
        const pickers = document.querySelectorAll(".ant-calendar-date");
        for (const el of pickers) {
          if (el.textContent?.trim() === String(d)) {
            el.click();
            break;
          }
        }
      }, d2);

      const okBtn =
        (await page.$(".ant-calendar-ok-btn")) ||
        (await page.$(".ant-picker-ok button"));
      if (okBtn) await okBtn.click().catch(() => {});
      await page.waitForTimeout(300);
      return true;
    } catch {
      // segue
    }
  }

  return false;
}

// ---------------------------------
// NORMALIZAÇÃO de texto de header
// ---------------------------------
function norm(s) {
  return (s || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

// ---------------------------------
// GRUPOS e ORDENACAO
// ---------------------------------
function groupAndSort(rows) {
  // rows: [{ loja, pedidosValidos, valorVendasValidas }]
  const MELI = [];
  const SPEE = [];
  for (const r of rows) {
    const tag = (r.loja || "").toUpperCase();
    if (tag.includes("MELI")) MELI.push(r);
    else if (tag.includes("SPEE")) SPEE.push(r);
  }
  const byValueDesc = (a, b) => (b.valorVendasValidas || 0) - (a.valorVendasValidas || 0);
  MELI.sort(byValueDesc);
  SPEE.sort(byValueDesc);
  return {
    MELI: MELI.slice(0, 7),
    SPEE: SPEE.slice(0, 7),
  };
}

// ---------------------------------
// HANDLER
// ---------------------------------
export default async function handler(req, res) {
  const started = Date.now();
  try {
    const { query } = req;
    const range = parseDateParams(query);
    const preferQuickLabel = query.quick || ""; // opcional

    // Ping simples (sem browser)
    if (query.ping != null) {
      return json(res, 200, { ok: true, ping: "alive", hasWS: !!process.env.BROWSERLESS_WS });
    }

    // Conecta no Browserless
    const WS = process.env.BROWSERLESS_WS;
    if (!WS) return json(res, 500, { ok: false, error: "BROWSERLESS_WS não definido" });

    const browser = await chromium.connectOverCDP(WS);
    const context = await browser.newContext();

    // cookies (opcional)
    try {
      const raw = process.env.UPS_COOKIES_JSON || "[]";
      const cookies = JSON.parse(raw);
      if (Array.isArray(cookies) && cookies.length) {
        await context.addCookies(
          cookies.map((c) => ({
            ...c,
            sameSite: c.sameSite || "Lax",
            secure: true,
          }))
        );
      }
    } catch (_) {
      // segue sem cookies
    }

    const page = await context.newPage();
    page.setDefaultTimeout(20000);

    const target = "https://app.upseller.com/pt/analytics/store-sales";
    await page.goto(target, { waitUntil: "domcontentloaded", timeout: 45000 });
    await page.waitForLoadState("load", { timeout: 8000 }).catch(() => {});
    await page.waitForTimeout(600);

    // HTML bruto de diagnóstico
    if (query.html != null) {
      const html = await page.content();
      const diag = {
        title: await page.title().catch(() => null),
        url: page.url(),
        len: html?.length || 0,
      };
      await context.close();
      await browser.close();
      return json(res, 200, { ok: true, diag, html });
    }

    // Aplica o período
    const applied = await setDateRangeSmart(page, range.from, range.to, {
      preferQuickLabel: preferQuickLabel || undefined,
      debug: false,
    });

    if (!applied) {
      throw new Error("Datepicker não encontrado");
    }

    // Aguarda tabela renderizar
    await page.waitForSelector(".ant-table", { timeout: 12000 }).catch(() => {});
    await page.waitForTimeout(800);

    // Extrai cabeçalhos + linhas (texto)
    const tableRaw = await page.evaluate(() => {
      const tbl = document.querySelector(".ant-table");
      if (!tbl) return null;

      const headers = Array.from(tbl.querySelectorAll("thead th")).map((th) =>
        (th.textContent || "").trim()
      );

      const rows = Array.from(tbl.querySelectorAll("tbody tr")).map((tr) =>
        Array.from(tr.querySelectorAll("td")).map((td) => (td.textContent || "").trim())
      );

      return { headers, rows };
    });

    if (!tableRaw || !tableRaw.headers?.length) {
      throw new Error("Tabela não encontrada/sem cabeçalhos");
    }

    // Descobre índices das colunas de interesse (normalizando)
    const H = tableRaw.headers.map(norm);
    const idxLoja = H.findIndex((h) => h.startsWith("loja"));
    const idxPedidosValidos = H.findIndex((h) => h.includes("pedidos validos"));
    const idxVendasValidas = H.findIndex((h) => h.includes("valor de vendas validas"));

    if (idxLoja < 0 || idxPedidosValidos < 0 || idxVendasValidas < 0) {
      throw new Error(
        `Colunas não localizadas. headers norm: ${JSON.stringify(H)}`
      );
    }

    // Converte linhas -> objetos já parseando números BR
    const toNumberBR = (txt) => {
      // exemplos: "3.683,65" → 3683.65
      if (typeof txt !== "string") return 0;
      const t = txt.replace(/\./g, "").replace(",", ".");
      const n = parseFloat(t);
      return Number.isFinite(n) ? n : 0;
    };

    const parsedRows = tableRaw.rows.map((cols) => {
      const loja = cols[idxLoja] || "";
      const pedidosValidos = toNumberBR(cols[idxPedidosValidos]);
      const valorVendasValidas = toNumberBR(cols[idxVendasValidas]);
      return { loja, pedidosValidos, valorVendasValidas };
    });

    // Agrupa (MELI / SPEE), ordena e pega top-7
    const groups = groupAndSort(parsedRows);

    const tookMs = Date.now() - started;
    await context.close();
    await browser.close();

    return json(res, 200, {
      ok: true,
      period: { from: range.from, to: range.to },
      page: { title: await page.title().catch(() => null), url: target },
      groups,
      tookMs,
    });
  } catch (err) {
    const tookMs = Date.now() - started;
    return json(res, 200, {
      ok: false,
      error: String(err?.message || err),
      tookMs,
    });
  }
}
