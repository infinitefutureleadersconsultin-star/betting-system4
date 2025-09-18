import { runCors } from './_cors.js';
import { APIClient } from '../lib/apiClient.js';
import { PlayerPropsEngine } from '../lib/engines/playerPropsEngine.js';

const apiClient = new APIClient(process.env.SPORTSDATA_API_KEY || '');
const engine = new PlayerPropsEngine(apiClient);

export default async function handler(req, res) {
  try {
    await runCors(req, res);
    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    const raw = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const body = {
      ...raw,
      odds: { over: Number(raw?.odds?.over) || 2.0, under: Number(raw?.odds?.under) || 1.8 },
      startTime: raw?.startTime || new Date(Date.now() + 6 * 3600e3).toISOString(),
    };

    const result = await engine.evaluateProp(body);
    const n = (x, d=0)=>Number.isFinite(x)?x:d;

    const source = (typeof result?.meta?.dataSource === "string") ? result.meta.dataSource : "unknown";
return res.status(200).json({ ...response, meta: { dataSource: source } });
      player: result.player || body.player || 'Unknown Player',
      prop: result.prop || body.prop || 'Prop',
      suggestion: result.suggestion || (n(result?.rawNumbers?.modelProbability,0.5) >= 0.5 ? 'OVER' : 'UNDER'),
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
    });
  } catch (err) {
    console.error('analyze-prop fatal', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
