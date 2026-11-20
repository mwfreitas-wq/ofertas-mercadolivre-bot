/**
 * =========================================================================
 * RADAR DE OFERTAS MULTI-LOJA (MERCADO LIVRE + SHOPEE + CUPONS VERIFICADOS)
 * Google Apps Script (Google Sheets + Groq API + Telegram Bot)
 * =========================================================================
 *
 * INSTRUÇÕES:
 * 1. Preencha as 4 constantes abaixo (NO EDITOR DO APPS SCRIPT — nunca suba chaves reais no GitHub público).
 * 2. Execute 'setupPlanilha()' uma vez para criar/atualizar as abas 'Fila' e 'Cupons'.
 * 3. Em Implantar > Gerenciar implantações > Editar > Nova versão > Implantar.
 * 4. Crie um Acionador (Trigger) por tempo para 'dispararProximaOferta' (A cada hora).
 *    - Ele respeita automaticamente o horário de Brasília (08h às 22h) para não incomodar de madrugada!
 */

// ========================== CONFIGURAÇÕES ==========================
const TELEGRAM_BOT_TOKEN = "SEU_TELEGRAM_BOT_TOKEN_AQUI"; // Configure apenas no Google Apps Script
const TELEGRAM_CHANNEL_ID = "@ofertas_mercadolivre_cupom"; // Canal público do Telegram
const GROQ_API_KEY = "gsk_SEU_GROQ_API_KEY_AQUI";          // Configure apenas no Google Apps Script
const WEBAPP_URL = "SUA_WEBAPP_URL_AQUI";                  // URL /exec da Implantação do Web App

const SHEET_NAME = "Fila";
const COUPONS_SHEET_NAME = "Cupons";

// Janela de disparos automáticos (Horário de Brasília)
const HORARIO_INICIO = 8;  // 08:00
const HORARIO_FIM = 22;    // 22:59
// ===================================================================

/**
 * Cria e atualiza automaticamente as abas 'Fila' e 'Cupons'
 */
function setupPlanilha() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();

  // 1. Aba Fila (10 colunas)
  let sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(SHEET_NAME);
  }

  const headersFila = [
    "ID",
    "Titulo",
    "Preco_Antigo",
    "Preco_Atual",
    "Imagem_URL",
    "Link_Afiliado",
    "Status",
    "Data_Hora",
    "Loja",
    "Cupom"
  ];

  sheet.getRange(1, 1, 1, headersFila.length).setValues([headersFila]);
  sheet.getRange(1, 1, 1, headersFila.length)
    .setFontWeight("bold")
    .setBackground("#FFE600")
    .setFontColor("#2D3277")
    .setHorizontalAlignment("center");
  sheet.setFrozenRows(1);

  // 2. Aba Cupons Confiáveis (7 colunas)
  let couponSheet = ss.getSheetByName(COUPONS_SHEET_NAME);
  if (!couponSheet) {
    couponSheet = ss.insertSheet(COUPONS_SHEET_NAME);
  }

  const headersCupons = [
    "Loja",
    "Codigo",
    "Descricao",
    "Valor_Minimo",
    "Fonte_Confiavel",
    "Validade",
    "Ativo"
  ];

  couponSheet.getRange(1, 1, 1, headersCupons.length).setValues([headersCupons]);
  couponSheet.getRange(1, 1, 1, headersCupons.length)
    .setFontWeight("bold")
    .setBackground("#2D3277")
    .setFontColor("#FFFFFF")
    .setHorizontalAlignment("center");
  couponSheet.setFrozenRows(1);

  Logger.log("✅ Abas '" + SHEET_NAME + "' e '" + COUPONS_SHEET_NAME + "' configuradas com sucesso!");
  return "Planilha configurada com sucesso!";
}

/**
 * Vincula o Webhook do Telegram à URL deste Web App
 */
function configurarWebhookTelegram() {
  if (!TELEGRAM_BOT_TOKEN || TELEGRAM_BOT_TOKEN.includes("SEU_TELEGRAM_BOT_TOKEN")) {
    throw new Error("❌ Preencha TELEGRAM_BOT_TOKEN antes de vincular o webhook!");
  }
  if (!WEBAPP_URL || WEBAPP_URL.includes("SUA_WEBAPP_URL")) {
    throw new Error("❌ Preencha WEBAPP_URL antes de vincular o webhook!");
  }

  const url = "https://api.telegram.org/bot" + TELEGRAM_BOT_TOKEN + "/setWebhook?url=" + encodeURIComponent(WEBAPP_URL) + "&drop_pending_updates=true";
  const response = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
  const result = JSON.parse(response.getContentText());

  if (result.ok) {
    Logger.log("🎉 Webhook vinculado com sucesso: " + result.description);
    return "Webhook vinculado: " + result.description;
  } else {
    throw new Error(result.description || response.getContentText());
  }
}

/**
 * Endpoint POST híbrido:
 * 1. Recebe ofertas + cupons verificados do scraper (PC / GitHub Actions / HostGator)
 * 2. Recebe links manuais do Telegram (Mercado Livre ou Shopee, com ou sem cupom)
 */
function doPost(e) {
  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(15000);
  } catch (err) {
    return HtmlService.createHtmlOutput("BUSY");
  }

  try {
    if (!e || !e.postData || !e.postData.contents) {
      return HtmlService.createHtmlOutput("EMPTY");
    }

    const payload = JSON.parse(e.postData.contents);

    // =========================================================================
    // CASO A: Lote vindo do Scraper (Mercado Livre + Shopee + Cupons Verificados)
    // =========================================================================
    if (payload.source === "github_scraper") {
      const sheet = getFilaSheet();
      const existingIds = getExistingProductIds(sheet);
      const rowsToAdd = [];

      // 1. Atualiza cupons verificados se vierem no lote
      let insertedCoupons = 0;
      if (Array.isArray(payload.coupons) && payload.coupons.length > 0) {
        insertedCoupons = salvarCuponsVerificados(payload.coupons);
      }

      // 2. Insere novos produtos sem duplicar
      if (Array.isArray(payload.items)) {
        payload.items.forEach(function(item) {
          const id = String(item.id || "").trim();
          if (id && !existingIds.has(id)) {
            existingIds.add(id);
            const store = item.store || detectarLojaPorUrl(item.affiliateUrl || item.cleanUrl || "");
            rowsToAdd.push([
              id,
              item.title || "Oferta Especial",
              item.oldPrice || "",
              item.price || "Confira",
              item.image || "",
              item.affiliateUrl || item.cleanUrl || "",
              "PENDENTE",
              new Date().toISOString(),
              store,
              item.coupon || ""
            ]);
          }
        });
      }

      if (rowsToAdd.length > 0) {
        const lastRow = sheet.getLastRow();
        sheet.getRange(lastRow + 1, 1, rowsToAdd.length, 10).setValues(rowsToAdd);
      }

      return ContentService.createTextOutput(JSON.stringify({
        status: "success",
        receivedItems: Array.isArray(payload.items) ? payload.items.length : 0,
        insertedItems: rowsToAdd.length,
        insertedCoupons: insertedCoupons
      })).setMimeType(ContentService.MimeType.JSON);
    }

    // =========================================================================
    // CASO B: Mensagem manual do Telegram (Mercado Livre OU Shopee)
    // Dica: você pode mandar o link + "CUPOM: CODIGO" na mesma mensagem!
    // =========================================================================
    if (payload.message && payload.message.text) {
      const text = payload.message.text.trim();
      const chatId = payload.message.chat.id;

      // Aceita links do Mercado Livre e da Shopee
      const urlRegex = /(https?:\/\/[^\s]*(?:mercadolivre|meli\.la|\/sec\/|shopee\.com\.br|s\.shopee\.com\.br|shope\.ee)[^\s]*)/i;
      const match = text.match(urlRegex);

      if (match) {
        const rawUrl = match[1];
        const store = detectarLojaPorUrl(rawUrl);

        // Verifica se o usuário informou um cupom na mensagem (ex: "CUPOM: MELI15")
        let manualCoupon = "";
        const couponMatch = text.match(/cupom[:\s]+([A-Z0-9_-]{3,25})/i);
        if (couponMatch && couponMatch[1]) {
          manualCoupon = couponMatch[1].toUpperCase();
        }

        enviarMensagemTelegram(chatId, "⏳ <i>Link da <b>" + store + "</b> identificado! Extraindo dados e preparando publicação prioritária...</i>");

        const productData = extrairDadosOpenGraph(rawUrl, store);
        const sheet = getFilaSheet();

        sheet.appendRow([
          productData.id,
          productData.title,
          productData.oldPrice,
          productData.price,
          productData.image,
          productData.url,
          "PRIORIDADE",
          new Date().toISOString(),
          store,
          manualCoupon
        ]);

        // Dispara imediatamente ignorando a trava de horário noturno
        const resultadoDisparo = dispararProximaOferta(true);

        if (resultadoDisparo.sucesso) {
          let msgOk = "🚀 <b>Oferta publicada com sucesso no canal!</b>\n\n🏪 <b>Loja:</b> " + store + "\n📌 <b>Item:</b> " + productData.title;
          if (resultadoDisparo.cupomUsado) {
            msgOk += "\n🎟️ <b>Cupom aplicado:</b> <code>" + resultadoDisparo.cupomUsado + "</code>";
          }
          enviarMensagemTelegram(chatId, msgOk);
        } else {
          enviarMensagemTelegram(chatId, "⚠️ <b>Produto salvo na planilha, mas o envio ao canal falhou.</b>\n\n<b>Motivo:</b> " + (resultadoDisparo.motivo || "Verifique se o bot é administrador do canal."));
        }

        return HtmlService.createHtmlOutput("OK");
      } else {
        enviarMensagemTelegram(
          chatId,
          "👋 Olá! Envie um link do <b>Mercado Livre</b> ou da <b>Shopee</b> e eu publico na hora no canal.\n\n💡 <i>Dica: se tiver cupom, envie junto assim:</i>\n<code>https://link... CUPOM: MEUCUPOM</code>"
        );
        return HtmlService.createHtmlOutput("OK");
      }
    }

    return HtmlService.createHtmlOutput("OK");
  } catch (error) {
    Logger.log("Erro no doPost: " + error.toString());
    return HtmlService.createHtmlOutput("ERROR: " + error.toString());
  } finally {
    lock.releaseLock();
  }
}

/**
 * Endpoint GET: Retorna os últimos 60 itens PUBLICADOS para a Vitrine Web
 */
function doGet(e) {
  try {
    const sheet = getFilaSheet();
    const lastRow = sheet.getLastRow();

    if (lastRow <= 1) {
      return ContentService.createTextOutput(JSON.stringify([]))
        .setMimeType(ContentService.MimeType.JSON);
    }

    const totalCols = Math.max(sheet.getLastColumn(), 10);
    const values = sheet.getRange(2, 1, lastRow - 1, totalCols).getValues();
    const publishedItems = [];

    for (let i = values.length - 1; i >= 0; i--) {
      const row = values[i];
      const status = String(row[6] || "").trim().toUpperCase();

      if (status === "PUBLICADO") {
        const url = row[5] || "";
        const store = (row[8] && String(row[8]).trim()) ? String(row[8]).trim() : detectarLojaPorUrl(url);
        publishedItems.push({
          id: row[0],
          title: row[1],
          oldPrice: row[2] || null,
          price: row[3] || "Confira",
          image: row[4] || "",
          affiliateUrl: url,
          publishedAt: row[7] || "",
          store: store,
          coupon: row[9] ? String(row[9]).trim() : ""
        });

        if (publishedItems.length >= 60) break;
      }
    }

    return ContentService.createTextOutput(JSON.stringify(publishedItems))
      .setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    return ContentService.createTextOutput(JSON.stringify({ error: err.toString() }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

/**
 * Dispara a próxima oferta da fila (Trigger de 1 em 1 hora ou disparo imediato).
 * @param {boolean} ignorarHorario Se true, publica fora da janela 08h-22h (usado em envios manuais).
 */
function dispararProximaOferta(ignorarHorario) {
  // 1. Trava de horário de Brasília (08h às 22h) para disparos automáticos
  if (!ignorarHorario) {
    const horaBrasilia = Number(Utilities.formatDate(new Date(), "America/Sao_Paulo", "H"));
    if (horaBrasilia < HORARIO_INICIO || horaBrasilia > HORARIO_FIM) {
      Logger.log("🌙 Fora do horário comercial (" + horaBrasilia + "h BRT). Próximo disparo às " + HORARIO_INICIO + "h.");
      return { sucesso: false, motivo: "Fora do horário permitido (" + HORARIO_INICIO + "h às " + HORARIO_FIM + "h)" };
    }
  }

  const sheet = getFilaSheet();
  const lastRow = sheet.getLastRow();
  if (lastRow <= 1) {
    Logger.log("Nenhuma oferta encontrada na planilha.");
    return { sucesso: false, motivo: "Fila vazia" };
  }

  const totalCols = Math.max(sheet.getLastColumn(), 10);
  const values = sheet.getRange(2, 1, lastRow - 1, totalCols).getValues();
  let selectedRowIndex = -1;

  // Prioridade primeiro
  for (let i = 0; i < values.length; i++) {
    if (String(values[i][6]).trim().toUpperCase() === "PRIORIDADE") {
      selectedRowIndex = i;
      break;
    }
  }

  // Primeira pendente
  if (selectedRowIndex === -1) {
    for (let i = 0; i < values.length; i++) {
      if (String(values[i][6]).trim().toUpperCase() === "PENDENTE") {
        selectedRowIndex = i;
        break;
      }
    }
  }

  if (selectedRowIndex === -1) {
    Logger.log("ℹ️ Nenhuma oferta pendente ou prioritária na fila.");
    return { sucesso: false, motivo: "Nenhuma oferta pendente" };
  }

  const rowNumber = selectedRowIndex + 2;
  const row = values[selectedRowIndex];
  const url = row[5] || "";
  const store = (row[8] && String(row[8]).trim()) ? String(row[8]).trim() : detectarLojaPorUrl(url);
  let couponText = row[9] ? String(row[9]).trim() : "";

  // Busca cupom verificado na aba 'Cupons' caso o item não tenha cupom próprio
  let couponObj = null;
  if (!couponText) {
    couponObj = buscarMelhorCupomVerificado(store, row[3]);
    if (couponObj) {
      couponText = couponObj.codigo;
    }
  }

  const item = {
    id: row[0],
    title: row[1],
    oldPrice: row[2],
    price: row[3],
    image: row[4],
    affiliateUrl: url,
    store: store,
    coupon: couponText,
    couponDescription: couponObj ? couponObj.descricao : ""
  };

  Logger.log("🎯 Publicando [" + item.store + "] " + item.id + " - " + item.title + (item.coupon ? " | Cupom: " + item.coupon : ""));

  const copy = gerarCopyPersuasivaGroq(item);
  const resultadoEnvio = publicarNoCanalTelegram(item, copy);

  if (resultadoEnvio.ok) {
    sheet.getRange(rowNumber, 7).setValue("PUBLICADO");
    sheet.getRange(rowNumber, 8).setValue(new Date().toISOString());
    sheet.getRange(rowNumber, 9).setValue(item.store);
    if (item.coupon) {
      sheet.getRange(rowNumber, 10).setValue(item.coupon);
    }
    Logger.log("✅ Item " + item.id + " marcado como PUBLICADO.");
    return { sucesso: true, item: item, cupomUsado: item.coupon };
  } else {
    Logger.log("❌ Falha no envio ao Telegram: " + resultadoEnvio.description);
    return { sucesso: false, motivo: resultadoEnvio.description };
  }
}

/**
 * Procura o melhor cupom ATIVO, VERIFICADO e COMPATÍVEL com o valor do produto na aba 'Cupons'
 */
function buscarMelhorCupomVerificado(loja, precoStr) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const couponSheet = ss.getSheetByName(COUPONS_SHEET_NAME);
  if (!couponSheet || couponSheet.getLastRow() <= 1) return null;

  const precoNum = parsePrecoBR(precoStr);
  const hoje = new Date();
  const rows = couponSheet.getRange(2, 1, couponSheet.getLastRow() - 1, 7).getValues();

  let melhor = null;

  for (let i = 0; i < rows.length; i++) {
    const rLoja = String(rows[i][0] || "").trim().toLowerCase();
    const rCodigo = String(rows[i][1] || "").trim();
    const rDesc = String(rows[i][2] || "").trim();
    const rMinimo = Number(rows[i][3] || 0);
    const rValidade = rows[i][5];
    const rAtivo = String(rows[i][6] || "").trim().toUpperCase();

    if (!rCodigo || rAtivo !== "SIM") continue;
    if (rLoja !== loja.toLowerCase()) continue;

    // Checa validade se preenchida
    if (rValidade) {
      const dataVal = new Date(rValidade);
      if (!isNaN(dataVal.getTime()) && dataVal < hoje) continue;
    }

    // Checa valor mínimo compatível com o produto
    if (rMinimo > 0 && precoNum > 0 && precoNum < rMinimo) continue;

    // Prefere o cupom com maior valor mínimo aplicável (normalmente dá maior desconto)
    if (!melhor || rMinimo >= melhor.valorMinimo) {
      melhor = {
        codigo: rCodigo,
        descricao: rDesc,
        valorMinimo: rMinimo
      };
    }
  }

  return melhor;
}

/**
 * Salva cupons verificados vindos do scraper na aba 'Cupons' sem duplicar
 */
function salvarCuponsVerificados(coupons) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let couponSheet = ss.getSheetByName(COUPONS_SHEET_NAME);
  if (!couponSheet) {
    setupPlanilha();
    couponSheet = ss.getSheetByName(COUPONS_SHEET_NAME);
  }

  const existing = new Set();
  const lastRow = couponSheet.getLastRow();
  if (lastRow > 1) {
    const vals = couponSheet.getRange(2, 1, lastRow - 1, 2).getValues();
    vals.forEach(function(r) {
      existing.add((String(r[0]).trim() + "|" + String(r[1]).trim()).toUpperCase());
    });
  }

  const toAdd = [];
  const validadePadrao = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000); // +5 dias

  coupons.forEach(function(c) {
    const key = (String(c.store || "") + "|" + String(c.code || "")).toUpperCase();
    if (c.code && !existing.has(key)) {
      existing.add(key);
      toAdd.push([
        c.store || "Mercado Livre",
        String(c.code).trim().toUpperCase(),
        c.description || "Cupom verificado",
        Number(c.minValue || 0),
        c.source || "Verificado",
        Utilities.formatDate(validadePadrao, "America/Sao_Paulo", "yyyy-MM-dd"),
        "SIM"
      ]);
    }
  });

  if (toAdd.length > 0) {
    couponSheet.getRange(couponSheet.getLastRow() + 1, 1, toAdd.length, 7).setValues(toAdd);
  }
  return toAdd.length;
}

/**
 * Gera texto persuasivo com Groq AI (llama-3.3-70b-versatile) incluindo cupom copiável
 */
function gerarCopyPersuasivaGroq(item) {
  if (!GROQ_API_KEY || GROQ_API_KEY.includes("SEU_GROQ_API_KEY")) {
    return formatarCopyFallback(item);
  }

  try {
    const blocoCupom = item.coupon
      ? `- Cupom Verificado: ${item.coupon}${item.couponDescription ? " (" + item.couponDescription + ")" : ""}`
      : "- Cupom: Nenhum";

    const prompt = `Você é um copywriter especialista em canais de ofertas e cupons do Telegram no Brasil.
Crie uma copy curta, direta e persuasiva para o produto abaixo.

DADOS DO PRODUTO:
- Loja: ${item.store}
- Título: ${item.title}
- Preço Original: ${item.oldPrice || "Não informado"}
- Preço Atual: ${item.price}
${blocoCupom}

REGRAS OBRIGATÓRIAS:
1. Comece indicando a loja com emoji (🟡 Mercado Livre ou 🟠 Shopee) e urgência.
2. Se houver preço original, use <s>${item.oldPrice}</s> e destaque o preço atual com <b>${item.price}</b>.
3. SE HOUVER CUPOM, inclua uma linha bem destacada com 🎟️ Use o cupom: <code>${item.coupon}</code> (toque para copiar!).
4. Use APENAS tags HTML válidas do Telegram: <b>, <i>, <s>, <code>. NUNCA use Markdown (* ou _).
5. NÃO inclua link nem escreva "clique aqui", pois haverá botão oficial abaixo.
6. Máximo de 550 caracteres. Retorne APENAS o texto final.`;

    const response = UrlFetchApp.fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "post",
      contentType: "application/json",
      headers: { "Authorization": "Bearer " + GROQ_API_KEY },
      payload: JSON.stringify({
        model: "llama-3.3-70b-versatile",
        messages: [
          { role: "system", content: "Você gera copies promocionais em HTML puro para Telegram." },
          { role: "user", content: prompt }
        ],
        temperature: 0.7,
        max_tokens: 320
      }),
      muteHttpExceptions: true
    });

    const json = JSON.parse(response.getContentText());
    if (json.choices && json.choices.length > 0) {
      let copyText = sanitizarHtmlTelegram(json.choices[0].message.content.trim());
      // Garante que o cupom sempre apareça copiável caso a IA esqueça
      if (item.coupon && copyText.indexOf(item.coupon) === -1) {
        copyText += "\n\n🎟️ <b>Cupom verificado:</b> <code>" + item.coupon + "</code> <i>(toque para copiar)</i>";
      }
      return copyText;
    }
  } catch (err) {
    Logger.log("⚠️ Erro na Groq API, usando fallback: " + err.toString());
  }

  return formatarCopyFallback(item);
}

function formatarCopyFallback(item) {
  const badge = item.store === "Shopee" ? "🟠 <b>OFERTA SHOPEE!</b>" : "🟡 <b>OFERTA MERCADO LIVRE!</b>";
  let copy = badge + "\n\n📦 <b>" + item.title + "</b>\n\n";
  if (item.oldPrice && item.oldPrice !== item.price) {
    copy += "❌ De: <s>" + item.oldPrice + "</s>\n";
  }
  copy += "💥 <b>Por: " + item.price + "</b>";
  if (item.coupon) {
    copy += "\n\n🎟️ <b>Use o cupom:</b> <code>" + item.coupon + "</code> <i>(toque para copiar)</i>";
  }
  copy += "\n\n⚡ <i>Preço e cupom sujeitos a alteração sem aviso!</i>";
  return copy;
}

function sanitizarHtmlTelegram(html) {
  let cleaned = html
    .replace(/\*\*(.*?)\*\*/g, "<b>$1</b>")
    .replace(/__(.*?)__/g, "<i>$1</i>")
    .replace(/~~(.*?)~~/g, "<s>$1</s>");
  if (cleaned.length > 1000) cleaned = cleaned.substring(0, 990) + "...";
  return cleaned;
}

/**
 * Publica no Canal do Telegram com foto + botão inline dinâmico por loja
 */
function publicarNoCanalTelegram(item, copyText) {
  const buttonText = item.store === "Shopee"
    ? "🛍️ COMPRAR NA SHOPEE"
    : "🛒 COMPRAR NO MERCADO LIVRE";

  const inlineKeyboard = {
    inline_keyboard: [[{ text: buttonText, url: item.affiliateUrl || "https://www.mercadolivre.com.br" }]]
  };

  if (item.image && item.image.startsWith("http")) {
    try {
      const response = UrlFetchApp.fetch("https://api.telegram.org/bot" + TELEGRAM_BOT_TOKEN + "/sendPhoto", {
        method: "post",
        contentType: "application/json",
        payload: JSON.stringify({
          chat_id: TELEGRAM_CHANNEL_ID,
          photo: item.image,
          caption: copyText,
          parse_mode: "HTML",
          reply_markup: JSON.stringify(inlineKeyboard)
        }),
        muteHttpExceptions: true
      });
      const resJson = JSON.parse(response.getContentText());
      if (resJson.ok) return { ok: true };
      Logger.log("⚠️ sendPhoto falhou (" + resJson.description + "), tentando sendMessage...");
    } catch (err) {
      Logger.log("⚠️ Exceção sendPhoto: " + err.toString());
    }
  }

  try {
    const response = UrlFetchApp.fetch("https://api.telegram.org/bot" + TELEGRAM_BOT_TOKEN + "/sendMessage", {
      method: "post",
      contentType: "application/json",
      payload: JSON.stringify({
        chat_id: TELEGRAM_CHANNEL_ID,
        text: copyText,
        parse_mode: "HTML",
        reply_markup: JSON.stringify(inlineKeyboard),
        disable_web_page_preview: false
      }),
      muteHttpExceptions: true
    });
    const resJson = JSON.parse(response.getContentText());
    return resJson.ok ? { ok: true } : { ok: false, description: resJson.description || "Erro Telegram" };
  } catch (err) {
    return { ok: false, description: err.toString() };
  }
}

function enviarMensagemTelegram(chatId, text) {
  try {
    UrlFetchApp.fetch("https://api.telegram.org/bot" + TELEGRAM_BOT_TOKEN + "/sendMessage", {
      method: "post",
      contentType: "application/json",
      payload: JSON.stringify({ chat_id: chatId, text: text, parse_mode: "HTML" }),
      muteHttpExceptions: true
    });
  } catch (e) {
    Logger.log("Erro envio direto Telegram: " + e.toString());
  }
}

function extrairDadosOpenGraph(url, store) {
  const isShopee = store === "Shopee";
  const result = {
    id: (isShopee ? "SHP-MANUAL-" : "MLB-MANUAL-") + new Date().getTime(),
    title: isShopee ? "Oferta Shopee" : "Oferta Mercado Livre",
    oldPrice: "",
    price: "Confira na loja",
    image: isShopee
      ? "https://deo.shopeemobile.com/shopee/shopee-pcmall-live-sg/assets/ca5d12864c12916c05640b36e47ac5c9.png"
      : "https://http2.mlstatic.com/frontend-assets/ui-navigation/5.19.5/mercadolibre/logo__large_plus.png",
    url: url
  };

  try {
    const mlbMatch = url.match(/(ML[A-Z]?-?\d+)/i);
    if (mlbMatch) result.id = mlbMatch[1].replace("-", "").toUpperCase();

    const html = UrlFetchApp.fetch(url, {
      muteHttpExceptions: true,
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
        "Accept-Language": "pt-BR,pt;q=0.9"
      }
    }).getContentText();

    const titleMatch = html.match(/<meta\s+property=["']og:title["']\s+content=["'](.*?)["']/i) ||
                       html.match(/<title>(.*?)<\/title>/i);
    if (titleMatch && titleMatch[1]) {
      result.title = decodeHtmlEntities(titleMatch[1].trim());
    }

    const imageMatch = html.match(/<meta\s+property=["']og:image["']\s+content=["'](.*?)["']/i);
    if (imageMatch && imageMatch[1]) {
      result.image = imageMatch[1].trim();
    }

    const priceMatch = html.match(/<meta\s+property=["']product:price:amount["']\s+content=["'](.*?)["']/i) ||
                       html.match(/class=["'][^"']*andes-money-amount__fraction[^"']*["']>([\d.]+)</i);
    if (priceMatch && priceMatch[1]) {
      const val = priceMatch[1].trim();
      result.price = "R$ " + (val.includes(",") ? val : val + ",00");
    }
  } catch (err) {
    Logger.log("Erro OpenGraph: " + err.toString());
  }

  return result;
}

function detectarLojaPorUrl(url) {
  if (/shopee|shope\.ee/i.test(String(url || ""))) return "Shopee";
  return "Mercado Livre";
}

function parsePrecoBR(str) {
  if (!str) return 0;
  const clean = String(str).replace(/[^\d,]/g, "").replace(",", ".");
  return parseFloat(clean) || 0;
}

function decodeHtmlEntities(str) {
  return str
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function getFilaSheet() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) {
    setupPlanilha();
    sheet = ss.getSheetByName(SHEET_NAME);
  }
  return sheet;
}

function getExistingProductIds(sheet) {
  const ids = new Set();
  const lastRow = sheet.getLastRow();
  if (lastRow > 1) {
    const values = sheet.getRange(2, 1, lastRow - 1, 1).getValues();
    values.forEach(function(row) {
      if (row[0]) ids.add(String(row[0]).trim());
    });
  }
  return ids;
}
