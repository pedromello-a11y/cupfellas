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
  usa: 'unitedstates',
  ivorycoast: 'cotedivoire', cotedivoire: 'cotedivoire',
  czechia: 'czechrepublic',
  turkiye: 'turkey',
  drcongo: 'congodr', democraticrepublicofthecongo: 'congodr',
  uae: 'unitedarabemirates',
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

exports.handler = async () => {
  const env = process.env;
  if (!env.LIVESCORE_API_KEY || !env.LIVESCORE_API_SECRET) {
    return ok({ skipped: 'sem credenciais live-score-api' });
  }

  try {
    const [matches, locks] = await Promise.all([
      fbFetch(env, 'matches.json'),
      fbFetch(env, 'manualLocks.json'),
    ]);
    if (!matches) return ok({ skipped: 'sem matches' });

    // Dentro da janela do jogo, live-score-api manda mais que o status do
    // football-data.org (que no free tier às vezes marca FINISHED cedo demais).
    const now = Date.now();
    const candidates = Object.values(matches).filter((m) => {
      if (!m || (locks && locks[m.id])) return false;
      return m.kickoffMs <= now && now <= m.kickoffMs + WINDOW_MS;
    });
    if (!candidates.length) return ok({ skipped: 'nenhum jogo na janela ao vivo' });

    const url = `${LS_API}?key=${env.LIVESCORE_API_KEY}&secret=${env.LIVESCORE_API_SECRET}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`live-score-api: ${res.status}`);
    const json = await res.json();
    const live = (json && json.data && json.data.match) || [];

    let updated = 0;
    for (const m of candidates) {
      const home = canon(m.home && m.home.name);
      const away = canon(m.away && m.away.name);
      const found = live.find((lm) => {
        const lh = canon(lm.home_name);
        const la = canon(lm.away_name);
        return (lh === home && la === away) || (lh === away && la === home);
      });
      if (!found) continue;

      const newStatus = statusFromLive(found.status);
      if (!newStatus) continue;

      const scoreStr = newStatus === 'FINISHED' ? (found.ft_score || found.score) : found.score;
      const score = parseScore(scoreStr);

      const patch = {};
      if (newStatus !== m.status) patch.status = newStatus;
      if (score && (score.home !== (m.score && m.score.home) || score.away !== (m.score && m.score.away))) {
        patch.score = score;
        patch.winner90 = winner90(score.home, score.away);
      }
      if (!Object.keys(patch).length) continue;

      await fbFetch(env, `matches/${m.id}.json`, { method: 'PATCH', body: JSON.stringify(patch) });
      updated++;
    }

    return ok({ checked: candidates.length, updated });
  } catch (e) {
    console.error('live-sync falhou', e);
    return { statusCode: 500, body: JSON.stringify({ error: e.message }) };
  }
};

function ok(data) {
  return { statusCode: 200, body: JSON.stringify(data) };
}
