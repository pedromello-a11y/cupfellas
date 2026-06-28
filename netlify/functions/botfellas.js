// WorldFellas — CPUzão: palpita sozinho com base nas odds (livescore-api.com)
//
// Fonte de odds = MESMA API do live-sync (LIVESCORE_API_KEY + LIVESCORE_API_SECRET).
//   • Jogos futuros  → /fixtures/matches.json?date=YYYY-MM-DD  (traz odds pré-jogo)
//   • Jogos passados → /scores/history.json?from=&to=          (traz odds.pre + placar)
// Odds vêm no formato { "1": casa, "X": empate, "2": fora } (decimal).
// Com a odd, o CPUzão CRAVA um placar (favorito) e a gente guarda a odd em /odds/{id}
// pra desenhar a barra de favoritismo no front.
//
// Modos (POST { pin, mode?, daysAhead? }):
//   "eve"      (padrão) → só o dia seguinte (1 call). Bom pro cron rodar à noite.
//   "today"    → só hoje (1 call).
//   "window"   → próximos `daysAhead` dias (1 call/dia).
//   "backfill" → jogos já rolados desde o início da Copa que ainda não têm odds/palpite.

const BOT_UID  = 'cpuzao-2026';
const BOT_SLUG = 'cpuzao';
const BOT_NAME = 'CPUzão';

const CUP_START         = '2026-06-11'; // 1º jogo (México x África do Sul)
const WC_COMPETITION_ID = 362;          // FIFA World Cup na livescore-api
const LS_BASE           = 'https://livescore-api.com/api-client';
const MAX_API_CALLS     = 250;          // plano STARTER = 14500 req/dia, folga enorme
const MAX_PAGES         = 12;           // páginas por consulta paginada

async function fbFetch(env, path, options = {}) {
  const db  = env.FIREBASE_DB_URL.replace(/\/$/, '');
  const sep = path.includes('?') ? '&' : '?';
  const url = `${db}/${path}${sep}auth=${env.FIREBASE_DB_SECRET}`;
  const res = await fetch(url, options);
  if (!res.ok) throw new Error(`Firebase ${path}: ${res.status}`);
  return res.json();
}

function lsUrl(env, endpoint, params = {}) {
  const qs = new URLSearchParams({
    key: env.LIVESCORE_API_KEY,
    secret: env.LIVESCORE_API_SECRET,
    ...params,
  });
  return `${LS_BASE}/${endpoint}?${qs}`;
}
async function lsGet(env, endpoint, params, stats) {
  if (stats) stats.apiCalls++;
  const res = await fetch(lsUrl(env, endpoint, params));
  const json = await res.json().catch(() => ({}));
  if (!json || json.success === false)
    throw new Error(`LiveScore ${endpoint}: ${json && json.error ? json.error : res.status}`);
  return json;
}

function norm(name) {
  return String(name || '')
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]/g, '');
}
// apelidos onde football-data.org (nosso /matches) diverge da livescore-api
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
const pairKey = (a, b) => [canon(a), canon(b)].sort().join('|');
const isKO = (m) => !!(m && m.stage && m.stage !== 'GROUP_STAGE');

// odds no formato { "1": casa, "X": empate, "2": fora } → { home, draw, away }
function extractOdds(obj) {
  const o = obj && obj.odds ? (obj.odds.pre || obj.odds) : null;
  if (!o) return null;
  const home = parseFloat(o['1']);
  const draw = parseFloat(o['X'] != null ? o['X'] : o['x']);
  const away = parseFloat(o['2']);
  if (!home || !draw || !away || isNaN(home) || isNaN(draw) || isNaN(away)) return null;
  return { home, draw, away };
}

// odd → placar cravado pelo favorito
function oddsToScore(homeOdd, drawOdd, awayOdd) {
  if (!homeOdd || !drawOdd || !awayOdd || isNaN(homeOdd)) return { h: 1, a: 1 };
  const min = Math.min(homeOdd, drawOdd, awayOdd);
  if (min === drawOdd) return { h: 1, a: 1 };
  if (min === homeOdd) return homeOdd < 1.6 ? { h: 2, a: 0 } : { h: 2, a: 1 };
  return awayOdd < 1.6 ? { h: 0, a: 2 } : { h: 1, a: 2 };
}

const utcDate = (ms) => new Date(ms).toISOString().slice(0, 10);
function addDays(date, n) {
  const d = new Date(date + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
const isWC = (x) => /world cup/i.test((x.competition && x.competition.name) || x.competition_name || '');

// acumula entradas {home_name, away_name, odds} num mapa pairKey → entrada
function indexLs(list, lsByPair) {
  for (const x of list) {
    if (!isWC(x)) continue;
    const odds = extractOdds(x);
    if (!odds) continue;
    lsByPair[pairKey(x.home_name, x.away_name)] = { lh: x.home_name, la: x.away_name, odds };
  }
}

// fixtures de um dia (paginado) → indexa no mapa
async function collectFixtures(env, date, lsByPair, stats) {
  let page = 1;
  while (page <= MAX_PAGES && stats.apiCalls < MAX_API_CALLS) {
    const j = await lsGet(env, 'fixtures/matches.json',
      { date, competition_id: String(WC_COMPETITION_ID), page: String(page) }, stats);
    const fx = (j.data && j.data.fixtures) || [];
    indexLs(fx, lsByPair);
    if (fx.length < 30 || !(j.data && j.data.next_page)) break;
    page++;
  }
}

// histórico de um intervalo (paginado) → indexa no mapa
async function collectHistory(env, from, to, lsByPair, stats) {
  let page = 1;
  while (page <= MAX_PAGES && stats.apiCalls < MAX_API_CALLS) {
    const j = await lsGet(env, 'scores/history.json',
      { from, to, competition_id: String(WC_COMPETITION_ID), page: String(page) }, stats);
    const ms = (j.data && j.data.match) || [];
    indexLs(ms, lsByPair);
    if (ms.length < 30 || !(j.data && j.data.next_page)) break;
    page++;
  }
}

exports.handler = async (event) => {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  };
  const env = process.env;
  // Invocação agendada (cron do netlify.toml) não traz httpMethod/PIN → roda no modo "eve".
  const scheduled = !event || !event.httpMethod;

  let body = { mode: 'eve' };
  if (!scheduled) {
    if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: cors, body: '' };
    if (event.httpMethod !== 'POST')   return { statusCode: 405, headers: cors, body: 'POST only' };
    try { body = JSON.parse(event.body || '{}'); }
    catch { return { statusCode: 400, headers: cors, body: JSON.stringify({ error: 'JSON inválido' }) }; }
    if (!env.ADMIN_PIN || body.pin !== env.ADMIN_PIN)
      return { statusCode: 401, headers: cors, body: JSON.stringify({ error: 'PIN errado, robozinho.' }) };
  }
  if (!env.LIVESCORE_API_KEY || !env.LIVESCORE_API_SECRET)
    return { statusCode: 500, headers: cors, body: JSON.stringify({ error: 'LIVESCORE_API_KEY/SECRET não configuradas no Netlify.' }) };

  try {
    // 1. Garante o participante bot (idempotente)
    await fbFetch(env, `claims/${BOT_SLUG}.json`, { method: 'PUT', body: JSON.stringify({ uid: BOT_UID }) });
    await fbFetch(env, `participants/${BOT_UID}.json`, { method: 'PUT', body: JSON.stringify({ slug: BOT_SLUG, name: BOT_NAME }) });

    // 2. Jogos do RTDB
    const matches = (await fbFetch(env, 'matches.json')) || {};
    const now   = Date.now();
    const today = utcDate(now);

    const mode = ['today', 'window', 'backfill'].includes(body.mode) ? body.mode : 'eve';

    // 3. Datas-alvo
    let targetDates;
    if (mode === 'eve')        targetDates = [addDays(today, 1)];
    else if (mode === 'today') targetDates = [today];
    else if (mode === 'window') {
      const days = Math.min(Math.max(parseInt(body.daysAhead) || 7, 1), 45);
      targetDates = Array.from({ length: days }, (_, i) => addDays(today, i + 1));
    } else { // backfill
      targetDates = [];
      for (let d = CUP_START; d <= today; d = addDays(d, 1)) targetDates.push(d);
    }

    // backfill: pula quem já tem palpite E odds
    const existingPalpites = mode === 'backfill' ? ((await fbFetch(env, `palpites/${BOT_UID}.json`)) || {}) : {};
    const existingOdds     = mode === 'backfill' ? ((await fbFetch(env, `odds.json`)) || {}) : {};

    // 4. Jogos que precisam de palpite/odds, agrupados por dia
    const needed = [];
    for (const m of Object.values(matches)) {
      if (!m.home?.name || !m.away?.name) continue;
      if (m.status === 'POSTPONED' || m.status === 'CANCELLED') continue;
      if (mode === 'backfill') {
        if (m.kickoffMs > now) continue;
        if (existingPalpites[m.id] && existingOdds[m.id]) continue;
      } else {
        if (m.kickoffMs <= now) continue; // só futuros
      }
      if (targetDates.includes(utcDate(m.kickoffMs))) needed.push(m);
    }

    if (!needed.length) {
      const msg = mode === 'eve'    ? `Nenhum jogo amanhã (${targetDates[0]}).`
        : mode === 'today'  ? `Nenhum jogo futuro hoje (${today}).`
        : mode === 'window' ? `Nenhum jogo nos próximos ${body.daysAhead || 7} dias.`
        : `Nada pra backfill — todo jogo já rolado já tem odds/palpite do ${BOT_NAME}.`;
      return { statusCode: 200, headers: cors, body: JSON.stringify({ ok: true, mode, placed: 0, msg }) };
    }

    // 5. Busca odds na LiveScore (fixtures p/ futuro, history p/ passado)
    const stats = { placed: 0, withOdds: 0, noOdds: 0, apiCalls: 0, errors: [] };
    const lsByPair = {};
    try {
      if (mode === 'backfill') {
        await collectHistory(env, CUP_START, today, lsByPair, stats);
      } else {
        for (const date of targetDates) {
          if (stats.apiCalls >= MAX_API_CALLS) { stats.errors.push(`teto de ${MAX_API_CALLS} calls — parei em ${date}`); break; }
          await collectFixtures(env, date, lsByPair, stats);
        }
      }
    } catch (e) {
      // erro de quota/acesso: aborta com mensagem clara (já pode ter indexado parte)
      stats.errors.push(e.message);
    }

    // Se a API falhou e não trouxe NADA, não grava 1×1 em tudo — aborta avisando.
    if (!Object.keys(lsByPair).length && stats.errors.length)
      return { statusCode: 502, headers: cors, body: JSON.stringify({
        error: 'LiveScore não respondeu (quota/acesso). Nada gravado.', detail: stats.errors }) };

    // 6. Resolve cada jogo: orienta as odds e crava o placar
    const palpites = {}, oddsOut = {};
    for (const m of needed) {
      const entry = lsByPair[pairKey(m.home.name, m.away.name)];
      if (!entry) { // sem odds: empate conservador, sem barra de favoritismo
        palpites[m.id] = { h: 1, a: 1, ts: now, bot: true, confirmed: true };
        stats.noOdds++; stats.placed++;
        continue;
      }
      // orienta as odds pra casa/fora do NOSSO jogo
      const sameOrientation = canon(m.home.name) === canon(entry.lh);
      const od = sameOrientation
        ? entry.odds
        : { home: entry.odds.away, draw: entry.odds.draw, away: entry.odds.home };
      const sc = oddsToScore(od.home, od.draw, od.away);
      palpites[m.id] = { ...sc, ts: now, bot: true, confirmed: true };
      // Mata-mata: em caso de empate nos 90, o CPUzão manda o FAVORITO (menor odd casa/fora)
      // pra próxima fase. Em placar decidido o avanço já é implícito, mas grava igual p/ consistência.
      if (isKO(m)) palpites[m.id].adv = od.home <= od.away ? 'HOME' : 'AWAY';
      oddsOut[m.id]  = { home: od.home, draw: od.draw, away: od.away, fetchedAt: now };
      stats.withOdds++; stats.placed++;
    }

    // 7. Grava palpites e odds (PATCH preserva o que já existe)
    if (Object.keys(palpites).length)
      await fbFetch(env, `palpites/${BOT_UID}.json`, { method: 'PATCH', body: JSON.stringify(palpites) });
    if (Object.keys(oddsOut).length)
      await fbFetch(env, `odds.json`, { method: 'PATCH', body: JSON.stringify(oddsOut) });

    return { statusCode: 200, headers: cors, body: JSON.stringify({ ok: true, mode, ...stats }) };
  } catch (e) {
    return { statusCode: 500, headers: cors, body: JSON.stringify({ error: e.message }) };
  }
};
