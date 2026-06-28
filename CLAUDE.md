# WORLDFELLAS — Bolão da Copa 2026

Bolão privado para 6–15 amigos. Copa do Mundo 2026 (EUA/México/Canadá, 104 jogos, começa 11/06/2026 16h — jogo 1: México x África do Sul). Referência visual e de regras: bolão "De Sola" (dark + dourado). Tom: **zoeira séria** — layout sóbrio de placar de estádio, copy debochada.

## REGRA ZERO PARA O EXECUTOR

- Os arquivos `netlify/functions/sync-core.js`, `netlify/functions/sync.js`, `netlify/functions/admin.js`, `netlify.toml` e `database.rules.json` **já existem e estão prontos. NÃO reescrever, NÃO alterar** (exceto bug real encontrado em teste — justificar antes).
- Seu trabalho é construir o **front**: `index.html` (app completo em arquivo único, vanilla JS + Firebase compat via CDN) e validar o conjunto.
- Sem framework, sem build step. `npm` só se precisar do `netlify-cli` para testar functions localmente.
- Não usar localStorage para estado crítico (só cache de conveniência); fonte de verdade é o Firebase RTDB.

## LOOP DE RENDER — REGRA INVIOLÁVEL (não reabrir o bug de 22/06)

O app é realtime: ~17 listeners do RTDB atualizam o estado o tempo todo (no jogo ao vivo, `/matches` a cada ~2s + presence/activity dos outros). **Reconstruir a tela inteira a cada evento trava o app e ARRANCA o `<input>` debaixo do dedo de quem digita** (teclado do celular cai, número some). Por isso:

- **NUNCA** chamar `renderScreen()` / `renderSidebar()` / `renderRail()` direto dentro de um listener ou de `onData()`. Os listeners só MARCAM o que sujou via `requestRender({sidebar?,rail?,screen?})`; o render roda 1× por frame (`runRender`, via `requestAnimationFrame`). Chamada direta de `renderScreen()` só em ação do usuário (navegação, botão, admin).
- **Enquanto um input está focado** (`isEditingInput()` → palpite `[data-mid][data-side]` ou `[data-chat]`), o render da tela fica ADIADO (`_screenDeferred`) e só descarrega no `blur` (`flushDeferredScreen`). Não destruir o input em uso.
- Eventos que só afetam a coluna da direita (`presence`, `activity`) entram como **rail-only** — não sujam a tela.
- Todo input de placar passa por `mkInput`, que grava cada tecla no buffer `_draft[mid]` (par incompleto sobrevive a rebuild). Novo input editável segue esse padrão.
- Se algum dia o rebuild ainda pesar, o passo seguinte é card persistente (patch in-place) no molde do feed (`_feedEls`/`renderFeedList`), **nunca** voltar ao teardown total.

## STACK E ARQUITETURA

```
index.html (app único, vanilla JS + Firebase compat CDN 10.x)
  └─ Firebase Realtime Database  ← leitura em tempo real (on listeners)
  └─ Firebase Anonymous Auth     ← identidade por dispositivo
  └─ /.netlify/functions/admin   ← ações de admin (PIN server-side)
netlify/functions/sync.js        ← cron */15min: football-data.org → RTDB (PRONTO)
netlify/functions/admin.js       ← sync manual, corrigir placar, bônus, liberar claim (PRONTO)
```

Env vars no Netlify (o usuário configura, documentado no README): `FOOTBALL_DATA_TOKEN`, `FIREBASE_DB_URL`, `FIREBASE_DB_SECRET`, `ADMIN_PIN`.

No topo do `index.html`, bloco de configuração claramente marcado:

```js
// ════════ CONFIGURAÇÃO — PREENCHER ════════
const FIREBASE_CONFIG = { apiKey: "...", databaseURL: "...", projectId: "...", appId: "..." };
const ROSTER = [
  // slug: minúsculo sem espaço; avatar: assets/avatars/{slug}.png (fallback automático p/ inicial)
  { slug: "pedro",  name: "PEDRO"  },
  { slug: "exemplo", name: "EXEMPLO" },
];
// ═══════════════════════════════════════════
```

## MODELO DE DADOS (RTDB)

```
/meta            { lockBonusAt: epochMs, lastSync: epochMs }
/matches/{id}    { id, stage, group, matchday, utcDate, kickoffMs, status,
                   home:{name,tla,crest}, away:{...}, score:{home,away}, winner90, venue }
                   // status: TIMED|SCHEDULED|IN_PLAY|PAUSED|FINISHED|POSTPONED...
                   // score = resultado dos 90min (sync-core já trata prorrogação)
/standings       [ { group, table:[{pos,name,crest,p,pts,gf,ga,gd}] } ]
/scorers         [ { name, team, crest, goals } ]
/claims/{slug}   { uid }                          // vínculo identidade↔dispositivo
/participants/{uid} { slug, name }                // espelho p/ conveniência
/palpites/{uid}/{matchId} { h, a, ts }
/bonus/{uid}     { campeao, artilheiro, melhorAtaque, melhorDefesa, neymar, brasilFase }
/bonusAnswers    { campeao, artilheiros, melhorAtaque, melhorDefesa, neymar, brasilFase }
                   // gabarito; preenchido pelo admin; campos vazios = não pontua ainda
/manualLocks/{matchId} true                        // placar corrigido na mão, sync ignora
```

Segurança (já em `database.rules.json`): leitura pública; cada uid só escreve nos próprios palpites e só antes do `kickoffMs`; bônus trava em `meta.lockBonusAt`; claim só se livre. Resultados/standings só entram via functions (secret server-side).

## IDENTIDADE (sem senha, com proteção)

1. App abre → `signInAnonymously()` silencioso.
2. Se o uid não tem `/participants/{uid}` → overlay fullscreen "**QUEM É VOCÊ NO WORLDFELLAS?**": grade de cards do ROSTER com caricatura grande + nome. Já claimados aparecem desbotados com selo "já tem dono 🔒". Clique em livre → `transaction` em `/claims/{slug}` (só grava se vazio; se perder a corrida, toast "ih, te roubaram o nome — fala com o admin") → grava `/participants/{uid}`.
3. Identidade fica fixa no dispositivo. Header mostra chip "Você é {AVATAR} {NOME}". Clique no chip → modal explicando que troca de identidade só via admin (anti-roubo de palpite).
4. Trocou de celular: admin libera o claim (`releaseClaim`) e a pessoa entra de novo.

## PONTUAÇÃO

Jogos (só `status === FINISHED`):
- Placar exato: **+3** · Resultado certo, placar errado: **+1** · Errou: **0**
- Mata-mata: vale o resultado dos 90 min (campo `score`/`winner90` já vem tratado).

Bônus (gabarito em `/bonusAnswers`, comparação case-insensitive/trim; artilheiro pode ter múltiplos nomes separados por vírgula no gabarito):
| Bônus | Pts |
|---|---|
| Campeão | 10 |
| Artilheiro | 8 |
| Melhor ataque da fase de grupos | 5 |
| Melhor defesa da fase de grupos | 5 |
| Neymar faz pelo menos 1 gol? (sim/não) | 3 |
| Desempenho do Brasil (acertar a fase exata em que para) | grupos 2 · 16-avos 4 · oitavas 6 · quartas 8 · semi 10 · vice 13 · campeão 17 |

Classificação: total desc; desempate por nº de placares exatos (mostrado como "pts (exatos)"). Persistir nada de pontuação no banco — **tudo computado no cliente** a partir de palpites + resultados + gabarito (determinístico).

## TELAS (hash routing: #palpites, #todos, #tracker, #ranking, #admin)

Layout: desktop = sidebar esquerda com Classificação compacta sempre visível + conteúdo; mobile-first = nav em abas no topo, classificação vira tela própria. Header global: logo WORLDFELLAS, countdown "FALTAM 01d 17h 16m 23s PRO VEXAME COMEÇAR" (até `meta.lockBonusAt`; depois vira "🔴 A COPA TÁ ROLANDO"), chip de identidade.

### 1. Meus palpites (default) — sub-abas: Próximos jogos · Fase de grupos · Mata-mata · Bônus
- **Próximos jogos**: jogos de hoje + amanhã agrupados por dia ("QUI, 11 DE JUNHO"). Card: escudo (crest da API) + nome PT + dois inputs numéricos (0–20) + horário local do usuário. Save automático com debounce 400ms → flash "cravado ✓" dourado. Banner persistente no topo se houver jogo de hoje sem palpite: "⚠️ VOCÊ AINDA NÃO PALPITOU {N} JOGOS DE HOJE — botão [copiar cobrança p/ WhatsApp]" (gera texto pronto de zoeira).
- **Fase de grupos**: acordeão por grupo (A–L), todos os 72 jogos palpitáveis desde já.
- **Mata-mata**: agrupado por fase (16-avos → final). Times "A definir" (placeholder da API) mostram card desabilitado "aguardando classificados 🤐". Aviso fixo: "vale o resultado dos 90 minutos".
- **Bônus**: cards iguais à referência. Campeão/ataque/defesa = select com as 48 seleções (derivar dos matches, nomes PT, ordenado alfabético). Artilheiro = input texto com datalist de craques. Neymar = dois botões SIM/NÃO. Brasil = select de fases. Aviso de trava: "🔒 travam no apito de México x África do Sul. Depois não tem choro." Após lock: somente leitura com o palpite exibido.
- **Estados de jogo no card**: agendado = inputs; IN_PLAY/PAUSED = inputs travados + placar parcial + chip provisório pulsando: "se acabar assim: **+3** 🔥" / "+1" / "0 😬"; FINISHED = placar final + chip de pontos (verde +3 com micro-confete dourado na primeira renderização, amarelo +1, cinza "0 — doeu"); POSTPONED = "adiado 🤷".

### 2. Todos os palpites
Seletor de dia (chips de datas com jogos). Para cada jogo do dia: **antes do kickoff** = "🙈 palpites na surdina até a bola rolar" (mostra só quem já palpitou, sem o placar); **depois** = revelação: barra de distribuição (Casa X% · Empate X% · Fora X%, estilo da referência), média de gols, e tabela participante → palpite → pontos (provisório se ao vivo). Quem não palpitou: "— vacilou".

### 3. Tracker da Copa
Grupos A–L em grid (tabela: pos, escudo, time, P, pts, SG, GP/GC) via `/standings`; chaveamento do mata-mata por fase com placares; artilharia top-15 via `/scorers`. Rodapé: "última sincronização há X min".

### 4. Classificação
Ranking completo: posição (1º com coroa 👑, último com 🥬), caricatura grande, nome, pts, exatos, mini-sparkline opcional de pontos por dia (se barato). Linha do próprio usuário destacada em dourado.

### 5. Admin (#admin — não aparece na nav)
Tela com input de PIN (guardar em sessionStorage). Ações via POST `/.netlify/functions/admin` (body `{pin, action, ...}`): **Sincronizar agora** (action `sync`; usado tb como seed inicial dos 104 jogos); **Corrigir placar** (select de jogo → inputs → `setScore`; lista jogos com 🔒 manualLock + botão `clearLock`); **Gabarito dos bônus** (form → `setBonusAnswers`); **Liberar identidade** (select slug → `releaseClaim`). Feedback de sucesso/erro em toast.

### Modal "Regras" (botão ? ao lado da Classificação)
Replica a didática da referência: 3/1/0 com os três exemplos visuais (2x1), trava no kickoff, 90 minutos no mata-mata, desempate por exatos, tabela de bônus com a escala do Brasil. Tom zueiro, conteúdo preciso.

## DESIGN SYSTEM

- **Cores** (CSS vars): fundo `#0B0A07`; painéis `#161409` com borda `#2B2614`; dourado `#E8C547` (ações, destaques, "salvo ✓"); texto `#F2EDDC`; texto secundário `#8A8268`; verde acerto `#3DBE6C`; vermelho erro/ao vivo `#E0483E`; faixa tricolor fina no topo do app: vermelho/verde/azul (Canadá·México·EUA), como na referência.
- **Tipografia** (Google Fonts): display `Big Shoulders Display` 700/900 (títulos, placar, countdown, números do ranking — cara de placar de estádio); corpo `Archivo` 400/600. NUNCA Inter/Roboto/system.
- **Motion**: countdown com flip sutil nos segundos; "cravado ✓" com fade+slide; chip provisório ao vivo com pulse; confete dourado (CSS/JS leve, sem lib) só no +3; entrada da página com stagger leve. Nada de animação gratuita em lista longa (performance mobile).
- **Copy zueira** (camada de texto, layout permanece sóbrio): botão salvar = "cravar"; vazios = "ninguém teve coragem ainda"; countdown = "...PRO VEXAME COMEÇAR"; ranking último = 🥬. Manter respeito: zoeira entre amigos, nunca conteúdo ofensivo.
- **Avatares**: `assets/avatars/{slug}.png`, render circular com borda dourada no top-3 do ranking; `onerror` → fallback círculo com inicial do nome.

## DETALHES QUE NÃO PODEM FALTAR (edge cases)

1. **Nomes PT**: mapa `TEAM_PT` (inglês→português) cobrindo as 48 seleções + fallback para o nome da API. Ex.: "South Africa"→"África do Sul", "Germany"→"Alemanha", "United States"→"Estados Unidos".
2. **Fuso**: `utcDate` é UTC; exibir SEMPRE no fuso local do navegador (`toLocaleString('pt-BR')`). Agrupamento por dia usa a data local.
3. **Sem seed ainda** (`/matches` vazio): tela amigável "O admin ainda não convocou os jogos — segura aí" (e instrução no admin para rodar sync).
4. **Input de palpite**: aceitar só inteiros 0–20; vazio = sem palpite (não gravar par incompleto — só salvar quando os dois lados forem válidos); `inputmode="numeric"` p/ teclado mobile.
5. **Escrita negada** (lock venceu entre abrir e salvar): capturar erro de permission e mostrar toast "⏱️ tarde demais, a bola já rolou" + reverter UI.
6. **Offline/erro de rede**: toast discreto "sem conexão — seus palpites NÃO foram salvos".
7. **Listeners**: `on('value')` em /matches, /claims, /participants, /palpites, /bonus, /bonusAnswers, /standings, /scorers, /meta — re-render incremental por seção (não rebuild total da página a cada tick).
8. **Performance**: 104 jogos × 15 pessoas; computar pontuação com memoização simples por (uid, matchId, status/score).
9. **Anti-cola honesto**: a UI esconde palpites pré-lock, mas a leitura do banco é pública (limitação aceita para grupo de amigos; comentário no código).
10. **Jogo adiado/cancelado**: não pontua, não conta como pendente no banner de cobrança.
11. **Acessibilidade básica**: contraste AA no dourado sobre fundo, foco visível nos inputs, áreas de toque ≥44px.
12. **PWA leve**: manifest inline + meta theme-color pra "instalar na tela inicial" sem service worker (sem cache complexo agora).

## CRITÉRIOS DE ACEITE (testar antes de entregar)

- [ ] Claim de identidade funciona em dois navegadores diferentes sem conflito; terceiro navegador vê os dois claimados.
- [ ] Palpite salva, persiste após reload, e NÃO salva em jogo com `kickoffMs` no passado (regra nega).
- [ ] Pontuação: simular resultado via admin `setScore` e conferir +3/+1/0 e desempate por exatos no ranking.
- [ ] Bônus trava após `lockBonusAt` (simular alterando meta no console do Firebase).
- [ ] Admin: PIN errado nega; sync manual popula 104 jogos; corrigir placar cria manualLock.
- [ ] Mobile 380px: tudo utilizável com uma mão, inputs numéricos confortáveis.
- [ ] Lighthouse performance ≥ 85 mobile.

## FLUXO DE TRABALHO SUGERIDO

1. Ler este arquivo inteiro + os 5 arquivos prontos.
2. Construir `index.html` por blocos: config → CSS → shell/HTML → identidade → palpites → pontuação → demais telas → admin → polish.
3. Testar local: `npx netlify-cli dev` (functions precisam das env vars num `.env` local — NUNCA commitar).
4. Rodar os critérios de aceite.
5. Deploy: push GitHub → Netlify (ver README.md).
