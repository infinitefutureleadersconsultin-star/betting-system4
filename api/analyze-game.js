import { runCors } from './_cors.js';
import { APIClient } from '../lib/apiClient.js';
import { GameLinesEngine } from '../lib/engines/gameLinesEngine.js';

const apiClient = new APIClient(process.env.SPORTSDATA_API_KEY || '');
const engine = new GameLinesEngine(apiClient);

async function readJSON(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') {
    try { return JSON.parse(req.body || '{}'); } catch { return {}; }
  }
  return await new Promise((resolve) => {
    let data = '';
    req.on('data', chunk => { data += chunk; });
    req.on('end', () => {
      try { resolve(JSON.parse(data || '{}')); } catch { resolve({}); }
    });
  });
}

export default async function handler(req, res) {
  try {
    await runCors(req, res);
    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    const body = await readJSON(req);
    const result = await engine.evaluateGameLine(body);
    return res.status(200).json(result);
  } catch (e) {
    console.error('analyze-game error', e);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
