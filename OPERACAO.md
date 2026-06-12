# CupFellas — Guia de Operação

Tudo que você precisa pra **publicar**, **manter** e **rodar o robô de avisos**. Pensado pra você não depender de lembrar nada.

---

## 1. Mapa do projeto

| Parte | Onde | O que faz |
|---|---|---|
| App (site) | `index.html` | Front inteiro (vanilla JS + Firebase). Palpites, ranking, badges, reações, resenha, alavanca. |
| Sync de jogos | `netlify/functions/sync.js` (cron 15min) | football-data.org → Firebase (placar final). |
| Placar ao vivo | `netlify/functions/live-sync.js` (cron 1min) | livescore-api.com → Firebase (status/placar ao vivo). |
| Admin | `netlify/functions/admin.js` | Ações com PIN (sync manual, corrigir placar, gabarito, liberar identidade). |
| CazéTV (experimento) | `netlify/functions/caze.js` | Acha o vídeo do jogo (só localhost no front). |
| Robô de avisos | `rats/worldfellas-triggers.js` | Lê a alavanca e manda WhatsApp + push (gol, início, bom-dia, quarta). |
| Recap antigo | `rats/worldfellas-recap.js` | Recap diário simples (superado pelo "bom dia" do robô). |

**Firebase:** projeto `cupfellas-1be8b` · RTDB `https://cupfellas-1be8b-default-rtdb.firebaseio.com`
**Site:** https://cupfellas-bolao.netlify.app · **Netlify:** conta `pedro.mello@hotmart.com` (team `vicq`)

---

## 2. Deploy do site (Netlify, manual, sem git)

```bash
cd C:\PEDRO\CODE\WorldFellas
# precisa do NETLIFY_AUTH_TOKEN no ambiente (token pessoal do Netlify)
npx netlify-cli deploy --prod --dir .
```

> ⚠️ Se vier **"Account credit usage exceeded"**: a cota da Netlify estourou. Libere créditos no painel ou espere o reset mensal. Deploys ficam bloqueados até lá.

**Variáveis de ambiente no Netlify** (Site settings → Environment): `FOOTBALL_DATA_TOKEN`, `FIREBASE_DB_URL`, `FIREBASE_DB_SECRET`, `ADMIN_PIN`, `LIVESCORE_API_KEY`, `LIVESCORE_API_SECRET`.

---

## 3. Regras do Firebase (publicar à parte!)

As regras **NÃO** sobem no deploy do Netlify. Sempre que mudar `database.rules.json`:

1. Firebase Console → **Realtime Database → aba Rules**
2. Cole o conteúdo de `database.rules.json` → **Publish**

Sem isso, **alavanca, reações, resenha e push são negados** (permission_denied).

---

## 4. PWA / ícone no celular

- O ícone é a taça (`assets/icons/`). Gerado por `assets/icons/make_icons.py` (`python make_icons.py`).
- Trocou o ícone? **Desinstale e reinstale** o PWA no celular — o ícone antigo fica em cache.
- Pra instalar: abrir o site no navegador → "Adicionar à tela inicial".

---

## 5. Operação durante a Copa (rotina)

- **Sync roda sozinho** (15min final / 1min ao vivo). Placar travado >1h depois do fim? → `#admin → Corrigir placar` (cria trava manual; a API não sobrescreve).
- **Gabarito dos bônus**: `#admin → Gabarito`, conforme a Copa define (campos vazios não pontuam).
- **Trocou de celular**: `#admin → Liberar identidade`.
- **Admin**: abrir `https://worldfellas-bolao.netlify.app/#admin` → PIN.

---

## 6. 🎚️ Robô de avisos (a alavanca)

### Como funciona
- No app, **qualquer um** liga/desliga a alavanca "📣 Avisos no Zap" (topo do Bolão) e ajusta as opções no ⚙️.
- Isso grava em `/triggers` no Firebase.
- O robô `rats/worldfellas-triggers.js` lê `/triggers` e dispara as mensagens. **Se a alavanca mestre estiver desligada, nada sai.**

### Ocasiões
| Opção | Quando | Gatilho |
|---|---|---|
| ⚽ Gol | placar sobe num jogo ao vivo | poll de 45s em `/matches` |
| 🟢 Início de jogo | jogo vira IN_PLAY | poll de 45s |
| ☀️ Bom dia | 09:00 todo dia | cron — ranking + jogos do dia |
| 📊 Panorama | quarta 12:00 | cron — classificação |

### Setup (uma vez)
```bash
cd C:\PEDRO\CODE\rats
npm install web-push          # necessário pro push (notificação com app fechado)
```
No `.env` do rats:
```
WHATSAPP_GROUP_NAME=Goodfellas        # grupo de produção
WHATSAPP_TEST_GROUP_NAME=Alfred       # grupo de teste
VAPID_PUBLIC=BE3G-0CKVn4HeLe5vN2pD7IFxG_KIvG9XQDq3-b3L0Pg4YFXQ7JGbRPwWIoAbCUvqfQ5tGsYGCwHy2UWFcWSycQ
VAPID_PRIVATE=<sua chave privada — NUNCA commitar>
VAPID_SUBJECT=mailto:bolao@cupfellas.app
# opcionais: POLL_MS=45000  CRON_DAILY="0 9 * * *"  CRON_WEEKLY="0 12 * * 3"
```
> A `VAPID_PUBLIC` também está fixa no `index.html`. Se trocar o par de chaves, troque nos dois lugares.

### Rodar (deixar vivo durante os jogos)
```bash
node worldfellas-triggers.js --prod      # grupo de produção
node worldfellas-triggers.js             # grupo de teste (Alfred)
node worldfellas-triggers.js --prod --dry  # imprime, não envia (pra conferir)
```
- 1ª execução pede o **QR do WhatsApp** (mesma sessão do rats). Depois fica salvo.
- O robô fica vivo: poll dos eventos + crons. Pra avisos de **gol/início** funcionarem, ele precisa estar **ligado durante o jogo**.

### Push (notificação com o app fechado)
- A pessoa precisa abrir o app uma vez e tocar no 🔔 (autoriza notificação → inscreve em `/pushSubs`).
- O robô lê `/pushSubs` e dispara o push junto com o WhatsApp.
- iOS: só funciona com o **PWA instalado** (iOS 16.4+).

---

## 7. Chaves e segredos (resumo)

| Segredo | Onde vive | Commitar? |
|---|---|---|
| FIREBASE_DB_SECRET, ADMIN_PIN, tokens de API | Env do Netlify | ❌ |
| VAPID_PRIVATE | `.env` do rats | ❌ |
| VAPID_PUBLIC | `.env` do rats + `index.html` | ✅ (é público) |
| Sessão do WhatsApp | `rats/data/whatsapp-session` | ❌ |

---

## 8. Troubleshooting rápido

| Sintoma | Causa provável | Solução |
|---|---|---|
| Deploy "Forbidden / credit exceeded" | cota Netlify | liberar créditos / esperar reset |
| Alavanca/reações não salvam | regras não publicadas | publicar `database.rules.json` no Firebase |
| Ícone do PWA vazio | cache do install antigo | desinstalar e reinstalar o PWA |
| Robô não manda gol | robô desligado ou alavanca off | rodar o robô + ligar a alavanca no app |
| Push não chega | sem `web-push`/VAPID, ou não autorizou 🔔 | `npm install web-push` + VAPID + tocar no 🔔 |
| Placar ao vivo parado | live-sync sem créditos da livescore-api | conferir `LIVESCORE_API_*` / plano |
