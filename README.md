# WorldFellas — Setup & Deploy (micro-passos)

A Copa começa 11/06 às 16h. Ordem de execução pensada pra estar no ar hoje.

## Fase A — Contas e chaves (~15 min, faça ANTES de abrir o Claude Code)

1. [ ] **Firebase** (console.firebase.google.com): criar projeto `worldfellas`
2. [ ] No projeto: **Build → Authentication → Sign-in method → Anonymous → Enable**
3. [ ] **Build → Realtime Database → Create database** (modo bloqueado, tanto faz — vamos subir regras)
4. [ ] Aba **Rules** do RTDB: colar o conteúdo de `database.rules.json` → Publish
5. [ ] **⚙️ Project settings → General → Your apps → Web app (`</>`)**: registrar e copiar o objeto `firebaseConfig`
6. [ ] **⚙️ Project settings → Service accounts → Database secrets → Show**: copiar o secret (vai pro Netlify, NUNCA pro código)
7. [ ] **football-data.org**: você já tem o token (⚠️ ele vazou no print — considere pedir regeneração por e-mail ao Daniel)
8. [ ] Definir um **PIN de admin** (4–6 dígitos que só você sabe)

## Fase B — Claude Code (~1–2h de execução supervisionada)

9. [ ] Criar pasta do projeto e copiar pra dentro: `CLAUDE.md`, `README.md`, `database.rules.json`, `netlify.toml`, `netlify/functions/` (3 arquivos), `assets/avatars/`
10. [ ] Soltar as **caricaturas** em `assets/avatars/{slug}.png` (slug = apelido minúsculo, ex: `parah.png`)
11. [ ] Abrir o Claude Code na pasta e colar o prompt de `PROMPT-KICKOFF.md`
12. [ ] Quando ele pedir: colar o `firebaseConfig` e a lista do ROSTER (slug + nome de cada amigo)
13. [ ] Testar local: `npx netlify-cli dev` com `.env` contendo as 4 variáveis (não commitar o .env)

## Fase C — Deploy (~15 min)

14. [ ] Repo no GitHub (privado) → push
15. [ ] Netlify → **Add new site → Import from GitHub** → selecionar o repo (build vazio, publish `.` — o netlify.toml já configura)
16. [ ] **Site settings → Environment variables**, criar:
    - `FOOTBALL_DATA_TOKEN` = token da football-data.org
    - `FIREBASE_DB_URL` = https://SEU-PROJETO-default-rtdb.firebaseio.com
    - `FIREBASE_DB_SECRET` = secret do passo 6
    - `ADMIN_PIN` = seu PIN
    - `LIVESCORE_API_KEY` = api key da live-score-api.com
    - `LIVESCORE_API_SECRET` = api secret da live-score-api.com
    - (as duas últimas são opcionais — sem elas, `live-sync` só fica ocioso)
17. [ ] Deploy → abrir `https://seusite.netlify.app/#admin` → PIN → **Sincronizar agora** (popula os 104 jogos)
18. [ ] Conferir: jogos aparecem, palpite salva, countdown rodando
19. [ ] **Mandar o link no grupo** + cobrar os bônus ANTES das 16h de amanhã 🔥

## Operação durante a Copa

- Sync roda sozinho a cada 15 min. Se um placar demorar >1h após o fim do jogo: `#admin → Corrigir placar` (cria trava manual; a API não sobrescreve).
- `live-sync` roda a cada 1 min e atualiza status/placar ao vivo via live-score-api.com (só durante a janela do jogo, pra economizar chamadas). Se o nome de algum time não bater entre os dois provedores, o jogo fica "ao vivo" no football-data normalmente, mas sem placar minuto a minuto — adicionar o apelido em `ALIASES` no `live-sync.js`.
- Gabarito dos bônus: preencher em `#admin → Gabarito` conforme a Copa define (campeão, artilheiro etc. — campos vazios não pontuam).
- Amigo trocou de celular: `#admin → Liberar identidade`.

## Onda 3 (semana 1 da Copa — backlog)
Badges da rodada (🥬 Mão de Alface, 🔮 Mãe Diná), Mural da Vergonha, recap diário copiável pro WhatsApp.
