// api/analyze-game.js
import { runCors } from './_cors.js';
import { APIClient } from '../lib/apiClient.js';
import { GameLinesEngine } from '../lib/engines/gameLinesEngine.js';

const apiClient = new APIClient(process.env.SPORTSDATA_API_KEY || '');
const engine = new GameLinesEngine(apiClient);

export default async function handler(req, res) {
  try {
    const proceed = await runCors(req, res);
    if (proceed === false) return;

    if (req.method !== 'POST') {
      return res.status(405).json({ error: 'Method not allowed' });
    }

    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const result = await engine.evaluateGameLine(body);
    return res.status(200).json(result);
  } catch (e) {
    console.error('analyze-game error', e?.stack || e?.message || e);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
