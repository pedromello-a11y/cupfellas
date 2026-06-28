// WorldFellas — núcleo de sincronização football-data.org -> Firebase RTDB
// Usado pela função agendada (sync.js) e pelo gatilho manual (admin.js)

const API = 'https://api.football-data.org/v4/competitions/WC';

function winner90(h, a) {
  if (h == null || a == null) return null;
  if (h > a) return 'HOME';
  if (a > h) return 'AWAY';
  return 'DRAW';
}

async function fbFetch(env, path, options = {}) {
  const db = env.FIREBASE_DB_URL.replace(/\/$/, '');
  const sep = path.includes('?') ? '&' : '?';
  const url = `${db}/${path}${sep}auth=${env.FIREBASE_DB_SECRET}`;
  const res = await fetch(url, options);
  if (!res.ok) throw new Error(`Firebase ${path}: ${res.status}`);
  return res.json();
}

async function apiFetch(env, path) {
  const res = await fetch(`${API}${path}`, {
    headers: { 'X-Auth-Token': env.FOOTBALL_DATA_TOKEN },
  });
  // Respeita o ratelimiter (pedido do Daniel ;-)
  const remaining = res.headers.get('X-Requests-Available-Minute');
  if (remaining !== null && Number(remaining) <= 1) {
    await new Promise((r) => setTimeout(r, 61000));
  }
  if (!res.ok) throw new Error(`football-data ${path}: ${res.status}`);
  return res.json();
}

async function runSync(env) {
  const out = { matches: 0, standings: false, scorers: false, errors: [] };

  // 1) Jogos (também serve de seed inicial dos 104 jogos)
  const mJson = await apiFetch(env, '/matches');
  const locks = (await fbFetch(env, 'manualLocks.json')) || {};
  const matches = {};
  let firstKickoff = Infinity;

  for (const m of mJson.matches || []) {
    const id = String(m.id);
    const kickoffMs = Date.parse(m.utcDate);
    if (kickoffMs < firstKickoff) firstKickoff = kickoffMs;
    if (locks[id]) continue; // placar travado manualmente pelo admin

    // Mata-mata vale o resultado dos 90 minutos
    const s = m.score || {};
    const score90 =
      s.duration && s.duration !== 'REGULAR' && s.regularTime
        ? s.regularTime
        : s.fullTime || { home: null, away: null };

    // Quem AVANÇOU no mata-mata: vencedor GERAL (inclui prorrogação/pênaltis) via score.winner.
    // Só importa quando empatou em 90 → o cliente dá +1 de "quem passa de fase". Em grupo fica null.
    const isKO = m.stage && m.stage !== 'GROUP_STAGE';
    const advancer = isKO
      ? (s.winner === 'HOME_TEAM' ? 'HOME' : s.winner === 'AWAY_TEAM' ? 'AWAY' : null)
      : null;

    matches[id] = {
      id,
      stage: m.stage || null,
      group: m.group || null,
      matchday: m.matchday || null,
      utcDate: m.utcDate,
      kickoffMs,
      status: m.status,
      home: m.homeTeam
        ? { name: m.homeTeam.name || 'A definir', tla: m.homeTeam.tla || '', crest: m.homeTeam.crest || '' }
        : { name: 'A definir', tla: '', crest: '' },
      away: m.awayTeam
        ? { name: m.awayTeam.name || 'A definir', tla: m.awayTeam.tla || '', crest: m.awayTeam.crest || '' }
        : { name: 'A definir', tla: '', crest: '' },
      score: { home: score90.home ?? null, away: score90.away ?? null },
      winner90: winner90(score90.home, score90.away),
      advancer,
      venue: m.venue || null,
    };
  }

  await fbFetch(env, 'matches.json', { method: 'PATCH', body: JSON.stringify(matches) });
  out.matches = Object.keys(matches).length;

  // BUG FIX (jun/2026): só DEFINE lockBonusAt no seed inicial (quando ainda não existe).
  // Antes era reescrito p/ firstKickoff a cada sync, o que sobrescrevia o valor ajustado
  // no admin (setLockBonusAt) e re-travava os bônus depois que o 1º jogo já passou.
  const meta = { lastSync: Date.now() };
  const curMeta = (await fbFetch(env, 'meta.json')) || {};
  if (curMeta.lockBonusAt == null && isFinite(firstKickoff)) meta.lockBonusAt = firstKickoff;
  await fbFetch(env, 'meta.json', { method: 'PATCH', body: JSON.stringify(meta) });

  // 2) Classificação dos grupos (tracker)
  try {
    const sJson = await apiFetch(env, '/standings');
    const standings = (sJson.standings || [])
      .filter((g) => g.type === 'TOTAL')
      .map((g) => ({
        group: g.group || '',
        table: (g.table || []).map((r) => ({
          pos: r.position,
          name: r.team?.name || '',
          crest: r.team?.crest || '',
          p: r.playedGames,
          pts: r.points,
          gf: r.goalsFor,
          ga: r.goalsAgainst,
          gd: r.goalDifference,
        })),
      }));
    await fbFetch(env, 'standings.json', { method: 'PUT', body: JSON.stringify(standings) });
    out.standings = true;
  } catch (e) {
    out.errors.push('standings: ' + e.message);
  }

  // 3) Artilharia (tracker)
  try {
    const scJson = await apiFetch(env, '/scorers?limit=15');
    const scorers = (scJson.scorers || []).map((s) => ({
      name: s.player?.name || '',
      team: s.team?.name || '',
      crest: s.team?.crest || '',
      goals: s.goals || 0,
    }));
    await fbFetch(env, 'scorers.json', { method: 'PUT', body: JSON.stringify(scorers) });
    out.scorers = true;
  } catch (e) {
    out.errors.push('scorers: ' + e.message);
  }

  return out;
}

module.exports = { runSync, fbFetch };
