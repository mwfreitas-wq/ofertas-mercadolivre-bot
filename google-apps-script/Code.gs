/**
 * =========================================================================
 * SISTEMA AUTÔNOMO DE OFERTAS MERCADO LIVRE AFILIADOS
 * Google Apps Script (Google Sheets + Groq API + Telegram Bot)
 * =========================================================================
 * 
 * INSTRUÇÕES:
 * 1. Preencha as 4 constantes abaixo com seus dados.
 * 2. Execute 'setupPlanilha()' uma vez para criar as colunas.
 * 3. Faça a implantação como Web App (Executar como: Eu / Acesso: Qualquer pessoa).
 * 4. Copie a URL do Web App, cole em WEBAPP_URL e execute 'configurarWebhookTelegram()'.
 * 5. Crie um Acionador (Trigger) por tempo para 'dispararProximaOferta' (de 1 em 1 hora).
 */

// ========================== CONFIGURAÇÕES ==========================
const TELEGRAM_BOT_TOKEN = "SEU_TELEGRAM_BOT_TOKEN_AQUI"; // Configure apenas no Google Apps Script
const TELEGRAM_CHANNEL_ID = "@ofertas_mercadolivre_cupom"; // Canal público do Telegram
const GROQ_API_KEY = "gsk_SEU_GROQ_API_KEY_AQUI";          // Configure apenas no Google Apps Script
const WEBAPP_URL = "SUA_WEBAPP_URL_AQUI";                  // URL gerada na Implantação (Deploy) do Web App
const SHEET_NAME = "Fila";
// ===================================================================

/**
 * Cria e configura automaticamente a aba 'Fila' na planilha ativa
 */
function setupPlanilha() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(SHEET_NAME);
  
  if (!sheet) {
    sheet = ss.insertSheet(SHEET_NAME);
  }

  const headers = [
    "ID",
    "Titulo",
    "Preco_Antigo",
    "Preco_Atual",
    "Imagem_URL",
    "Link_Afiliado",
    "Status",
    "Data_Hora"
  ];

  const currentHeaders = sheet.getRange(1, 1, 1, headers.length).getValues()[0];
  const isSetupDone = headers.every((h, idx) => currentHeaders[idx] === h);

  if (!isSetupDone) {
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
    sheet.getRange(1, 1, 1, headers.length)
      .setFontWeight("bold")
      .setBackground("#FFE600") // Amarelo característico do Mercado Livre
      .setFontColor("#2D3277")
      .setHorizontalAlignment("center");
    
    sheet.setFrozenRows(1);
    sheet.autoResizeColumns(1, headers.length);
  }

  Logger.log("✅ Aba '" + SHEET_NAME + "' configurada com sucesso!");
  return "Aba configurada com sucesso!";
}

/**
 * Vincula o Webhook do Telegram à URL deste Web App
 */
function configurarWebhookTelegram() {
  if (!TELEGRAM_BOT_TOKEN || TELEGRAM_BOT_TOKEN.includes("SEU_TELEGRAM_BOT_TOKEN")) {
    throw new Error("❌ Preencha TELEGRAM_BOT_TOKEN antes de vincular o webhook!");
  }
  if (!WEBAPP_URL || WEBAPP_URL.includes("SUA_WEBAPP_URL")) {
    throw new Error("❌ Preencha WEBAPP_URL com a URL da sua implantação Web App antes de continuar!");
  }

  const url = "https://api.telegram.org/bot" + TELEGRAM_BOT_TOKEN + "/setWebhook?url=" + encodeURIComponent(WEBAPP_URL);
  const response = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
  const result = JSON.parse(response.getContentText());

  if (result.ok) {
    Logger.log("🎉 Webhook vinculado com sucesso ao Telegram: " + result.description);
    return "Webhook vinculado: " + result.description;
  } else {
    Logger.log("❌ Erro ao configurar webhook: " + response.getContentText());
    throw new Error(result.description);
  }
}

/**
 * Endpoint POST híbrido:
 * 1. Recebe ofertas do Scraper do GitHub Actions
 * 2. Recebe mensagens diretas enviadas ao Bot no Telegram
 */
function doPost(e) {
  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(15000);
  } catch (err) {
    return ContentService.createTextOutput(JSON.stringify({ status: "error", message: "Servidor ocupado" }))
      .setMimeType(ContentService.MimeType.JSON);
  }

  try {
    if (!e || !e.postData || !e.postData.contents) {
      return ContentService.createTextOutput(JSON.stringify({ status: "error", message: "Nenhum dado recebido" }))
        .setMimeType(ContentService.MimeType.JSON);
    }

    const payload = JSON.parse(e.postData.contents);

    // =========================================================================
    // CASO A: Lote vindo do Scraper do GitHub Actions
    // =========================================================================
    if (payload.source === "github_scraper" && Array.isArray(payload.items)) {
      const sheet = getFilaSheet();
      const existingIds = getExistingProductIds(sheet);
      const rowsToAdd = [];

      payload.items.forEach(function(item) {
        const id = String(item.id || "").trim();
        if (id && !existingIds.has(id)) {
          existingIds.add(id);
          rowsToAdd.push([
            id,
            item.title || "Oferta Especial",
            item.oldPrice || "",
            item.price || "Confira",
            item.image || "",
            item.affiliateUrl || item.cleanUrl || "",
            "PENDENTE",
            new Date().toISOString()
          ]);
        }
      });

      if (rowsToAdd.length > 0) {
        const lastRow = sheet.getLastRow();
        sheet.getRange(lastRow + 1, 1, rowsToAdd.length, 8).setValues(rowsToAdd);
      }

      return ContentService.createTextOutput(JSON.stringify({
        status: "success",
        received: payload.items.length,
        inserted: rowsToAdd.length
      })).setMimeType(ContentService.MimeType.JSON);
    }

    // =========================================================================
    // CASO B: Mensagem manual do Telegram com link do Mercado Livre
    // =========================================================================
    if (payload.message && payload.message.text) {
      const text = payload.message.text.trim();
      const chatId = payload.message.chat.id;

      // Regex para identificar links do Mercado Livre
      const urlRegex = /(https?:\/\/[^\s]+mercadolivre[^\s]*|https?:\/\/meli\.la\/[^\s]+|https?:\/\/[^\s]*\/sec\/[^\s]+)/i;
      const match = text.match(urlRegex);

      if (match) {
        const rawUrl = match[1];
        enviarMensagemTelegram(chatId, "⏳ <i>Identifiquei seu link do Mercado Livre! Extraindo dados e preparando publicação prioritária...</i>");

        const productData = extrairDadosOpenGraph(rawUrl);
        const sheet = getFilaSheet();

        sheet.appendRow([
          productData.id,
          productData.title,
          productData.oldPrice,
          productData.price,
          productData.image,
          productData.url,
          "PRIORIDADE",
          new Date().toISOString()
        ]);

        // Dispara imediatamente o envio da oferta com prioridade
        const resultadoDisparo = dispararProximaOferta();

        if (resultadoDisparo.sucesso) {
          enviarMensagemTelegram(chatId, "🚀 <b>Oferta publicada com sucesso no canal!</b>\n\n📌 <b>Item:</b> " + productData.title);
        } else {
          enviarMensagemTelegram(chatId, "⚠️ <b>Atenção:</b> O produto foi salvo na planilha, mas a publicação no canal falhou.\n\n<b>Motivo:</b> " + (resultadoDisparo.motivo || "Verifique se o bot é administrador do canal"));
        }

        return HtmlService.createHtmlOutput("OK");
      } else {
        enviarMensagemTelegram(chatId, "👋 Olá! Envie-me o link de um produto do <b>Mercado Livre</b> e publicarei imediatamente no canal de ofertas.");
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
 * Endpoint GET: Retorna os últimos 60 itens com status 'PUBLICADO' para a Vitrine Web
 */
function doGet(e) {
  try {
    const sheet = getFilaSheet();
    const lastRow = sheet.getLastRow();
    
    if (lastRow <= 1) {
      return ContentService.createTextOutput(JSON.stringify([]))
        .setMimeType(ContentService.MimeType.JSON);
    }

    // Colunas: 1=ID, 2=Titulo, 3=Preco_Antigo, 4=Preco_Atual, 5=Imagem_URL, 6=Link_Afiliado, 7=Status, 8=Data_Hora
    const values = sheet.getRange(2, 1, lastRow - 1, 8).getValues();
    const publishedItems = [];

    // Itera do mais recente para o mais antigo
    for (let i = values.length - 1; i >= 0; i--) {
      const row = values[i];
      const status = String(row[6]).trim().toUpperCase();

      if (status === "PUBLICADO") {
        publishedItems.push({
          id: row[0],
          title: row[1],
          oldPrice: row[2] || null,
          price: row[3] || "Confira",
          image: row[4] || "",
          affiliateUrl: row[5] || "",
          publishedAt: row[7] || ""
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
 * Dispara a próxima oferta da fila.
 * Procura primeiro 'PRIORIDADE'; se não encontrar, pega a primeira 'PENDENTE'.
 * Chamada pelo Acionador (Trigger) a cada 1 hora ou manualmente.
 */
function dispararProximaOferta() {
  const sheet = getFilaSheet();
  const lastRow = sheet.getLastRow();
  if (lastRow <= 1) {
    Logger.log("Nenhuma linha encontrada na planilha.");
    return false;
  }

  const values = sheet.getRange(2, 1, lastRow - 1, 8).getValues();
  let selectedRowIndex = -1; // 0-based relativo a values

  // 1. Busca prioridade primeiro
  for (let i = 0; i < values.length; i++) {
    if (String(values[i][6]).trim().toUpperCase() === "PRIORIDADE") {
      selectedRowIndex = i;
      break;
    }
  }

  // 2. Se não houver prioridade, busca a primeira pendente
  if (selectedRowIndex === -1) {
    for (let i = 0; i < values.length; i++) {
      if (String(values[i][6]).trim().toUpperCase() === "PENDENTE") {
        selectedRowIndex = i;
        break;
      }
    }
  }

  if (selectedRowIndex === -1) {
    Logger.log("ℹ️ Nenhuma oferta pendente ou prioritária encontrada na fila.");
    return false;
  }

  const rowNumber = selectedRowIndex + 2; // Linha real no Google Sheets
  const item = {
    id: values[selectedRowIndex][0],
    title: values[selectedRowIndex][1],
    oldPrice: values[selectedRowIndex][2],
    price: values[selectedRowIndex][3],
    image: values[selectedRowIndex][4],
    affiliateUrl: values[selectedRowIndex][5]
  };

  Logger.log("🎯 Processando publicação do item: " + item.id + " - " + item.title);

  // 3. Gera copy persuasiva na API da Groq (Llama-3.3-70b-versatile)
  const copy = gerarCopyPersuasivaGroq(item);

  // 4. Envia mensagem formatada para o Canal do Telegram
  const resultadoEnvio = publicarNoCanalTelegram(item, copy);

  if (resultadoEnvio.ok) {
    // 5. Atualiza status para PUBLICADO
    sheet.getRange(rowNumber, 7).setValue("PUBLICADO");
    sheet.getRange(rowNumber, 8).setValue(new Date().toISOString());
    Logger.log("✅ Item " + item.id + " marcado como PUBLICADO.");
    return { sucesso: true, item: item };
  } else {
    Logger.log("❌ Falha no envio ao Telegram para o item " + item.id + ": " + resultadoEnvio.description);
    return { sucesso: false, motivo: resultadoEnvio.description };
  }
}

/**
 * Gera texto persuasivo com Groq AI usando o modelo llama-3.3-70b-versatile
 */
function gerarCopyPersuasivaGroq(item) {
  if (!GROQ_API_KEY || GROQ_API_KEY.includes("SEU_GROQ_API_KEY")) {
    return formatarCopyFallback(item);
  }

  try {
    const prompt = `Você é um copywriter de elite especialista em canais de ofertas do Telegram e promoções do Mercado Livre no Brasil.
Crie uma copy curta, altamente viciante e persuasiva para o produto abaixo.

DADOS DO PRODUTO:
- Título: ${item.title}
- Preço Original: ${item.oldPrice || 'Não informado'}
- Preço com Desconto / Atual: ${item.price}

REGRAS OBRIGATÓRIAS:
1. Use emojis estratégicos e empolgantes (ex: 🔥, ⚡, 😱, 📦, 🏷️).
2. Destaque o desconto ou a oportunidade imperdível.
3. Se houver preço original, use <s>${item.oldPrice}</s> e destaque o preço atual com <b>${item.price}</b>.
4. Use APENAS formatação HTML válida do Telegram: <b>negrito</b>, <i>itálico</i>, <s>tachado</s>, <code>código</code>. NÃO use Markdown (* ou _).
5. O texto NÃO deve conter o link nem instruções como "clique aqui", pois haverá um botão inline oficial anexado.
6. Máximo de 500 caracteres para caber perfeitamente na legenda da foto.
7. Retorne APENAS o texto promocional, sem saudações ou explicações.`;

    const requestBody = {
      model: "llama-3.3-70b-versatile",
      messages: [
        { role: "system", content: "Você é um assistente de ofertas promocionais no Telegram. Responda apenas com a copy formatada em HTML." },
        { role: "user", content: prompt }
      ],
      temperature: 0.7,
      max_tokens: 300
    };

    const options = {
      method: "post",
      contentType: "application/json",
      headers: {
        "Authorization": "Bearer " + GROQ_API_KEY
      },
      payload: JSON.stringify(requestBody),
      muteHttpExceptions: true
    };

    const response = UrlFetchApp.fetch("https://api.groq.com/openai/v1/chat/completions", options);
    const json = JSON.parse(response.getContentText());

    if (json.choices && json.choices.length > 0) {
      let copyText = json.choices[0].message.content.trim();
      // Sanitiza para garantir tags seguras para o Telegram
      copyText = sanitizarHtmlTelegram(copyText);
      return copyText;
    }
  } catch (err) {
    Logger.log("⚠️ Erro na API Groq, utilizando copy fallback: " + err.toString());
  }

  return formatarCopyFallback(item);
}

/**
 * Copy fallback caso a API da Groq esteja offline ou sem chave
 */
function formatarCopyFallback(item) {
  let copy = "🔥 <b>OFERTA IMPERDÍVEL NO MERCADO LIVRE!</b>\n\n";
  copy += "📦 <b>" + item.title + "</b>\n\n";

  if (item.oldPrice && item.oldPrice !== item.price) {
    copy += "❌ De: <s>" + item.oldPrice + "</s>\n";
  }
  copy += "💥 <b>Por apenas: " + item.price + "</b>\n\n";
  copy += "⚡ <i>Estoque limitado ou preço sujeito a alteração rápida!</i>";
  return copy;
}

/**
 * Sanitiza o texto para aceitar somente tags HTML do Telegram
 */
function sanitizarHtmlTelegram(html) {
  // Substitui markdown acidental por tags html
  let cleaned = html
    .replace(/\*\*(.*?)\*\*/g, "<b>$1</b>")
    .replace(/__(.*?)__/g, "<i>$1</i>")
    .replace(/~~(.*?)~~/g, "<s>$1</s>");

  // Garante que não ultrapasse 1000 caracteres (limite do caption do Telegram é 1024)
  if (cleaned.length > 1000) {
    cleaned = cleaned.substring(0, 990) + "...";
  }
  return cleaned;
}

/**
 * Publica no Canal do Telegram com imagem e botão inline
 */
function publicarNoCanalTelegram(item, copyText) {
  const inlineKeyboard = {
    inline_keyboard: [
      [
        {
          text: "🛒 COMPRAR NO MERCADO LIVRE",
          url: item.affiliateUrl || "https://www.mercadolivre.com.br"
        }
      ]
    ]
  };

  // 1. Tenta envio com foto (sendPhoto) se houver imagem válida
  if (item.image && item.image.startsWith("http")) {
    try {
      const photoPayload = {
        chat_id: TELEGRAM_CHANNEL_ID,
        photo: item.image,
        caption: copyText,
        parse_mode: "HTML",
        reply_markup: JSON.stringify(inlineKeyboard)
      };

      const options = {
        method: "post",
        contentType: "application/json",
        payload: JSON.stringify(photoPayload),
        muteHttpExceptions: true
      };

      const response = UrlFetchApp.fetch("https://api.telegram.org/bot" + TELEGRAM_BOT_TOKEN + "/sendPhoto", options);
      const resJson = JSON.parse(response.getContentText());

      if (resJson.ok) {
        return { ok: true };
      } else {
        Logger.log("⚠️ sendPhoto falhou (" + resJson.description + "), tentando sendMessage fallback...");
      }
    } catch (err) {
      Logger.log("⚠️ Exceção no sendPhoto: " + err.toString());
    }
  }

  // 2. Fallback via texto puro (sendMessage)
  try {
    const textPayload = {
      chat_id: TELEGRAM_CHANNEL_ID,
      text: copyText,
      parse_mode: "HTML",
      reply_markup: JSON.stringify(inlineKeyboard),
      disable_web_page_preview: false
    };

    const options = {
      method: "post",
      contentType: "application/json",
      payload: JSON.stringify(textPayload),
      muteHttpExceptions: true
    };

    const response = UrlFetchApp.fetch("https://api.telegram.org/bot" + TELEGRAM_BOT_TOKEN + "/sendMessage", options);
    const resJson = JSON.parse(response.getContentText());
    if (resJson.ok) {
      return { ok: true };
    } else {
      return { ok: false, description: resJson.description || "Erro no Telegram" };
    }
  } catch (err) {
    Logger.log("❌ Falha crítica no envio ao Telegram: " + err.toString());
    return { ok: false, description: err.toString() };
  }
}

/**
 * Envia uma mensagem direta de resposta para um chat específico do Telegram
 */
function enviarMensagemTelegram(chatId, text) {
  try {
    const payload = {
      chat_id: chatId,
      text: text,
      parse_mode: "HTML"
    };

    UrlFetchApp.fetch("https://api.telegram.org/bot" + TELEGRAM_BOT_TOKEN + "/sendMessage", {
      method: "post",
      contentType: "application/json",
      payload: JSON.stringify(payload),
      muteHttpExceptions: true
    });
  } catch (e) {
    Logger.log("Erro ao enviar mensagem direta no Telegram: " + e.toString());
  }
}

/**
 * Extrai metadados de uma URL do Mercado Livre via OpenGraph (og:title, og:image, etc.)
 */
function extrairDadosOpenGraph(url) {
  const result = {
    id: "MLB-MANUAL-" + new Date().getTime(),
    title: "Oferta Mercado Livre",
    oldPrice: "",
    price: "Confira na loja",
    image: "https://http2.mlstatic.com/frontend-assets/ui-navigation/5.19.5/mercadolivre/logo__large_plus.png",
    url: url
  };

  try {
    const mlbMatch = url.match(/(ML[A-Z]?-?\d+)/i);
    if (mlbMatch) {
      result.id = mlbMatch[1].replace("-", "").toUpperCase();
    }

    const html = UrlFetchApp.fetch(url, {
      muteHttpExceptions: true,
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept-Language": "pt-BR,pt;q=0.9"
      }
    }).getContentText();

    // og:title
    const titleMatch = html.match(/<meta\s+property=["']og:title["']\s+content=["'](.*?)["']/i) ||
                       html.match(/<title>(.*?)<\/title>/i);
    if (titleMatch && titleMatch[1]) {
      result.title = decodeHtmlEntities(titleMatch[1].trim());
    }

    // og:image
    const imageMatch = html.match(/<meta\s+property=["']og:image["']\s+content=["'](.*?)["']/i);
    if (imageMatch && imageMatch[1]) {
      result.image = imageMatch[1].trim();
    }

    // Extração de preço
    const priceAmountMatch = html.match(/<meta\s+property=["']product:price:amount["']\s+content=["'](.*?)["']/i) ||
                             html.match(/class=["'][^"']*andes-money-amount__fraction[^"']*["']>([\d.]+)</i);
    if (priceAmountMatch && priceAmountMatch[1]) {
      const priceVal = priceAmountMatch[1].trim();
      result.price = "R$ " + (priceVal.includes(",") ? priceVal : priceVal + ",00");
    }

  } catch (err) {
    Logger.log("Erro ao extrair OpenGraph da URL: " + err.toString());
  }

  return result;
}

/**
 * Utilitário: Decodifica entidades HTML comuns
 */
function decodeHtmlEntities(str) {
  return str
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

/**
 * Utilitário: Retorna a aba de fila
 */
function getFilaSheet() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) {
    setupPlanilha();
    sheet = ss.getSheetByName(SHEET_NAME);
  }
  return sheet;
}

/**
 * Utilitário: Retorna Set com IDs existentes na coluna A
 */
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
