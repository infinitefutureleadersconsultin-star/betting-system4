import { runCors } from './_cors.js';
import { APIClient } from '../lib/apiClient.js';
import { PlayerPropsEngine } from '../lib/engines/playerPropsEngine.js';

const apiClient = new APIClient(process.env.SPORTSDATA_API_KEY || '');
const engine = new PlayerPropsEngine(apiClient);

// read JSON body even when req.body is undefined on Vercel
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

    const raw = await readJSON(req);
    const body = {
      ...raw,
      odds: { over: Number(raw?.odds?.over) || 2.0, under: Number(raw?.odds?.under) || 1.8 },
      startTime: raw?.startTime || new Date(Date.now() + 6 * 3600e3).toISOString(),
    };

    const result = await engine.evaluateProp(body);
    const n = (x, d = 0) => (Number.isFinite(x) ? x : d);

    const response = {
      player: result.player || body.player || 'Unknown Player',
      prop: result.prop || body.prop || 'Prop',
      suggestion: result.suggestion || (n(result?.rawNumbers?.modelProbability, 0.5) >= 0.5 ? 'OVER' : 'UNDER'),
      decision: result.decision || 'PASS',
      finalConfidence: n(result.finalConfidence, 0),
      suggestedStake: n(result.suggestedStake, 0),
      topDrivers: Array.isArray(result.topDrivers) ? result.topDrivers : [],
      flags: Array.isArray(result.flags) ? result.flags : [],
      rawNumbers: {
        expectedValue: n(result?.rawNumbers?.expectedValue, 0),
        stdDev: n(result?.rawNumbers?.stdDev, 1),
        modelProbability: n(result?.rawNumbers?.modelProbability, 0.5),
        marketProbability: n(result?.rawNumbers?.marketProbability, 0.5),
        sharpSignal: n(result?.rawNumbers?.sharpSignal, 0),
      },
    };

    const source = (typeof result?.meta?.dataSource === 'string') ? result.meta.dataSource : 'fallback';
    return res.status(200).json({ ...response, meta: { dataSource: source } });
  } catch (err) {
    console.error('analyze-prop fatal', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
