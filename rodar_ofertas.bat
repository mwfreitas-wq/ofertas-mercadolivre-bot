@echo off
chcp 65001 >nul
cd /d "%~dp0"

echo ============================================================
echo   RADAR DE OFERTAS - MERCADO LIVRE + SHOPEE + CUPONS
echo ============================================================

REM Configuracoes principais
set GAS_WEBHOOK_URL=https://script.google.com/macros/s/AKfycbxqLd4weUfIuY1Qu6pUq3CLPlKAlBltvavKBQ3weMzP1bdL7FljcpMRGsBusxh3hYZjig/exec
set ML_AFFILIATE_TAG=matt_tool=63310789^&matt_word=ms20251105065623

REM Shopee Afiliados (ID an_18330020154)
set SHOPEE_AFFILIATE_TAG=utm_source=an_18330020154^&utm_medium=affiliates^&mmp_pid=an_18330020154
REM Preencha abaixo quando a Shopee Open API for liberada na sua conta
REM set SHOPEE_APP_ID=SEU_SHOPEE_APP_ID
REM set SHOPEE_SECRET=SEU_SHOPEE_SECRET

if not exist "node_modules" (
  echo Instalando dependencias pela primeira vez...
  call npm install
  call npx playwright install chromium
)

echo Executando coleta de ofertas e cupons verificados...
node scraper.js

echo.
echo Concluido!
