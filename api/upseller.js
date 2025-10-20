/**
 * Ajusta o período do Ant Design RangePicker (v3) usando:
 *  1) Atalhos (ex.: "Últimos 30 dias")
 *  2) Clique em datas do calendário (painel flutuante)
 *  3) Fallback escrevendo nos inputs e disparando eventos React
 *
 * Aceita datas "DD/MM/YYYY".
 */
async function setDateRangeSmart(page, fromStr, toStr, opts = {}) {
  const {
    preferQuickLabel = null,        // ex.: "Últimos 30 dias" (se quiser usar atalho)
    openSelector = '.ant-calendar-picker', // wrapper que abre o popup
    popupSelector = '.ant-calendar, .ant-calendar-picker-container',
    quickSelector = '.ant-calendar-range-quick-selector span',
    barInputsSelector = '.ant-calendar-range-picker-input', // 2 inputs na barra
    cellSelector = '.ant-calendar-date', // células de dia
    okSelector = '.ant-calendar-ok-btn, .ant-calendar-footer .ant-btn-primary',
    debug = false
  } = opts;

  function dlog(...a) { if (debug) console.log('[RANGE]', ...a); }

  // 1) Abre o popup do calendar
  await page.waitForSelector(openSelector, { timeout: 15000 });
  await page.click(openSelector);
  await page.waitForSelector(popupSelector, { timeout: 15000 });
  await page.waitForTimeout(150);

  // --- 1a. Tenta por ATALHO (se label for fornecido) -----------------------
  if (preferQuickLabel) {
    const clicked = await page.$$eval(
      quickSelector,
      (els, label) => {
        let hit = false;
        els.forEach(el => {
          if ((el.textContent || '').trim() === label) {
            (el.closest('span') || el).click();
            hit = true;
          }
        });
        return hit;
      },
      preferQuickLabel
    ).catch(() => false);

    if (clicked) {
      await page.waitForTimeout(200);
      // tenta fechar/confirmar
      const ok = await page.$(okSelector);
      if (ok) await ok.click().catch(()=>{});
      await page.waitForTimeout(400);
      dlog('Selecionado por atalho:', preferQuickLabel);
      return true;
    } else {
      dlog('Atalho não encontrado:', preferQuickLabel);
    }
  }

  // --- 1b. Tenta por CLIQUE EM CÉLULAS -------------------------------------
  // Se o mês/ano não é o atual, navegar meses com botões do Ant pode ser adicionado.
  // Aqui focamos no clique direto; normalmente o Ant mantém a navegação simples.

  // Parse de DD/MM/YYYY
  const [d1, m1, y1] = fromStr.split('/').map(n => parseInt(n, 10));
  const [d2, m2, y2] = toStr.split('/').map(n => parseInt(n, 10));

  // Helper: clica na célula com o dia informado (no calendário visível)
  async function clickDay(day) {
    const hit = await page.$$eval(
      cellSelector,
      (cells, day) => {
        const want = String(day);
        // prefere células "válidas" (sem classes de fora do mês)
        const valid = [...cells].filter(c => !c.className.includes('ant-calendar-last-month-cell') &&
                                             !c.className.includes('ant-calendar-next-month-btn-day'));
        function text(el){return (el.textContent||'').trim();}
        let clicked = false;
        for (const el of valid.length ? valid : cells) {
          if (text(el) === want) { el.click(); clicked = true; break; }
        }
        return clicked;
      },
      day
    ).catch(() => false);
    if (!hit) throw new Error(`Dia ${day} não encontrado nas células visíveis`);
  }

  try {
    // clica data inicial e depois final
    await clickDay(d1);
    await page.waitForTimeout(200);
    await clickDay(d2);
    await page.waitForTimeout(200);

    // confirma se houver botão
    const ok = await page.$(okSelector);
    if (ok) {
      await ok.click().catch(()=>{});
      await page.waitForTimeout(300);
    } else {
      // fallback com Enter
      await page.keyboard.press('Enter').catch(()=>{});
      await page.waitForTimeout(150);
      await page.keyboard.press('Enter').catch(()=>{});
      await page.waitForTimeout(200);
    }

    dlog('Selecionado por clique nas células:', fromStr, toStr);
  } catch (e) {
    dlog('Clique em células falhou, tentando inputs. Motivo:', e.message);

    // --- 1c. Fallback: escreve nos INPUTS da barra + eventos React ----------
    await page.click(openSelector).catch(()=>{}); // garante aberto
    await page.waitForSelector(barInputsSelector, { timeout: 8000 });

    const fillBar = await page.$$eval(
      barInputsSelector,
      (els, from, to) => {
        if (!els || els.length < 2) return false;

        const [start, end] = els;

        function setReactValue(el, value) {
          el.removeAttribute('readonly');
          const desc = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value');
          desc.set.call(el, value);
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
          el.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: 'Enter', code: 'Enter', which: 13, keyCode: 13 }));
        }

        setReactValue(start, from);
        setReactValue(end, to);
        return { start: start.value, end: end.value };
      },
      fromStr,
      toStr
    ).catch(() => false);

    if (!fillBar || !fillBar.start || !fillBar.end) {
      throw new Error('Falha ao preencher inputs do range');
    }

    // confirma
    const ok2 = await page.$(okSelector);
    if (ok2) {
      await ok2.click().catch(()=>{});
      await page.waitForTimeout(300);
    } else {
      await page.keyboard.press('Enter').catch(()=>{});
      await page.waitForTimeout(150);
      await page.keyboard.press('Enter').catch(()=>{});
      await page.waitForTimeout(200);
    }

    dlog('Selecionado via inputs do range:', fillBar);
  }

  // --- 2) Verificação: lê os inputs para garantir que ficaram corretos ------
  const got = await page.$$eval(
    barInputsSelector,
    els => (els && els.length >= 2) ? { from: els[0].value || '', to: els[1].value || '' } : null
  ).catch(() => null);

  if (!got || !got.from || !got.to) {
    throw new Error('Inputs do date-range não encontrados após seleção');
  }

  // normaliza (remove zeros à esquerda em dia/mês para comparação mais “humana”)
  function norm(s){ return s.replace(/^0/,'').replace(/\/0/,'/'); }
  if (norm(got.from) !== norm(fromStr) || norm(got.to) !== norm(toStr)) {
    dlog('Aviso: período lido difere do esperado', got, { fromStr, toStr });
    // Nem sempre é erro: às vezes o produto “corrige” para a janela válida.
  }

  // Espera a tela atualizar KPIs/tabela
  await page.waitForTimeout(600);
  return true;
}
