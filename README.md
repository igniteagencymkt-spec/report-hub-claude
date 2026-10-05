# ignite. report hub

Hub de relatórios de Meta Ads — login próprio, uma conta por cliente, métricas
escolhidas por você, tudo buscado ao vivo na Graph API (nada fica salvo em
banco). Pensado pra substituir o Reportei.

## Infra

- **Frontend**: `index.html` + `app.js` + `styles.css`, sem build step, hospedado no GitHub Pages.
- **Backend**: Supabase (projeto `report-hub-claude`, `wnjvifnspcyghrhezshl`)
  - Tabelas: `hub_clients`, `hub_connected_accounts`, `hub_report_configs` (RLS por usuário).
  - Edge Functions: `meta-oauth-exchange` (troca o code do login Facebook por token de longa duração) e `meta-proxy` (repassa qualquer chamada autenticada pra Graph API).

## Estado atual: conexão por token manual

Enquanto o Facebook App não tem **Advanced Access** aprovado pela Meta, conectar
uma conta de cliente é feito colando o ID da conta + um access token gerado no
Business Manager (em vez do popup "Continuar com Facebook"). Funciona 100% pro
relatório — só não tem o "clica e loga" ainda.

## Como liberar o login com Facebook (popup real)

1. Acesse https://developers.facebook.com/apps e crie um app do tipo **Business**.
2. Em **Configurações básicas**, anote o **App ID** e o **App Secret**.
3. Adicione o produto **Facebook Login** → em **Configurações**, cadastre a
   Redirect URI: a URL onde este site está publicado (ex.:
   `https://relatorios.ignitemarketing.com.br/`).
4. Em **Revisão do app → Permissões e recursos**, peça **Advanced Access** para:
   - `ads_read`
   - `business_management`
   Isso exige verificação da sua Business Manager e passa por revisão da Meta
   (alguns dias).
5. Depois de aprovado, edite `config.js` e preencha `FB_APP_ID` com o App ID.
6. Nas secrets da Edge Function `meta-oauth-exchange` (Supabase Dashboard →
   Edge Functions → meta-oauth-exchange → Secrets), adicione:
   - `FB_APP_ID`
   - `FB_APP_SECRET`
7. Me avise — eu troco o botão de token manual pelo popup de login de
   verdade (o resto do sistema não muda).

## Publicar num subdomínio seu (HostGator)

1. No GitHub, vá em **Settings → Pages** deste repositório e confirme que
   está publicando a partir da branch `main` (já configurado).
2. No painel do HostGator (cPanel → Zone Editor ou DNS), crie um registro:
   - Tipo: `CNAME`
   - Nome: `relatorios` (ou o subdomínio que preferir)
   - Valor: `igniteagencymkt-spec.github.io`
3. No GitHub → Settings → Pages → Custom domain, digite
   `relatorios.ignitemarketing.com.br` e salve.
4. Espera propagar (minutos a algumas horas) e o hub passa a abrir nesse
   endereço, com HTTPS automático.
