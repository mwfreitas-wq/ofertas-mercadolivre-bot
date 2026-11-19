<?php
/**
 * scraper.php - Versão leve em PHP para rodar via Cron Job no HostGator (Plano M / cPanel)
 * Não precisa de Playwright/Chromium.
 */

// ========================== CONFIGURAÇÕES ==========================
$GAS_WEBHOOK_URL = 'https://script.google.com/macros/s/AKfycbxqLd4weUfIuY1Qu6pUq3CLPlKAlBltvavKBQ3weMzP1bdL7FljcpMRGsBusxh3hYZjig/exec';
$ML_AFFILIATE_TAG = 'matt_tool=63310789&matt_word=ms20251105065623';
$MAX_ITEMS = 15;
$TARGET_URL = 'https://www.mercadolivre.com.br/ofertas';
// ===================================================================

header('Content-Type: text/plain; charset=utf-8');

echo "🚀 Iniciando Scraper PHP no HostGator...\n";

// 1. Baixa o HTML da página de ofertas do Mercado Livre
$ch = curl_init($TARGET_URL);
curl_setopt_array($ch, [
    CURLOPT_RETURNTRANSFER => true,
    CURLOPT_FOLLOWLOCATION => true,
    CURLOPT_TIMEOUT => 30,
    CURLOPT_ENCODING => '',
    CURLOPT_HTTPHEADER => [
        'User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
        'Accept: text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language: pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7',
    ],
]);

$html = curl_exec($ch);
$httpCode = curl_getinfo($ch, CURLINFO_HTTP_CODE);
$curlErr = curl_error($ch);
curl_close($ch);

echo "📡 Status HTTP Mercado Livre: $httpCode\n";

if ($curlErr || $httpCode >= 400 || empty($html)) {
    echo "❌ Falha ou bloqueio ao acessar Mercado Livre (HTTP $httpCode): $curlErr\n";
    if ($httpCode === 403) {
        echo "⚠️ O IP deste servidor HostGator também está bloqueado (403) pelo Mercado Livre.\n";
    }
    exit(1);
}

// 2. Extrai os cards de produtos via DOMDocument + XPath
libxml_use_internal_errors(true);
$dom = new DOMDocument();
$dom->loadHTML('<?xml encoding="utf-8" ?>' . $html);
$xpath = new DOMXPath($dom);

$cards = $xpath->query("//*[contains(@class, 'poly-card') or contains(@class, 'promotion-item')]");
echo "📦 Cards encontrados no HTML: " . $cards->length . "\n";

$items = [];
$seenIds = [];

foreach ($cards as $card) {
    if (count($items) >= $MAX_ITEMS) break;

    // Link
    $links = $xpath->query(".//a[contains(@href, 'mercadolivre.com') or contains(@href, '/MLB') or contains(@href, '/p/')]", $card);
    if ($links->length === 0) continue;
    $rawUrl = $links->item(0)->getAttribute('href');
    if (empty($rawUrl) || strpos($rawUrl, '/ofertas') !== false) continue;

    $cleanUrl = strtok($rawUrl, '?#');

    // ID MLB
    $id = '';
    if (preg_match('/(ML[A-Z]?-?\d+)/i', $cleanUrl, $m)) {
        $id = strtoupper(str_replace('-', '', $m[1]));
    } else {
        $id = 'MLB-' . time() . '-' . count($items);
    }

    if (isset($seenIds[$id])) continue;
    $seenIds[$id] = true;

    // Título
    $titleNodes = $xpath->query(".//*[contains(@class, 'poly-component__title') or contains(@class, 'promotion-item__title') or self::h2 or self::h3]", $card);
    $title = $titleNodes->length > 0 ? trim($titleNodes->item(0)->textContent) : '';
    if (empty($title)) continue;

    // Preço atual
    $priceNodes = $xpath->query(".//*[contains(@class, 'poly-price__current')]//*[contains(@class, 'andes-money-amount__fraction')] | .//*[contains(@class, 'andes-money-amount__fraction')]", $card);
    $price = 'Confira no link';
    if ($priceNodes->length > 0) {
        $frac = preg_replace('/\D/', '', $priceNodes->item(0)->textContent);
        if (!empty($frac)) {
            $price = 'R$ ' . $frac . ',00';
        }
    }

    // Preço antigo
    $oldNodes = $xpath->query(".//s//*[contains(@class, 'andes-money-amount__fraction')] | .//*[contains(@class, 'andes-money-amount--previous')]//*[contains(@class, 'andes-money-amount__fraction')]", $card);
    $oldPrice = null;
    if ($oldNodes->length > 0) {
        $oldFrac = preg_replace('/\D/', '', $oldNodes->item(0)->textContent);
        if (!empty($oldFrac)) {
            $oldPrice = 'R$ ' . $oldFrac . ',00';
        }
    }

    // Imagem
    $imgNodes = $xpath->query(".//img", $card);
    $image = 'https://http2.mlstatic.com/frontend-assets/ui-navigation/5.19.5/mercadolibre/logo__large_plus.png';
    if ($imgNodes->length > 0) {
        $imgEl = $imgNodes->item(0);
        $dataSrc = $imgEl->getAttribute('data-src');
        $src = $imgEl->getAttribute('src');
        if (!empty($dataSrc) && strpos($dataSrc, 'data:') !== 0) {
            $image = $dataSrc;
        } elseif (!empty($src) && strpos($src, 'data:') !== 0) {
            $image = $src;
        }
        $image = str_replace(['-I.jpg', '-I.webp'], ['-O.jpg', '-O.webp'], $image);
    }

    $affiliateUrl = $cleanUrl . (strpos($cleanUrl, '?') !== false ? '&' : '?') . $ML_AFFILIATE_TAG;

    $items[] = [
        'id' => $id,
        'title' => $title,
        'oldPrice' => $oldPrice,
        'price' => $price,
        'image' => $image,
        'cleanUrl' => $cleanUrl,
        'affiliateUrl' => $affiliateUrl,
    ];
}

echo "✨ Produtos válidos extraídos: " . count($items) . "\n";

if (count($items) === 0) {
    echo "⚠️ Nenhum produto extraído do HTML.\n";
    exit(0);
}

// 3. Envia para o Google Apps Script
$payload = json_encode([
    'source' => 'github_scraper',
    'timestamp' => gmdate('c'),
    'items' => $items,
]);

$chGas = curl_init($GAS_WEBHOOK_URL);
curl_setopt_array($chGas, [
    CURLOPT_RETURNTRANSFER => true,
    CURLOPT_FOLLOWLOCATION => true,
    CURLOPT_POST => true,
    CURLOPT_POSTFIELDS => $payload,
    CURLOPT_TIMEOUT => 30,
    CURLOPT_HTTPHEADER => [
        'Content-Type: application/json',
        'User-Agent: ML-Affiliate-Bot-PHP/1.0',
    ],
]);

$gasResp = curl_exec($chGas);
$gasCode = curl_getinfo($chGas, CURLINFO_HTTP_CODE);
curl_close($chGas);

echo "📬 Resposta do Google Apps Script (HTTP $gasCode): $gasResp\n";
echo "🎉 Finalizado!\n";
