/**
 * scraper.js - Curadoria Multi-Loja (Mercado Livre + Shopee + Cupons Verificados)
 *
 * Funcionalidades:
 * 1. Mercado Livre: extrai produtos Mais Vendidos e Ofertas (via DOM + JSON-LD estruturado) + selos oficiais de cupom.
 * 2. Shopee:
 *    - Se SHOPEE_APP_ID e SHOPEE_SECRET estiverem definidos, usa a Shopee Affiliate Open API (GraphQL) oficial.
 *    - Caso contrário, usa Playwright para extrair Ofertas Relâmpago / Mais Vendidos.
 * 3. Cupons Confiáveis: coleta cupons marcados como "Verificado" / "Testado" em fontes confiáveis (Cuponomia).
 * 4. Envia o lote completo (items + coupons) via POST para GAS_WEBHOOK_URL (Google Apps Script).
 */

const crypto = require('crypto');
const { chromium } = require('playwright');

// ========================== VARIÁVEIS DE AMBIENTE ==========================
const GAS_WEBHOOK_URL = process.env.GAS_WEBHOOK_URL || '';

// Mercado Livre
const ML_COOKIES_JSON = process.env.ML_COOKIES_JSON || '';
const ML_AFFILIATE_TAG = process.env.ML_AFFILIATE_TAG || '';

// Shopee (Modo sem API via Playwright OU Modo Oficial via GraphQL Open API quando liberada)
const SHOPEE_APP_ID = process.env.SHOPEE_APP_ID || '';
const SHOPEE_SECRET = process.env.SHOPEE_SECRET || '';
const SHOPEE_AFFILIATE_TAG = process.env.SHOPEE_AFFILIATE_TAG || '';
const SHOPEE_COOKIES_JSON = process.env.SHOPEE_COOKIES_JSON || '';

const MAX_ML_ITEMS = Number(process.env.MAX_ML_ITEMS || 10);
const MAX_SHOPEE_ITEMS = Number(process.env.MAX_SHOPEE_ITEMS || 10);
// ===========================================================================

function sanitizeUrl(rawUrl) {
  try {
    const parsed = new URL(rawUrl);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return rawUrl ? rawUrl.split('?')[0].split('#')[0] : '';
  }
}

function extractMlId(url, fallbackIndex = 0) {
  if (!url) return `MLB-${Date.now()}-${fallbackIndex}`;
  const mlbMatch = url.match(/(ML[A-Z]?-?\d+)/i);
  if (mlbMatch) return mlbMatch[1].replace('-', '').toUpperCase();
  const pMatch = url.match(/\/p\/([A-Z0-9]+)/i);
  if (pMatch) return pMatch[1].toUpperCase();
  return `MLB-${Date.now()}-${fallbackIndex}`;
}

function extractShopeeId(url, fallbackIndex = 0) {
  if (!url) return `SHP-${Date.now()}-${fallbackIndex}`;
  const dotMatch = url.match(/i\.(\d+)\.(\d+)/i);
  if (dotMatch) return `SHP${dotMatch[2]}`;
  const pathMatch = url.match(/\/product\/(\d+)\/(\d+)/i);
  if (pathMatch) return `SHP${pathMatch[2]}`;
  return `SHP-${Date.now()}-${fallbackIndex}`;
}

function applyAffiliateTag(cleanUrl, tagStr) {
  if (!tagStr || !tagStr.trim()) return cleanUrl;
  const tag = tagStr.trim().replace(/^[?&]+/, '');
  const sep = cleanUrl.includes('?') ? '&' : '?';
  return `${cleanUrl}${sep}${tag}`;
}

function formatBRL(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'string' && value.includes('R$')) return value.replace(/\s+/g, ' ').trim();
  const num = Number(value);
  if (Number.isNaN(num) || num <= 0) return null;
  return 'R$ ' + num.toFixed(2).replace('.', ',').replace(/\B(?=(\d{3})+(?!\d))/g, '.');
}

// ===========================================================================
// 1. MERCADO LIVRE (Mais Vendidos + Ofertas)
// ===========================================================================
async function scrapeMercadoLivre(browser) {
  console.log('\n🟡 [Mercado Livre] Iniciando coleta de Mais Vendidos e Ofertas...');
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
    locale: 'pt-BR',
    timezoneId: 'America/Sao_Paulo',
    viewport: { width: 1366, height: 900 },
    extraHTTPHeaders: { 'Accept-Language': 'pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7' },
  });

  if (ML_COOKIES_JSON.trim()) {
    try {
      const cookies = JSON.parse(ML_COOKIES_JSON);
      if (Array.isArray(cookies) && cookies.length > 0) {
        await context.addCookies(cookies);
        console.log(`   ✅ ${cookies.length} cookies do Mercado Livre injetados.`);
      }
    } catch (e) {
      console.warn('   ⚠️ ML_COOKIES_JSON inválido:', e.message);
    }
  }

  const page = await context.newPage();
  const urlsToVisit = [
    'https://www.mercadolivre.com.br/ofertas',
    'https://www.mercadolivre.com.br/mais-vendidos/MLB1051', // Celulares e Telefones
    'https://www.mercadolivre.com.br/mais-vendidos/MLB1574', // Casa, Móveis e Decoração
  ];

  const collected = [];
  const seenIds = new Set();

  try {
    for (const targetUrl of urlsToVisit) {
      if (collected.length >= MAX_ML_ITEMS) break;
      console.log(`   🌐 Acessando ${targetUrl}...`);

      let status = 0;
      try {
        const resp = await page.goto(targetUrl, { waitUntil: 'load', timeout: 35000 });
        status = resp ? resp.status() : 0;
        await page.waitForTimeout(2500);
      } catch (navErr) {
        console.warn(`   ⚠️ Falha ao abrir ${targetUrl}: ${navErr.message}`);
        continue;
      }

      const pageTitle = await page.title().catch(() => '');
      const finalUrl = page.url();
      console.log(`   ℹ️ HTTP ${status} | Título: "${pageTitle}" | URL: ${finalUrl.slice(0, 80)}`);

      if (status === 403 || /captcha|verif|account-verification|gz\/account/i.test(finalUrl + ' ' + pageTitle)) {
        console.warn('   ⚠️ Página solicitou verificação humana/login ou retornou 403. Pulando.');
        continue;
      }

      for (let s = 0; s < 3; s++) {
        await page.mouse.wheel(0, 900);
        await page.waitForTimeout(700);
      }

      const rawItems = await page.evaluate(() => {
        const results = [];
        const seenHref = new Set();

        // Estratégia 1: Dados estruturados JSON-LD (Schema.org) se presentes na página
        const ldScripts = Array.from(document.querySelectorAll('script[type="application/ld+json"]'));
        for (const sc of ldScripts) {
          try {
            const data = JSON.parse(sc.textContent || '{}');
            const list = data?.itemListElement || (Array.isArray(data) ? data : []);
            for (const entry of list) {
              const prod = entry?.item || entry;
              if (prod && prod['@type'] === 'Product' && prod.name && prod.url) {
                const offer = Array.isArray(prod.offers) ? prod.offers[0] : prod.offers;
                const priceNum = offer?.price;
                if (!seenHref.has(prod.url)) {
                  seenHref.add(prod.url);
                  results.push({
                    rawUrl: prod.url,
                    title: String(prod.name).trim(),
                    price: priceNum ? `R$ ${Number(priceNum).toFixed(2).replace('.', ',')}` : '',
                    oldPrice: null,
                    image: Array.isArray(prod.image) ? prod.image[0] : (prod.image || ''),
                    officialCoupon: '',
                  });
                }
              }
            }
          } catch (_) {}
        }

        // Estratégia 2: Cards do DOM (seletores modernos e genéricos)
        const cardSelectors = [
          '.poly-card',
          '.promotion-item',
          '.ui-recommendations-card',
          'li.ui-search-layout__item',
          'li.items-list__item',
          '.andes-card',
        ];

        let cards = [];
        for (const sel of cardSelectors) {
          const found = Array.from(document.querySelectorAll(sel));
          if (found.length >= 3) {
            cards = found;
            break;
          }
        }

        // Estratégia 3: Fallback por links diretos de produto
        if (cards.length === 0) {
          const anchors = Array.from(document.querySelectorAll('a[href*="/p/MLB"], a[href*="produto.mercadolivre.com.br/MLB"], a[href*="/MLB-"]'));
          cards = anchors.map((a) => a.closest('li, article, div') || a);
        }

        for (const card of cards) {
          if (results.length >= 25) break;

          const anchor = card.querySelector('a[href*="/p/MLB"], a[href*="produto.mercadolivre.com.br"], a[href*="/MLB"], a[href*="mercadolivre.com"]') || (card.tagName === 'A' ? card : card.querySelector('a'));
          if (!anchor || !anchor.href) continue;
          const href = anchor.href;
          if (seenHref.has(href) || href.includes('/ofertas?') || href.endsWith('/ofertas') || href.includes('/mais-vendidos')) continue;

          const titleEl = card.querySelector('.poly-component__title, .promotion-item__title, .ui-recommendations-card__title, h2, h3, a[title]');
          const title = (titleEl?.getAttribute('title') || titleEl?.textContent || anchor.textContent || '').replace(/\s+/g, ' ').trim();
          if (!title || title.length < 6) continue;

          const fracEl = card.querySelector('.poly-price__current .andes-money-amount__fraction, .andes-money-amount--previous + .andes-money-amount .andes-money-amount__fraction, .andes-money-amount__fraction');
          const centsEl = card.querySelector('.poly-price__current .andes-money-amount__cents, .andes-money-amount__cents');
          let price = '';
          if (fracEl) {
            const frac = fracEl.textContent.trim().replace(/\D/g, '');
            const cents = centsEl ? centsEl.textContent.trim().replace(/\D/g, '') : '00';
            if (frac) price = `R$ ${frac},${cents.length === 1 ? cents + '0' : cents}`;
          }

          const oldEl = card.querySelector('s .andes-money-amount__fraction, .andes-money-amount--previous .andes-money-amount__fraction');
          let oldPrice = null;
          if (oldEl) {
            const oldFrac = oldEl.textContent.trim().replace(/\D/g, '');
            if (oldFrac) oldPrice = `R$ ${oldFrac},00`;
          }

          let officialCoupon = '';
          const couponEl = card.querySelector('[class*="coupon"], [class*="voucher"], .poly-component__coupons');
          if (couponEl) {
            const txt = (couponEl.textContent || '').replace(/\s+/g, ' ').trim();
            if (/cupom|off|desconto/i.test(txt) && txt.length <= 60) {
              officialCoupon = txt;
            }
          }

          let image = '';
          const imgEl = card.querySelector('img[data-src], img[src], img[srcset]');
          if (imgEl) {
            const ds = imgEl.getAttribute('data-src');
            const src = imgEl.getAttribute('src');
            const ss = imgEl.getAttribute('srcset');
            if (ds && !ds.startsWith('data:')) image = ds;
            else if (ss) image = ss.split(',').pop().trim().split(' ')[0];
            else if (src && !src.startsWith('data:')) image = src;
          }
          if (image) {
            image = image.replace('-I.jpg', '-O.jpg').replace('-I.webp', '-O.webp');
          }

          seenHref.add(href);
          results.push({ rawUrl: href, title, price, oldPrice, image, officialCoupon });
        }

        return results;
      });

      console.log(`   📦 Extraídos ${rawItems.length} itens brutos de ${targetUrl}`);

      for (const raw of rawItems) {
        if (collected.length >= MAX_ML_ITEMS) break;
        const cleanUrl = sanitizeUrl(raw.rawUrl);
        const id = extractMlId(cleanUrl, collected.length + 1);
        if (seenIds.has(id)) continue;
        seenIds.add(id);

        collected.push({
          id,
          title: raw.title,
          oldPrice: raw.oldPrice,
          price: raw.price || 'Confira no link',
          image: raw.image || 'https://http2.mlstatic.com/frontend-assets/ui-navigation/5.19.5/mercadolibre/logo__large_plus.png',
          cleanUrl,
          affiliateUrl: applyAffiliateTag(cleanUrl, ML_AFFILIATE_TAG),
          store: 'Mercado Livre',
          coupon: raw.officialCoupon || '',
        });
      }
    }
  } finally {
    await context.close();
  }

  console.log(`🟡 [Mercado Livre] Total pronto: ${collected.length} produtos.`);
  return collected;
}

// ===========================================================================
// 2A. SHOPEE VIA API OFICIAL GRAPHQL (Pronto para quando liberarem seu AppID)
// ===========================================================================
async function fetchShopeeViaOfficialApi() {
  console.log('\n🟠 [Shopee Open API] Buscando produtos mais vendidos via GraphQL oficial...');
  const endpoint = 'https://open-api.affiliate.shopee.com.br/graphql';

  const query = `{
    productOfferV2(listType: 1, sortType: 2, page: 1, limit: ${MAX_SHOPEE_ITEMS}) {
      nodes {
        itemId
        productName
        priceMin
        priceMax
        priceDiscountRate
        imageUrl
        offerLink
        productLink
        ratingStar
        sales
      }
    }
  }`;

  const payload = JSON.stringify({ query });
  const timestamp = Math.floor(Date.now() / 1000);
  const signBase = `${SHOPEE_APP_ID}${timestamp}${payload}${SHOPEE_SECRET}`;
  const signature = crypto.createHash('sha256').update(signBase).digest('hex');

  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `SHA256 Credential=${SHOPEE_APP_ID}, Timestamp=${timestamp}, Signature=${signature}`,
    },
    body: payload,
  });

  const json = await res.json();
  const nodes = json?.data?.productOfferV2?.nodes || [];
  console.log(`   📦 Shopee Open API retornou ${nodes.length} produtos.`);

  return nodes.map((n) => {
    const priceNum = Number(n.priceMin || 0);
    const discount = Number(n.priceDiscountRate || 0);
    const oldPriceNum = discount > 0 && discount < 95 ? priceNum / (1 - discount / 100) : null;
    return {
      id: `SHP${n.itemId}`,
      title: n.productName,
      oldPrice: oldPriceNum ? formatBRL(oldPriceNum) : null,
      price: formatBRL(priceNum) || 'Confira na Shopee',
      image: n.imageUrl || '',
      cleanUrl: n.productLink || n.offerLink,
      affiliateUrl: n.offerLink || n.productLink,
      store: 'Shopee',
      coupon: '',
    };
  });
}

// ===========================================================================
// 2B. SHOPEE SEM API (Playwright — Ofertas Relâmpago e Mais Vendidos)
// ===========================================================================
async function scrapeShopeePlaywright(browser) {
  console.log('\n🟠 [Shopee] Iniciando coleta via navegador (modo sem API)...');
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
    locale: 'pt-BR',
    timezoneId: 'America/Sao_Paulo',
    viewport: { width: 1366, height: 900 },
    extraHTTPHeaders: { 'Accept-Language': 'pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7' },
  });

  if (SHOPEE_COOKIES_JSON.trim()) {
    try {
      const cookies = JSON.parse(SHOPEE_COOKIES_JSON);
      if (Array.isArray(cookies) && cookies.length > 0) {
        await context.addCookies(cookies);
        console.log(`   ✅ ${cookies.length} cookies da Shopee injetados.`);
      }
    } catch (e) {
      console.warn('   ⚠️ SHOPEE_COOKIES_JSON inválido:', e.message);
    }
  }

  const page = await context.newPage();
  const collected = [];
  const seenIds = new Set();

  const shopeeUrls = [
    'https://shopee.com.br/flash_sale',
    'https://shopee.com.br/top_products',
  ];

  try {
    for (const targetUrl of shopeeUrls) {
      if (collected.length >= MAX_SHOPEE_ITEMS) break;
      console.log(`   🌐 Acessando ${targetUrl}...`);

      let status = 0;
      try {
        const resp = await page.goto(targetUrl, { waitUntil: 'load', timeout: 35000 });
        status = resp ? resp.status() : 0;
        await page.waitForTimeout(3000);
      } catch (err) {
        console.warn(`   ⚠️ Falha ao abrir ${targetUrl}: ${err.message}`);
        continue;
      }

      const pageTitle = await page.title().catch(() => '');
      const finalUrl = page.url();
      console.log(`   ℹ️ HTTP ${status} | Título: "${pageTitle}" | URL: ${finalUrl.slice(0, 80)}`);

      if (status === 403 || /login|verify|captcha/i.test(finalUrl)) {
        console.warn('   ⚠️ Shopee solicitou login ou verificação humana. Pulando.');
        continue;
      }

      for (let s = 0; s < 3; s++) {
        await page.mouse.wheel(0, 800);
        await page.waitForTimeout(800);
      }

      const rawItems = await page.evaluate(() => {
        const out = [];
        const links = Array.from(document.querySelectorAll('a[href*="-i."], a[href*="/product/"]'));

        for (const a of links) {
          if (out.length >= 25) break;
          const href = a.href || '';
          if (!href) continue;

          const card = a.closest('div') || a;
          const imgEl = a.querySelector('img') || card.querySelector('img');
          const image = imgEl ? (imgEl.getAttribute('src') || imgEl.getAttribute('data-src') || '') : '';

          const textLines = (a.innerText || card.innerText || '')
            .split('\n')
            .map((l) => l.trim())
            .filter(Boolean);

          const priceLine = textLines.find((l) => /^R\$\s?[\d.,]+/.test(l)) || '';
          const titleLine = textLines.find((l) => l.length > 10 && !l.startsWith('R$') && !/^\d+%/.test(l) && !/vendido/i.test(l)) || imgEl?.getAttribute('alt') || '';

          if (!titleLine) continue;

          out.push({
            rawUrl: href,
            title: titleLine,
            price: priceLine || 'Confira na Shopee',
            oldPrice: null,
            image,
          });
        }
        return out;
      });

      console.log(`   📦 Extraídos ${rawItems.length} itens brutos de ${targetUrl}`);

      for (const raw of rawItems) {
        if (collected.length >= MAX_SHOPEE_ITEMS) break;
        const cleanUrl = sanitizeUrl(raw.rawUrl);
        const id = extractShopeeId(cleanUrl, collected.length + 1);
        if (seenIds.has(id)) continue;
        seenIds.add(id);

        collected.push({
          id,
          title: raw.title,
          oldPrice: raw.oldPrice,
          price: raw.price,
          image: raw.image || 'https://deo.shopeemobile.com/shopee/shopee-pcmall-live-sg/assets/ca5d12864c12916c05640b36e47ac5c9.png',
          cleanUrl,
          affiliateUrl: applyAffiliateTag(cleanUrl, SHOPEE_AFFILIATE_TAG),
          store: 'Shopee',
          coupon: '',
        });
      }
    }
  } finally {
    await context.close();
  }

  console.log(`🟠 [Shopee] Total pronto: ${collected.length} produtos.`);
  return collected;
}

// ===========================================================================
// 3. CUPONS CONFIÁVEIS E VERIFICADOS (Cuponomia — apenas verificados/testados)
// ===========================================================================
async function scrapeTrustedCoupons(browser) {
  console.log('\n🎟️ [Cupons Confiáveis] Buscando cupons verificados (Cuponomia)...');
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
    locale: 'pt-BR',
    viewport: { width: 1366, height: 900 },
  });

  const page = await context.newPage();
  const sources = [
    { store: 'Mercado Livre', url: 'https://www.cuponomia.com.br/desconto/mercado-livre' },
    { store: 'Shopee', url: 'https://www.cuponomia.com.br/desconto/shopee' },
  ];

  const verifiedCoupons = [];

  try {
    for (const src of sources) {
      try {
        const resp = await page.goto(src.url, { waitUntil: 'load', timeout: 25000 });
        const status = resp ? resp.status() : 0;
        await page.waitForTimeout(1500);
        console.log(`   ℹ️ [${src.store}] Cuponomia HTTP ${status}`);

        const found = await page.evaluate((storeName) => {
          const list = [];
          const items = Array.from(document.querySelectorAll('li[data-id], article, .item-code, .coupon-card'));

          for (const el of items) {
            if (list.length >= 6) break;
            const fullText = (el.innerText || '').replace(/\s+/g, ' ').trim();

            const isVerified = /verificado|testado|funcionou|aprovado/i.test(fullText);
            if (!isVerified) continue;

            const codeAttr = el.getAttribute('data-code') || el.querySelector('[data-code]')?.getAttribute('data-code') || '';
            const codeEl = el.querySelector('.code, [class*="coupon-code"], code');
            const code = (codeAttr || codeEl?.textContent || '').trim().toUpperCase();

            if (!code || code.length < 4 || code.length > 25 || /\s/.test(code)) continue;

            const titleEl = el.querySelector('h2, h3, .item-title, [class*="title"]');
            const desc = (titleEl?.textContent || fullText).slice(0, 120).trim();

            let minVal = 0;
            const minMatch = desc.match(/acima de\s*R\$\s*([\d.]+)/i) || desc.match(/mínim[oa].*?R\$\s*([\d.]+)/i);
            if (minMatch) minVal = Number(minMatch[1].replace(/\./g, '')) || 0;

            list.push({
              store: storeName,
              code,
              description: desc,
              minValue: minVal,
              source: 'Cuponomia (Verificado)',
            });
          }
          return list;
        }, src.store);

        console.log(`   ✅ ${found.length} cupons verificados encontrados para ${src.store}.`);
        verifiedCoupons.push(...found);
      } catch (err) {
        console.warn(`   ⚠️ Não foi possível ler cupons de ${src.store}: ${err.message}`);
      }
    }
  } finally {
    await context.close();
  }

  return verifiedCoupons;
}

// ===========================================================================
// FLUXO PRINCIPAL
// ===========================================================================
async function run() {
  console.log('==========================================================');
  console.log('🚀 RADAR DE OFERTAS — MERCADO LIVRE + SHOPEE + CUPONS');
  console.log(`⏰ Execução: ${new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })}`);
  console.log('==========================================================');

  const browser = await chromium.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--window-size=1366,900',
    ],
  });

  try {
    const mlItems = await scrapeMercadoLivre(browser);

    let shopeeItems = [];
    if (SHOPEE_APP_ID && SHOPEE_SECRET) {
      try {
        shopeeItems = await fetchShopeeViaOfficialApi();
      } catch (apiErr) {
        console.warn('⚠️ Falha na Shopee Open API, usando fallback Playwright:', apiErr.message);
        shopeeItems = await scrapeShopeePlaywright(browser);
      }
    } else {
      shopeeItems = await scrapeShopeePlaywright(browser);
    }

    const verifiedCoupons = await scrapeTrustedCoupons(browser);

    const allItems = [];
    const maxLen = Math.max(mlItems.length, shopeeItems.length);
    for (let i = 0; i < maxLen; i++) {
      if (mlItems[i]) allItems.push(mlItems[i]);
      if (shopeeItems[i]) allItems.push(shopeeItems[i]);
    }

    console.log('\n==========================================================');
    console.log(`📊 RESUMO: ${mlItems.length} Mercado Livre | ${shopeeItems.length} Shopee | ${verifiedCoupons.length} Cupons Verificados`);
    console.log('==========================================================');

    if (allItems.length === 0 && verifiedCoupons.length === 0) {
      console.warn('⚠️ Nenhum item ou cupom coletado nesta execução.');
      return;
    }

    if (!GAS_WEBHOOK_URL) {
      console.warn('⚠️ GAS_WEBHOOK_URL não configurado. Exibindo amostra local:');
      console.log(JSON.stringify(allItems.slice(0, 3), null, 2));
      return;
    }

    console.log(`📤 Enviando ${allItems.length} ofertas e ${verifiedCoupons.length} cupons para o Google Apps Script...`);
    const response = await fetch(GAS_WEBHOOK_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'Radar-Ofertas-Bot/2.0',
      },
      body: JSON.stringify({
        source: 'github_scraper',
        timestamp: new Date().toISOString(),
        items: allItems,
        coupons: verifiedCoupons,
      }),
      redirect: 'follow',
    });

    const respText = await response.text();
    console.log(`📬 Resposta do Google Apps Script (HTTP ${response.status}): ${respText}`);
    console.log('🎉 Sincronização concluída!');
  } catch (err) {
    console.error('❌ Erro fatal na execução:', err);
    process.exitCode = 1;
  } finally {
    await browser.close();
  }
}

run();
