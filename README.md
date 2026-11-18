# ⚡ Sistema Autônomo de Ofertas Mercado Livre Afiliados

Sistema 100% gratuito e autônomo de curadoria, conversão de links e publicação de ofertas do Mercado Livre Afiliados com arquitetura híbrida serverless:

- **GitHub Actions (Node.js + Playwright)**: Scraping automatizado com User-Agent real e conversão de links a cada 3 horas.
- **Google Sheets & Google Apps Script**: Banco de dados relacional sem custos, fila inteligente com deduplicação e triggers por tempo.
- **Groq API (`llama-3.3-70b-versatile`)**: Geração de copywriting persuasivo em altíssima velocidade.
- **Telegram Bot**: Canal de transmissão com imagens, botões de afiliado e processamento instantâneo de links manuais enviados pelo celular.
- **Vitrine Web (GitHub Pages + Tailwind CSS)**: Página web estática responsiva com busca em tempo real e cálculo de descontos.

---

## 🏗️ Arquitetura do Sistema

```
[ Mercado Livre Ofertas ]
           │ (Scraping headless c/ Playwright a cada 3h)
           ▼
[ GitHub Actions Runner ]
           │ POST { source: "github_scraper", items: [...] }
           ▼
[ Google Apps Script (Web App) ] ◄── Envio manual via Telegram (Prioritário)
           │ Deduplica e armazena na planilha 'Fila'
           ▼
[ Google Sheets ('Fila') ]
           │ Trigger de 1 em 1 hora
           ▼
[ Groq API (Llama 3.3 70B) ] ──► Copy persuasiva c/ emojis e tags HTML
           │
           ▼
[ Telegram Bot (Canal) ] ──► Mensagem c/ foto + Botão "🛒 COMPRAR NO MERCADO LIVRE"
           │
           ▼
[ Vitrine GitHub Pages (docs/) ] ◄── GET últimos 60 itens publicados
```

---

## 🚀 Guia de Configuração em 5 Passos

### Passo 1: Criar o Bot no Telegram e Obter o ID do Canal

1. No Telegram, abra a conversa com o [@BotFather](https://t.me/BotFather) e envie o comando `/newbot`.
2. Escolha um nome e um `@username` terminado em `bot` (ex: `PromosMeliBot`).
3. O BotFather fornecerá o **HTTP API Token** (ex: `7123456789:AAFl...`). Guarde este valor (`TELEGRAM_BOT_TOKEN`).
4. Crie um Canal no Telegram (ou use um existente) onde as ofertas serão postadas:
   - Abra o perfil do canal > **Administradores** > **Adicionar Administrador**.
   - Busque pelo `@username` do seu bot criado e conceda permissão para **Postar Mensagens**.
5. Obtenha o ID do canal:
   - Se o canal for público: você pode usar diretamente o `@nome_do_canal` (ex: `@promos_imperdiveis_ml`).
   - Se o canal for privado: encaminhe qualquer mensagem dele para o bot [@userinfobot](https://t.me/userinfobot) ou [@JsonDumpBot](https://t.me/JsonDumpBot) para obter o ID numérico que começa com `-100` (ex: `-1002345678901`).

---

### Passo 2: Obter a Chave Gratuita da API Groq

1. Acesse o console da Groq: [console.groq.com/keys](https://console.groq.com/keys).
2. Faça login com sua conta do Google ou GitHub.
3. Clique em **Create API Key**.
4. Dê um nome (ex: `mercadolivre-bot`) e clique em **Submit**.
5. Copie a chave gerada (iniciada por `gsk_...`). Guarde este valor (`GROQ_API_KEY`).

> 💡 **Nota:** A Groq oferece uma cota gratuita generosa e suficiente para milhares de requisições mensais com o modelo ultrarrápido `llama-3.3-70b-versatile`.

---

### Passo 3: Configurar a Planilha Google e o Google Apps Script

1. Acesse o [Google Planilhas](https://sheets.new) e crie uma planilha em branco. Dê um nome a ela (ex: `Banco de Ofertas ML`).
2. No menu superior da planilha, clique em **Extensões** > **Apps Script**.
3. Apague todo o conteúdo que estiver no editor e cole na íntegra o código do arquivo [`google-apps-script/Code.gs`](google-apps-script/Code.gs).
4. No início do arquivo, substitua as constantes pelas suas credenciais:
   ```javascript
   const TELEGRAM_BOT_TOKEN = "7123456789:AAFl...";
   const TELEGRAM_CHANNEL_ID = "@seu_canal_aqui"; // ou -100...
   const GROQ_API_KEY = "gsk_...";
   const WEBAPP_URL = "SUA_WEBAPP_URL_AQUI"; // Deixe para preencher logo após a implantação
   const SHEET_NAME = "Fila";
   ```
5. No menu de funções (ao lado de *Depurar*), selecione a função **`setupPlanilha`** e clique em **Executar**:
   - Conceda as permissões de acesso solicitadas pelo Google.
   - Isso criará automaticamente a aba `Fila` com os cabeçalhos formatados em amarelo.
6. **Publicar o Web App:**
   - No canto superior direito, clique em **Implantar** (Deploy) > **Nova implantação**.
   - No ícone de engrenagem à esquerda, selecione **App da Web**.
   - Preencha:
     - **Descrição:** `API Ofertas ML Afiliados`
     - **Executar como:** `Eu (seu_email@gmail.com)`
     - **Quem pode acessar:** `Qualquer pessoa` (*Importante: permite que o GitHub Actions e o Telegram acessem o Webhook*).
   - Clique em **Implantar** e autorize o acesso.
   - Copie a **URL do app da Web** gerada (terminada em `/exec`).
7. Volte ao editor de código:
   - Cole a URL gerada na variável `const WEBAPP_URL = "https://script.google.com/macros/s/.../exec";`.
   - Clique em **Salvar** (ícone de disquete).
   - Selecione a função **`configurarWebhookTelegram`** e clique em **Executar**. O log confirmará: `🎉 Webhook vinculado com sucesso ao Telegram`.
8. **Configurar o Trigger Automático (Disparo de 1 em 1 hora):**
   - No menu lateral esquerdo do Apps Script, clique no ícone de relógio (**Acionadores** / Triggers).
   - Clique no botão azul **Adicionar Acionador** (canto inferior direito).
   - Configure:
     - **Função a ser executada:** `dispararProximaOferta`
     - **Origem do evento:** `Baseado no tempo`
     - **Tipo de acionador baseado no tempo:** `Contador de horas`
     - **Selecione o intervalo de horas:** `A cada hora` (ou de 2 em 2 horas)
     - **Configuração de notificação de falha:** `Notificar imediatamente`
   - Clique em **Salvar**.

---

### Passo 4: Configurar os Secrets no GitHub

No seu repositório no GitHub:

1. Vá em **Settings** > **Secrets and variables** > **Actions**.
2. Clique no botão **New repository secret** e adicione as seguintes chaves:

| Secret | Descrição | Exemplo |
| :--- | :--- | :--- |
| `GAS_WEBHOOK_URL` | A URL do Web App do Google Apps Script (gerada no Passo 3) | `https://script.google.com/macros/s/.../exec` |
| `ML_AFFILIATE_TAG` | Parâmetros da sua tag de afiliado do Mercado Livre | `matt_tool=12345678&matt_word=promos` |
| `ML_COOKIES_JSON` | *(Opcional)* Array JSON com os cookies de sessão autenticada | `[{"name":"ssid","value":"..."},...]` |

3. **Como testar o pipeline imediatamente:**
   - Vá na aba **Actions** do seu repositório no GitHub.
   - No menu lateral, clique em **Pipeline de Ofertas Mercado Livre**.
   - Clique no menu suspenso **Run workflow** > botão verde **Run workflow**.
   - O GitHub iniciará o container Ubuntu, abrirá o Playwright em modo headless, extrairá os 15 melhores produtos com URLs limpas e enviará para a sua planilha Google.

---

### Passo 5: Ativar a Vitrine Web no GitHub Pages

1. Abra o arquivo [`docs/index.html`](docs/index.html) no seu repositório.
2. Na linha 256, substitua a constante `GAS_API_URL` pela URL do seu Web App:
   ```javascript
   const GAS_API_URL = "https://script.google.com/macros/s/.../exec";
   ```
3. Faça o commit e push da alteração na branch principal (`main`).
4. No GitHub, vá em **Settings** > **Pages** (no menu lateral esquerdo).
5. Na seção **Build and deployment**:
   - **Source:** `Deploy from a branch`
   - **Branch:** selecione `main` e a pasta `/docs`
   - Clique em **Save**.
6. Aguarde cerca de 1 minuto. O GitHub disponibilizará sua vitrine online em `https://seu-usuario.github.io/seu-repositorio/`.

---

## 📱 Recursos Adicionais

### Envio de Ofertas Manuais pelo Celular
Sempre que você encontrar uma promoção no app ou site do Mercado Livre enquanto usa o smartphone:
1. Copie o link do produto ou clique em **Compartilhar**.
2. Envie o link diretamente em uma mensagem privada para o seu Bot no Telegram.
3. O bot responderá confirmando a captura dos dados (OpenGraph), salvará o item com status `PRIORIDADE` e fará a publicação imediata no seu canal!

### Estrutura dos Arquivos do Projeto

```
├── .github/
│   └── workflows/
│       └── pipeline_ofertas.yml # Agendamento Cron e Workflow do Actions
├── docs/
│   └── index.html               # Vitrine Web para GitHub Pages (Tailwind CSS)
├── google-apps-script/
│   └── Code.gs                  # Código completo para o Apps Script
├── package.json                 # Manifesto do projeto e dependência do Playwright
├── scraper.js                   # Scraper headless Node.js com Playwright
└── README.md                    # Documentação e guia completo de implantação
```

---

## 🛡️ Licença
Distribuído sob a licença MIT. Livre para uso pessoal e comercial.
