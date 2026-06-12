// WorldFellas — EXPERIMENTO: acha o vídeo da CazéTV pro jogo certo (busca por título).
// Resolve o ponto fraco do embed `live_stream?channel=` (só mostra 1 stream do canal
// principal): identifica o vídeo do JOGO casando os nomes dos times com o título.
//
// IMPORTANTE (descoberta de viabilidade): raspar youtube.com de dentro de uma function
// NÃO funciona — o YouTube entrega a página pro IP de datacenter da Netlify SEM a lista
// de vídeos (só 1 videoId no HTML, vs dezenas a partir de um IP residencial). Como o
// cliente sempre chama ESTA function (que roda na Netlify), scraping é inviável aqui,
// não importa onde o usuário esteja.
//
// Caminhos, em ordem de confiabilidade:
//   1) YouTube Data API v3 (se houver env YOUTUBE_API_KEY) — oficial, funciona de
//      datacenter. search.list eventType=live por canal, casa por título. Grátis:
//      10k unidades/dia; search custa 100 → ~100 buscas/dia (sobra pra um bolão).
//   2) RSS do canal (sem key) — best-effort; só os 15 vídeos mais recentes e nem sempre
//      inclui a live em andamento.
//   3) Fallback: embed `live_stream?channel=` (transmissão principal do canal).

const CHANNEL_ID = 'UCZiYbVptd3PVPf4f6eR6UaQ';
const RSS = 'https://www.youtube.com/feeds/videos.xml?channel_id=' + CHANNEL_ID;
const API = 'https://www.googleapis.com/youtube/v3/search';

function norm(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
const STOP = new Set(['do', 'da', 'de', 'dos', 'das', 'e', 'rep', 'republica', 'south', 'north', 'ir']);
function tokens(name) {
  return norm(name).split(' ').filter((t) => t.length >= 3 && !STOP.has(t));
}
function scoreMatch(title, homeTokens, awayTokens) {
  const nt = norm(title);
  const hit = (toks) => toks.some((t) => nt.includes(t));
  const countHits = (toks) => toks.filter((t) => nt.includes(t)).length;
  if (!hit(homeTokens) || !hit(awayTokens)) return 0; // precisa citar os DOIS times
  let score = 10 + countHits(homeTokens) + countHits(awayTokens);
  if (/\bx\b|\bvs\b/.test(nt)) score += 2;
  if (/ao vivo|copa|mundo|fifa|world cup/.test(nt)) score += 1;
  return score;
}
function pickBest(items, homeTokens, awayTokens, liveBonus) {
  let best = null, bestScore = 0;
  for (const it of items) {
    let s = scoreMatch(it.title, homeTokens, awayTokens);
    if (s === 0) continue;
    if (liveBonus) {
      if (it.broadcast) s += 5; // é uma transmissão (live ou agendada), não um vídeo qualquer
      if (it.live) s += 3;
    }
    if (s > bestScore) { bestScore = s; best = it; }
  }
  return bestScore >= 10 ? best : null;
}

// 1) Data API (oficial). A CazéTV pré-cria 1 vídeo "AO VIVO: TIME X TIME" por jogo
// (fica "upcoming" até a transmissão começar, depois vira "live"). Buscar pelos nomes
// dos times (em vez de "CazéTV") acha esse vídeo específico mesmo com várias lives
// simultâneas no canal — eventType=live retorna só a transmissão "principal" do canal.
async function viaApi(key, home, away, homeTokens, awayTokens) {
  const q = encodeURIComponent(`${home} ${away}`);
  const url = `${API}?part=snippet&channelId=${CHANNEL_ID}&type=video&q=${q}&maxResults=15&regionCode=BR&relevanceLanguage=pt&key=${key}`;
  const res = await fetch(url);
  if (!res.ok) return null;
  const json = await res.json();
  const items = (json.items || []).map((i) => {
    const lbc = (i.snippet && i.snippet.liveBroadcastContent) || 'none';
    return {
      videoId: i.id && i.id.videoId,
      title: (i.snippet && i.snippet.title) || '',
      live: lbc === 'live',
      broadcast: lbc !== 'none',
    };
  }).filter((i) => i.videoId);
  return pickBest(items, homeTokens, awayTokens, true);
}

// 2) Página /live (sem key). Pega a transmissão AO VIVO atual do canal principal via
// canonical/og:url — esse meta SOBREVIVE no IP de datacenter (ao contrário da lista de
// vídeos). Só retorna se o título da live casar com os dois times (= é o jogo pedido).
async function viaLivePage(homeTokens, awayTokens) {
  const res = await fetch('https://www.youtube.com/@CazeTV/live?gl=BR&hl=pt-BR', {
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36', 'Accept-Language': 'pt-BR' },
  });
  if (!res.ok) return null;
  const h = await res.text();
  const canonical = (h.match(/<link rel="canonical" href="([^"]+)"/) || [])[1]
    || (h.match(/<meta property="og:url" content="([^"]+)"/) || [])[1] || '';
  const title = (h.match(/<meta property="og:title" content="([^"]+)"/) || [])[1] || '';
  const vid = canonical.match(/v=([\w-]{11})/);
  if (!vid) return null;
  return pickBest([{ videoId: vid[1], title, live: true }], homeTokens, awayTokens, true);
}

// 3) RSS (sem key). Best-effort.
async function viaRss(homeTokens, awayTokens) {
  const res = await fetch(RSS, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!res.ok) return null;
  const xml = await res.text();
  const items = [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)].map((m) => {
    const e = m[1];
    return {
      videoId: (e.match(/<yt:videoId>([\w-]+)<\/yt:videoId>/) || [])[1],
      title: (e.match(/<title>([^<]+)<\/title>/) || [])[1] || '',
      live: false,
    };
  }).filter((i) => i.videoId);
  return pickBest(items, homeTokens, awayTokens, false);
}

exports.handler = async (event) => {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: cors, body: '' };

  const q = event.queryStringParameters || {};
  const home = q.home || '', away = q.away || '';
  if (!home || !away) {
    return { statusCode: 400, headers: cors, body: JSON.stringify({ error: 'home e away obrigatórios' }) };
  }

  const homeTokens = tokens(home), awayTokens = tokens(away);
  const out = (obj) => ({ statusCode: 200, headers: cors, body: JSON.stringify(obj) });
  const matchOut = (best, via) => out({
    matched: true, via, videoId: best.videoId, title: best.title, live: !!best.live,
    embedUrl: 'https://www.youtube.com/embed/' + best.videoId,
  });

  try {
    if (process.env.YOUTUBE_API_KEY) {
      const best = await viaApi(process.env.YOUTUBE_API_KEY, home, away, homeTokens, awayTokens);
      if (best) return matchOut(best, 'api');
    }
    const livePage = await viaLivePage(homeTokens, awayTokens); // live atual, sem key
    if (livePage) return matchOut(livePage, 'livepage');
    const rss = await viaRss(homeTokens, awayTokens);
    if (rss) return matchOut(rss, 'rss');
  } catch (e) {
    // qualquer erro de rede cai no fallback abaixo
  }
  return out({
    matched: false, channel: CHANNEL_ID,
    embedUrl: 'https://www.youtube.com/embed/live_stream?channel=' + CHANNEL_ID,
    hint: process.env.YOUTUBE_API_KEY ? 'sem live casando o título agora' : 'sem key: resolve só a live do canal principal (1 por vez)',
  });
};
