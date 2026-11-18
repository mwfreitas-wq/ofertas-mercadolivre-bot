/**
 * scraper.js - Scraper de Ofertas do Mercado Livre com Conversão para Afiliados
 * Executado via GitHub Actions ou localmente com Node.js + Playwright
 */

const { chromium } = require('playwright');

// Configurações e Variáveis de Ambiente
const GAS_WEBHOOK_URL = process.env.GAS_WEBHOOK_URL || '';
const ML_COOKIES_JSON = process.env.ML_COOKIES_JSON || '';
const ML_AFFILIATE_TAG = process.env.ML_AFFILIATE_TAG || '';
const MAX_ITEMS = 15;
const TARGET_URL = 'https://www.mercadolivre.com.br/ofertas';

/**
 * Limpa uma URL do Mercado Livre removendo parâmetros de rastreamento.
 * Ex: remove ?tracking_id=..., #position=..., etc.
 */
function sanitizeProductUrl(rawUrl) {
  try {
    const parsed = new URL(rawUrl);
    // Preserva apenas o protocolo, hostname e pathname limpo
    return `${parsed.origin}${parsed.pathname}`;
  } catch (err) {
    return rawUrl ? rawUrl.split('?')[0].split('#')[0] : '';
  }
}

/**
 * Extrai o ID do produto (código MLB) a partir da URL ou texto
 */
function extractProductId(url, fallbackIndex = 0) {
  if (!url) return `MLB-OFERTA-${Date.now()}-${fallbackIndex}`;
  
  // Tenta encontrar MLB seguido de números (ex: MLB1234567890 ou MLB-1234567890)
  const mlbMatch = url.match(/(MLB-?\d+)/i);
  if (mlbMatch) {
    return mlbMatch[1].replace('-', '').toUpperCase();
  }

  // Tenta extrair id numérico do path (ex: /p/MLB2345678 ou /MLB-2345678)
  const numMatch = url.match(/\/p\/([A-Z0-9]+)/i);
  if (numMatch) {
    return numMatch[1].toUpperCase();
  }

  return `MLB-${Date.now()}-${fallbackIndex}`;
}

/**
 * Converte a URL limpa adicionando as tags de rastreamento de afiliado
 */
function applyAffiliateTag(cleanUrl, affiliateTag) {
  if (!affiliateTag || !affiliateTag.trim()) {
    return cleanUrl;
  }

  const tag = affiliateTag.trim().replace(/^[?&]+/, '');
  const separator = cleanUrl.includes('?') ? '&' : '?';
  return `${cleanUrl}${separator}${tag}`;
}

/**
 * Tenta obter link encurtado oficial (/sec/) via barra interna de afiliados
 * se cookies de sessão autenticada estiverem presentes.
 */
async function tryGenerateSecLink(context, page, productUrl) {
  try {
    const detailPage = await context.newPage();
    await detailPage.goto(productUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });

    // Aguarda seletor da barra de afiliados do Mercado Livre (se logado)
    // O ML exibe elementos de afiliado com botões de compartilhamento / gerar link
    const affiliateBarSelector = '#affiliate-bar, .affiliate-bar, [data-testid="affiliate-bar"], button:has-text("Gerar link"), button:has-text("Copiar link")';
    const hasAffiliateBar = await detailPage.$(affiliateBarSelector).catch(() => null);

    if (hasAffiliateBar) {
      await hasAffiliateBar.click().catch(() => {});
      await detailPage.waitForTimeout(1000);

      // Procura input ou link contendo '/sec/'
      const secInput = await detailPage.$('input[value*="/sec/"], a[href*="/sec/"]').catch(() => null);
      if (secInput) {
        const secUrl = await secInput.getAttribute('value') || await secInput.getAttribute('href');
        if (secUrl && secUrl.includes('/sec/')) {
          console.log(`[Afiliado /sec/ obtido]: ${secUrl}`);
          await detailPage.close().catch(() => {});
          return secUrl;
        }
      }
    }

    await detailPage.close().catch(() => {});
  } catch (err) {
    // Fallback silencioso para não interromper o scraping
  }
  return null;
}

/**
 * Normaliza strings de preços removendo caracteres estranhos
 */
function cleanPriceText(text) {
  if (!text) return null;
  const cleaned = text.replace(/\s+/g, ' ').trim();
  return cleaned || null;
}

async function scrapeOffers() {
  console.log('====================================================');
  console.log('🚀 Iniciando Scraper de Ofertas do Mercado Livre');
  console.log(`⏰ Data/Hora UTC: ${new Date().toISOString()}`);
  console.log('====================================================');

  const browser = await chromium.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-accelerated-2d-canvas',
      '--disable-gpu',
      '--window-size=1920,1080',
    ],
  });

  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
    locale: 'pt-BR',
    timezoneId: 'America/Sao_Paulo',
    viewport: { width: 1920, height: 1080 },
    extraHTTPHeaders: {
      'Accept-Language': 'pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7',
    },
  });

  // Injeção de Cookies de sessão se existirem
  let cookiesInjected = false;
  if (ML_COOKIES_JSON && ML_COOKIES_JSON.trim()) {
    try {
      const parsedCookies = JSON.parse(ML_COOKIES_JSON);
      if (Array.isArray(parsedCookies) && parsedCookies.length > 0) {
        await context.addCookies(parsedCookies);
        cookiesInjected = true;
        console.log(`✅ ${parsedCookies.length} cookies de sessão do Mercado Livre injetados.`);
      }
    } catch (cookieErr) {
      console.warn('⚠️ Falha ao analisar ML_COOKIES_JSON. Continuando sem cookies...', cookieErr.message);
    }
  }

  const page = await context.newPage();

  try {
    console.log(`🌐 Navegando para ${TARGET_URL}...`);
    await page.goto(TARGET_URL, { waitUntil: 'domcontentloaded', timeout: 45000 });

    // Aceita cookies caso o banner apareça
    try {
      const cookieBtn = await page.$('button[data-testid="action:understood-cookies"], button:has-text("Entendido"), button:has-text("Aceitar cookies")');
      if (cookieBtn) {
        await cookieBtn.click();
        await page.waitForTimeout(500);
      }
    } catch (_) {}

    // Rola a página suavemente para acionar o carregamento lazy-load das imagens e produtos
    console.log('📜 Rolando a página para carregar itens dinâmicos...');
    for (let i = 0; i < 4; i++) {
      await page.mouse.wheel(0, 1000);
      await page.waitForTimeout(1000);
    }

    // Aguarda a presença de cards de produtos
    await page.waitForSelector('.poly-card, .promotion-item, .ui-search-result, li.items-list__item, .andes-card', {
      timeout: 15000,
    }).catch(() => {
      console.log('⚠️ Seletor primário demorou a responder, prosseguindo com avaliação direta do DOM.');
    });

    // Extração dos dados diretamente no contexto do navegador
    console.log('🔍 Extraindo dados dos produtos na página...');
    const rawItems = await page.evaluate(() => {
      const items = [];
      
      // Seletores de cards suportados pelo Mercado Livre (atuais e legados)
      const cardSelectors = [
        '.poly-card',
        '.promotion-item',
        'li.items-list__item',
        'div[class*="poly-card"]',
        '.ui-search-result__content-wrapper',
        '.andes-card'
      ];

      let cardElements = [];
      for (const selector of cardSelectors) {
        const found = Array.from(document.querySelectorAll(selector));
        if (found.length >= 5) {
          cardElements = found;
          break;
        }
      }

      if (cardElements.length === 0) {
        // Fallback genérico para links de produtos de ofertas
        const linkList = Array.from(document.querySelectorAll('a[href*="/p/MLB"], a[href*="produto.mercadolivre.com.br/MLB-"]'));
        cardElements = linkList.map(a => a.closest('div') || a);
      }

      for (const card of cardElements) {
        if (items.length >= 30) break; // Coleta pool de até 30 para selecionar os 15 melhores

        // 1. Link do Produto
        const anchor = card.querySelector('a[href*="mercadolivre.com"], a[href*="/p/"], a[href*="/MLB-"]') || card.querySelector('a');
        if (!anchor) continue;
        const href = anchor.href || '';
        if (!href || href.includes('/ofertas?') || href.endsWith('/ofertas')) continue;

        // 2. Título
        let title = '';
        const titleEl = card.querySelector('.poly-component__title, .promotion-item__title, .ui-search-item__title, h2, h3, a[title]');
        if (titleEl) {
          title = titleEl.getAttribute('title') || titleEl.textContent || '';
        }
        title = title.trim();
        if (!title) continue;

        // 3. Preço Atual
        let price = '';
        const currentPriceEl = card.querySelector('.poly-price__current .andes-money-amount__fraction, .promotion-item__price span, .ui-search-price--size-medium .andes-money-amount__fraction, .andes-money-amount--previous + .andes-money-amount .andes-money-amount__fraction, .andes-money-amount__fraction');
        const centsEl = card.querySelector('.poly-price__current .andes-money-amount__cents, .andes-money-amount__cents');
        if (currentPriceEl) {
          const frac = currentPriceEl.textContent.trim().replace(/\D/g, '');
          const cents = centsEl ? centsEl.textContent.trim().replace(/\D/g, '') : '00';
          if (frac) {
            price = `R$ ${frac},${cents.length === 1 ? cents + '0' : cents}`;
          }
        }

        // 4. Preço Antigo (se houver desconto)
        let oldPrice = '';
        const oldPriceEl = card.querySelector('s .andes-money-amount__fraction, .andes-money-amount--previous .andes-money-amount__fraction, .promotion-item__old-price');
        if (oldPriceEl) {
          const oldFrac = oldPriceEl.textContent.trim().replace(/\D/g, '');
          if (oldFrac) {
            oldPrice = `R$ ${oldFrac},00`;
          }
        }

        // 5. Imagem em alta resolução
        let image = '';
        const imgEl = card.querySelector('img[data-src], img[src], img[srcset]');
        if (imgEl) {
          const dataSrc = imgEl.getAttribute('data-src');
          const src = imgEl.getAttribute('src');
          const srcset = imgEl.getAttribute('srcset');

          if (dataSrc && !dataSrc.startsWith('data:')) {
            image = dataSrc;
          } else if (srcset) {
            const parts = srcset.split(',').map(s => s.trim().split(' ')[0]);
            image = parts[parts.length - 1]; // Pega a maior resolução
          } else if (src && !src.startsWith('data:')) {
            image = src;
          }
        }

        // Ajusta URLs de thumbnail do ML para alta resolução (-V.webp, -O.webp, -F.webp)
        if (image && image.includes('-I.jpg')) {
          image = image.replace('-I.jpg', '-O.jpg');
        } else if (image && image.includes('-I.webp')) {
          image = image.replace('-I.webp', '-O.webp');
        }

        items.push({
          rawUrl: href,
          title,
          price,
          oldPrice: oldPrice || null,
          image,
        });
      }

      return items;
    });

    console.log(`📦 Itens brutos extraídos do DOM: ${rawItems.length}`);

    // Processa e filtra os 15 melhores produtos únicos
    const processedItems = [];
    const seenIds = new Set();

    for (let i = 0; i < rawItems.length && processedItems.length < MAX_ITEMS; i++) {
      const raw = rawItems[i];
      const cleanUrl = sanitizeProductUrl(raw.rawUrl);
      const id = extractProductId(cleanUrl, i + 1);

      if (seenIds.has(id)) continue;
      seenIds.add(id);

      // Conversão de Afiliado
      let affiliateUrl = null;

      // Opção A: Tenta /sec/ se houver cookies autenticados
      if (cookiesInjected) {
        affiliateUrl = await tryGenerateSecLink(context, page, cleanUrl);
      }

      // Opção B: Fallback ou método direto via ML_AFFILIATE_TAG
      if (!affiliateUrl) {
        affiliateUrl = applyAffiliateTag(cleanUrl, ML_AFFILIATE_TAG);
      }

      processedItems.push({
        id,
        title: raw.title,
        oldPrice: cleanPriceText(raw.oldPrice),
        price: cleanPriceText(raw.price) || 'Confira no link',
        image: raw.image || 'https://http2.mlstatic.com/frontend-assets/ui-navigation/5.19.5/mercadolibre/logo__large_plus.png',
        cleanUrl,
        affiliateUrl,
      });
    }

    console.log(`✨ Produtos válidos prontos para envio: ${processedItems.length}`);

    if (processedItems.length === 0) {
      console.warn('⚠️ Nenhum produto encontrado nesta execução. Verifique a estrutura da página de ofertas.');
      await browser.close();
      return;
    }

    // Exibe amostra dos itens no log
    console.log('\n--- Amostra dos Primeiros Itens ---');
    processedItems.slice(0, 3).forEach((item, idx) => {
      console.log(`[#${idx + 1}] ${item.id} - ${item.title}`);
      console.log(`     Preço: ${item.price} (De: ${item.oldPrice || 'N/A'})`);
      console.log(`     Link:  ${item.affiliateUrl}`);
    });
    console.log('-----------------------------------\n');

    // Envio para o Webhook do Google Apps Script
    if (!GAS_WEBHOOK_URL) {
      console.warn('⚠️ Variável GAS_WEBHOOK_URL não configurada! O lote JSON NÃO foi enviado ao Google Sheets.');
      console.log('💡 Configure GAS_WEBHOOK_URL nos Secrets do GitHub ou no arquivo .env local.');
    } else {
      console.log(`📤 Enviando lote de ${processedItems.length} ofertas para o Google Apps Script...`);
      const payload = {
        source: 'github_scraper',
        timestamp: new Date().toISOString(),
        items: processedItems,
      };

      const response = await fetch(GAS_WEBHOOK_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'ML-Affiliate-Bot/1.0',
        },
        body: JSON.stringify(payload),
        redirect: 'follow', // Segue redirecionamentos 302 comuns do Google Apps Script
      });

      const responseText = await response.text();
      console.log(`📬 Resposta do Google Apps Script (Status ${response.status}):`, responseText);
      console.log('🎉 Lote de ofertas enviado com sucesso!');
    }
  } catch (error) {
    console.error('❌ Erro durante a execução do scraper:', error);
    process.exitCode = 1;
  } finally {
    await browser.close();
    console.log('🏁 Processo finalizado com sucesso.');
  }
}

// Execução
scrapeOffers();
