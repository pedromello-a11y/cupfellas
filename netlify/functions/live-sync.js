// WorldFellas — placar ao vivo via live-score-api.com
// Roda a cada 1 min (ver netlify.toml). NÃO substitui o sync.js (football-data.org,
// a cada 15 min) — só atualiza status/placar em tempo real pra UI mostrar
// "ao vivo" e quem tá ganhando ponto. O sync de 15 min confirma o resultado oficial.
const { fbFetch } = require('./sync-core');

const LS_API = 'https://livescore-api.com/api-client/scores/live.json';
const WINDOW_MS = 4 * 60 * 60 * 1000; // jogo + prorrogação + pênaltis

// Normaliza nomes pra comparar football-data.org x live-score-api.
function norm(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]/g, '');
}

// Apelidos onde os dois provedores divergem. Se um jogo ao vivo não bater
// com o nosso /matches, adicionar aqui o par normalizado.
const ALIASES = {
  korearepublic: 'korea', southkorea: 'korea',
  iriran: 'iran',
  usa: 'unitedstates', unitedstatesofamerica: 'unitedstates',
  ivorycoast: 'cotedivoire', cotedivoire: 'cotedivoire',
  czechia: 'czechrepublic',
  turkiye: 'turkey',
  drcongo: 'congodr', democraticrepublicofthecongo: 'congodr',
  uae: 'unitedarabemirates',
  bosniaandherzegovina: 'bosniaherzegovina',
  capeverdeislands: 'capeverde',
  republicofireland: 'ireland',
  dprkorea: 'northkorea',
  northmacedonia: 'macedonia',
  chinesetaipei: 'taiwan',
};
const canon = (s) => { const n = norm(s); return ALIASES[n] || n; };

function statusFromLive(status) {
  const s = (status || '').toUpperCase();
  if (s.includes('HALF TIME')) return 'PAUSED';
  if (s.includes('FINISHED')) return 'FINISHED';
  if (s.includes('IN PLAY') || s.includes('ADDED TIME')) return 'IN_PLAY';
  return null; // NOT STARTED, INSUFFICIENT DATA etc. -> não mexe
}

function parseScore(str) {
  const m = String(str || '').match(/^(\d+)\s*-\s*(\d+)$/);
  if (!m) return null;
  return { home: Number(m[1]), away: Number(m[2]) };
}

function winner90(h, a) {
  if (h == null || a == null) return null;
  if (h > a) return 'HOME';
  if (a > h) return 'AWAY';
  return 'DRAW';
}

// Mata-mata: quem AVANÇOU, lido do 1X2 da live-score-api (mesma info que o sync de 15min pega
// do football-data via score.winner, mas aqui chega em ~1min). outcomes = { full_time, extra_time,
// penalty_shootout } com "1"=casa, "2"=fora, "X"=empate. O vencedor geral é o desfecho mais
// DECISIVO disponível: pênaltis > prorrogação > 90min. Em fase de grupos não se aplica.
function isKO(m) { return !!(m && m.stage && m.stage !== 'GROUP_STAGE'); }
function advancerFromOutcomes(o) {
  if (!o) return null;
  const code = o.penalty_shootout || o.extra_time || o.full_time;
  return code === '1' ? 'HOME' : code === '2' ? 'AWAY' : null;
}

// ──────── Feed de atividade (/activity) — Fase 2 do rail ────────
// A live-sync já detecta cada transição (status/placar) tick a tick e grava em /matches;
// aqui essas mesmas transições viram eventos no MESMO /activity que o cliente escuta.
// Os nomes PT e a copy ficam no cliente (ptName); o servidor manda só o essencial
// (mid + placar) + um `text` de reserva em tla, caso o match não esteja carregado.
function hasScore(s) { return s && Number.isFinite(s.home) && Number.isFinite(s.away); }
function goalsSum(s) { return hasScore(s) ? s.home + s.away : 0; }
function tlaOf(t) { return (String((t && t.tla) || '').toUpperCase()) || (t && t.name) || '?'; }

function gameEv(t, m, score) {
  const ev = { t, ts: Date.now(), uid: 'system', name: 'BOLÃO', mid: String(m.id) };
  if (t === 'matchstart' || !hasScore(score)) {
    ev.text = tlaOf(m.home) + ' × ' + tlaOf(m.away);
  } else {
    ev.score = { home: score.home, away: score.away };
    ev.text = tlaOf(m.home) + ' ' + score.home + '×' + score.away + ' ' + tlaOf(m.away);
  }
  // Chave DETERMINÍSTICA p/ idempotência: o mesmo gol/início/fim nunca vira duas linhas
  // no feed, mesmo que a transição seja redetectada (Netlify entrega o cron at-least-once;
  // a live-score-api às vezes "pisca" um placar menor e volta). Gol é identificado pelo
  // placar ACUMULADO (mid+h+a): re-chegar em 1×2 reescreve o mesmo nó em vez de duplicar.
  if (t === 'goal' && hasScore(score)) ev._key = 'g_' + m.id + '_' + score.home + '_' + score.away;
  else if (t === 'matchstart') ev._key = 's_' + m.id;
  else if (t === 'matchend') ev._key = 'e_' + m.id;
  return ev;
}

// Grava o evento no /activity. Com `_key` -> PUT determinístico (idempotente); sem chave
// -> POST gera push id, igual ao logActivity do cliente.
// Best-effort: erro ao gravar o feed NUNCA derruba a sincronização do placar.
async function logGameEvent(env, ev) {
  const key = ev._key; if (key) delete ev._key;
  try {
    if (key) await fbFetch(env, `activity/${key}.json`, { method: 'PUT', body: JSON.stringify(ev) });
    else await fbFetch(env, 'activity.json', { method: 'POST', body: JSON.stringify(ev) });
    return 1;
  } catch (e) {
    console.error('feed event falhou', ev.t, ev.mid, e.message);
    return 0;
  }
}

// CRAVADA — no apito, descobre quem cravou o placar exato e emite um evento por cravador
// no MESMO /activity. Escala por raridade: solo+improvável = lendária · solo = ousada · vários = cravada.
// Best-effort: se faltar palpites/participantes, não emite (e nunca derruba a sincronização).
async function emitCravadas(env, m, score, palpites, participants) {
  if (!hasScore(score) || !palpites || !participants) return 0;
  const exatos = [];
  for (const uid in participants) {
    const pal = palpites[uid] && palpites[uid][m.id];
    if (!pal || pal.h == null || pal.a == null) continue;
    if (pal.h === score.home && pal.a === score.away) exatos.push(uid);
  }
  if (!exatos.length) return 0;
  const solo = exatos.length === 1;
  const improv = (score.home + score.away) >= 5 || Math.abs(score.home - score.away) >= 3;
  const tier = (solo && improv) ? 'lend' : solo ? 'ous' : 'crav';
  let n = 0;
  for (const uid of exatos) {
    const p = participants[uid] || {};
    n += await logGameEvent(env, {
      t: 'cravada', ts: Date.now(), uid, name: p.name || 'alguém', slug: p.slug || '',
      mid: String(m.id), score: { home: score.home, away: score.away }, solo, tier,
      text: (p.name || 'alguém') + ' cravou ' + score.home + '×' + score.away,
      _key: 'c_' + m.id + '_' + uid, // 1 cravada por jogo/pessoa, idempotente
    });
  }
  return n;
}

// Poda eventos com mais de 48h. orderBy/endAt usa o índice "ts" (database.rules.json);
// com o secret o índice nem é exigido. Apaga em lote com um único PATCH de nulls.
async function pruneActivity(env) {
  const cutoff = Date.now() - 48 * 60 * 60 * 1000;
  const old = await fbFetch(env, `activity.json?orderBy=%22ts%22&endAt=${cutoff}`);
  if (!old) return 0;
  const keys = Object.keys(old);
  if (!keys.length) return 0;
  const updates = {};
  for (const k of keys) updates[k] = null;
  await fbFetch(env, 'activity.json', { method: 'PATCH', body: JSON.stringify(updates) });
  return keys.length;
}

exports.handler = async () => {
  const env = process.env;

  // Poda do feed roda SEMPRE — independe da live-score-api e dos jogos do dia.
  // Fica aqui em cima porque o caminho "nenhum jogo ao vivo" retorna cedo logo abaixo.
  const pruned = await pruneActivity(env).catch((e) => { console.error('prune feed', e.message); return 0; });

  if (!env.LIVESCORE_API_KEY || !env.LIVESCORE_API_SECRET) {
    return ok({ pruned, skipped: 'sem credenciais live-score-api' });
  }

  try {
    const [matches, locks, palpites, participants] = await Promise.all([
      fbFetch(env, 'matches.json'),
      fbFetch(env, 'manualLocks.json'),
      fbFetch(env, 'palpites.json').catch(() => null),
      fbFetch(env, 'participants.json').catch(() => null),
    ]);
    if (!matches) return ok({ pruned, skipped: 'sem matches' });

    // Dentro da janela do jogo, live-score-api manda mais que o status do
    // football-data.org (que no free tier às vezes marca FINISHED cedo demais).
    const now = Date.now();
    const candidates = Object.values(matches).filter((m) => {
      if (!m || (locks && locks[m.id])) return false;
      return m.kickoffMs <= now && now <= m.kickoffMs + WINDOW_MS;
    });
    if (!candidates.length) return ok({ pruned, skipped: 'nenhum jogo na janela ao vivo' });

    const url = `${LS_API}?key=${env.LIVESCORE_API_KEY}&secret=${env.LIVESCORE_API_SECRET}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`live-score-api: ${res.status}`);
    const json = await res.json();
    const live = (json && json.data && json.data.match) || [];

    let updated = 0;
    let events = 0;
    for (const m of candidates) {
      const home = canon(m.home && m.home.name);
      const away = canon(m.away && m.away.name);
      const found = live.find((lm) => {
        const lh = canon(lm.home_name);
        const la = canon(lm.away_name);
        return (lh === home && la === away) || (lh === away && la === home);
      });

      if (!found) {
        // Sumiu do feed ao vivo. Se aqui ainda consta rolando E já passou tempo de sobra pro
        // jogo ter acabado, finaliza com o último placar conhecido. Sem isto o jogo fica preso
        // "AO VIVO" pra sempre quando o sync de 15min (football-data.org) atrasa ou falha — foi
        // o que aconteceu com Costa do Marfim x Equador (mostrado ao vivo depois de acabar).
        if ((m.status === 'IN_PLAY' || m.status === 'PAUSED') && now > m.kickoffMs + 150 * 60 * 1000) {
          await fbFetch(env, `matches/${m.id}.json`, { method: 'PATCH', body: JSON.stringify({ status: 'FINISHED' }) });
          updated++;
          events += await logGameEvent(env, gameEv('matchend', m, m.score));
          events += await emitCravadas(env, m, m.score, palpites, participants);
        }
        continue;
      }

      // Já encerrado aqui: não deixa o feed "ressuscitar" o jogo (anti-regressão FINISHED→IN_PLAY).
      // Exceção: mata-mata que empatou em 90 e ainda está SEM advancer — o shootout às vezes é
      // reportado um tick depois do apito. Preenche assim que a API expõe, sem esperar o sync de 15min
      // (é o que faz o +1 de "quem passa" valer quase na hora).
      if (m.status === 'FINISHED') {
        if (isKO(m) && m.winner90 === 'DRAW' && !m.advancer) {
          const adv = advancerFromOutcomes(found.outcomes);
          if (adv) {
            await fbFetch(env, `matches/${m.id}.json`, { method: 'PATCH', body: JSON.stringify({ advancer: adv }) });
            updated++;
          }
        }
        continue;
      }

      let newStatus = statusFromLive(found.status);
      if (!newStatus) continue;

      const scoreStr = newStatus === 'FINISHED' ? (found.ft_score || found.score) : found.score;
      let score = parseScore(scoreStr);

      // MATA-MATA NÃO TERMINA EMPATADO — bug real visto 01/07 (Bélgica x Senegal, LAST_32): a
      // live-score-api marcou "FINISHED" com 2×2 no apito DOS 90 MINUTOS (fim da etapa normal,
      // ainda ia pra prorrogação), e o código fechou o jogo cedo demais. O gol que decidiu em
      // 3×2 só chegou ~40min depois, num tick que ainda tratava o jogo como encerrado. Regra do
      // próprio mata-mata: se empatou, SEMPRE vai pra prorrogação/pênaltis — nunca acaba empatado.
      // Então "FINISHED" com placar empatado só é real quando o provider já expõe um outcome
      // decisivo (extra_time/penalty_shootout); sem isso, é só o intervalo pré-prorrogação —
      // trata como jogo ainda rolando e deixa os próximos ticks acompanharem.
      if (newStatus === 'FINISHED' && isKO(m) && score && score.home === score.away && !advancerFromOutcomes(found.outcomes)) {
        newStatus = (m.status === 'PAUSED' || m.status === 'IN_PLAY') ? m.status : 'IN_PLAY';
      }

      // ANTI-REGRESSÃO DE PLACAR NO FECHAMENTO — mesmo incidente: mesmo quando o fechamento é
      // legítimo, o `ft_score` do tick que fecha o jogo pode chegar desatualizado (voltar um
      // placar mais velho que o já gravado por um tick anterior). Sem esta trava o placar
      // REGREDIA, reabria uma "cravada" errada (pontos falsos) que o sync de 15min corrigia
      // depois — dando a impressão de "ganhei os pontos e depois perdi". Nunca deixa o total de
      // gols cair no fechamento; só corrige gol pra baixo por VAR durante o jogo (fluxo normal
      // acima, fora deste bloco).
      if (newStatus === 'FINISHED' && score && m.score && goalsSum(score) < goalsSum(m.score)) {
        score = { home: m.score.home, away: m.score.away };
      }

      const scoreChanged = score && (score.home !== (m.score && m.score.home) || score.away !== (m.score && m.score.away));
      const patch = {};
      if (newStatus !== m.status) patch.status = newStatus;
      if (scoreChanged) {
        patch.score = score;
        patch.winner90 = winner90(score.home, score.away);
      }
      // Mata-mata encerrando: grava quem avançou (pênaltis/prorrogação) já neste tick.
      if (newStatus === 'FINISHED' && isKO(m)) {
        const adv = advancerFromOutcomes(found.outcomes);
        if (adv && adv !== m.advancer) patch.advancer = adv;
      }
      if (!Object.keys(patch).length) continue;

      await fbFetch(env, `matches/${m.id}.json`, { method: 'PATCH', body: JSON.stringify(patch) });
      updated++;

      // Feed: traduz a transição em evento — DEPOIS de gravar o estado, pra não repetir
      // (o /matches já avançou; no próximo tick não sobra diff a redetectar).
      const wasLive = m.status === 'IN_PLAY' || m.status === 'PAUSED';
      if (patch.status === 'FINISHED') {
        events += await logGameEvent(env, gameEv('matchend', m, score || m.score));
        events += await emitCravadas(env, m, score || m.score, palpites, participants);
      } else {
        // kickoff: só na PRIMEIRA vez que entra em campo (PAUSED->IN_PLAY é volta do intervalo).
        if (patch.status === 'IN_PLAY' && !wasLive) {
          events += await logGameEvent(env, gameEv('matchstart', m, null));
        }
        // gol: só quando a soma de gols AUMENTA (0×0 do apito inicial não conta; correção
        // de placar pra baixo via VAR também não vira "gol").
        if (scoreChanged && goalsSum(score) > goalsSum(m.score)) {
          events += await logGameEvent(env, gameEv('goal', m, score));
        }
      }
    }

    return ok({ pruned, checked: candidates.length, updated, events });
  } catch (e) {
    console.error('live-sync falhou', e);
    return { statusCode: 500, body: JSON.stringify({ error: e.message }) };
  }
};

function ok(data) {
  return { statusCode: 200, body: JSON.stringify(data) };
}
