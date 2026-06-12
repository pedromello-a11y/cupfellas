// WorldFellas — sync agendado (a cada 15 min, ver netlify.toml)
const { runSync } = require('./sync-core');

exports.handler = async () => {
  try {
    const result = await runSync(process.env);
    console.log('sync ok', JSON.stringify(result));
    return { statusCode: 200, body: JSON.stringify(result) };
  } catch (e) {
    console.error('sync falhou', e);
    return { statusCode: 500, body: JSON.stringify({ error: e.message }) };
  }
};
