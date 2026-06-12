// WorldFellas — ações de admin (protegidas por PIN, server-side)
// Ações: sync | setScore | clearLock | setBonusAnswers | releaseClaim
const { runSync, fbFetch } = require('./sync-core');

exports.handler = async (event) => {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: cors, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers: cors, body: 'POST only' };

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    return { statusCode: 400, headers: cors, body: JSON.stringify({ error: 'JSON inválido' }) };
  }

  if (!process.env.ADMIN_PIN || body.pin !== process.env.ADMIN_PIN) {
    return { statusCode: 401, headers: cors, body: JSON.stringify({ error: 'PIN errado, espertinho.' }) };
  }

  const env = process.env;
  try {
    switch (body.action) {
      case 'sync': {
        const result = await runSync(env);
        return ok(cors, result);
      }

      case 'setScore': {
        // Corrige/lança placar na mão e trava contra o sync automático
        const { matchId, home, away, status } = body;
        if (!matchId) return bad(cors, 'matchId obrigatório');
        const patch = {
          score: { home: toIntOrNull(home), away: toIntOrNull(away) },
          status: status || 'FINISHED',
          winner90: w90(toIntOrNull(home), toIntOrNull(away)),
        };
        await fbFetch(env, `matches/${matchId}.json`, { method: 'PATCH', body: JSON.stringify(patch) });
        await fbFetch(env, `manualLocks/${matchId}.json`, { method: 'PUT', body: 'true' });
        return ok(cors, { matchId, ...patch });
      }

      case 'clearLock': {
        // Volta a confiar na API para esse jogo
        const { matchId } = body;
        if (!matchId) return bad(cors, 'matchId obrigatório');
        await fbFetch(env, `manualLocks/${matchId}.json`, { method: 'DELETE' });
        return ok(cors, { cleared: matchId });
      }

      case 'setBonusAnswers': {
        // answers: { campeao, artilheiros, melhorAtaque, melhorDefesa, neymar, brasilFase }
        // Campos vazios/null = ainda sem resposta (não pontua)
        await fbFetch(env, 'bonusAnswers.json', {
          method: 'PATCH',
          body: JSON.stringify(body.answers || {}),
        });
        return ok(cors, { saved: true });
      }

      case 'releaseClaim': {
        // Pessoa trocou de celular / limpou navegador: libera a identidade pra re-claim
        const { slug } = body;
        if (!slug) return bad(cors, 'slug obrigatório');
        await fbFetch(env, `claims/${slug}.json`, { method: 'DELETE' });
        return ok(cors, { released: slug });
      }

      case 'deleteParticipant': {
        // Remove um participante por completo: identidade, claim, palpites e bônus.
        // Útil pra apagar duplicata (ex.: "Pedro" e "Nem" são a mesma pessoa).
        const { uid, slug } = body;
        if (!uid) return bad(cors, 'uid obrigatório');
        await fbFetch(env, `participants/${uid}.json`, { method: 'DELETE' });
        await fbFetch(env, `palpites/${uid}.json`, { method: 'DELETE' });
        await fbFetch(env, `bonus/${uid}.json`, { method: 'DELETE' });
        if (slug) await fbFetch(env, `claims/${slug}.json`, { method: 'DELETE' });
        return ok(cors, { deleted: uid, slug: slug || null });
      }

      case 'renameParticipant': {
        // Corrige o nome exibido de um participante (mantém uid/claim/palpites).
        const { uid, name } = body;
        if (!uid || !name) return bad(cors, 'uid e name obrigatórios');
        await fbFetch(env, `participants/${uid}/name.json`, {
          method: 'PUT',
          body: JSON.stringify(String(name).slice(0, 24)),
        });
        return ok(cors, { uid, name });
      }

      case 'setLockBonusAt': {
        // Ajusta quando os bônus travam (epoch ms)
        const { lockBonusAt } = body;
        if (!lockBonusAt) return bad(cors, 'lockBonusAt obrigatório');
        await fbFetch(env, 'meta/lockBonusAt.json', {
          method: 'PUT',
          body: JSON.stringify(toIntOrNull(lockBonusAt)),
        });
        return ok(cors, { lockBonusAt: toIntOrNull(lockBonusAt) });
      }

      default:
        return bad(cors, 'ação desconhecida');
    }
  } catch (e) {
    return { statusCode: 500, headers: cors, body: JSON.stringify({ error: e.message }) };
  }
};

function ok(headers, data) {
  return { statusCode: 200, headers, body: JSON.stringify(data) };
}
function bad(headers, msg) {
  return { statusCode: 400, headers, body: JSON.stringify({ error: msg }) };
}
function toIntOrNull(v) {
  const n = parseInt(v, 10);
  return Number.isNaN(n) ? null : n;
}
function w90(h, a) {
  if (h == null || a == null) return null;
  return h > a ? 'HOME' : a > h ? 'AWAY' : 'DRAW';
}
