import { runCors } from './_cors.js';
import { APIClient } from '../lib/apiClient.js';
import { PlayerPropsEngine } from '../lib/engines/playerPropsEngine.js';
import { GameLinesEngine } from '../lib/engines/gameLinesEngine.js';

const apiClient = new APIClient(process.env.SPORTSDATA_API_KEY || '');
const propsEngine = new PlayerPropsEngine(apiClient);
const gameEngine  = new GameLinesEngine(apiClient);

export default async function handler(req, res) {
  try {
    await runCors(req, res);
    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const { props = [], games = [] } = body;

    const propResults = await Promise.allSettled(props.map(p => propsEngine.evaluateProp(p)));
    const gameResults = await Promise.allSettled(games.map(g => gameEngine.evaluateGameLine(g)));

    const ok = x => x.status === 'fulfilled';
    const propsOk = propResults.filter(ok).map(r => r.value);
    const gamesOk = gameResults.filter(ok).map(r => r.value);

    return res.status(200).json({
      props: propsOk,
      games: gamesOk,
      summary: {
        totalProps: propsOk.length,
        propsToLock: propsOk.filter(p => p.decision === 'LOCK').length,
        totalGames: gamesOk.length,
        gamesToBet: gamesOk.filter(g => g.recommendation === 'BET').length,
      },
      errors: {
        propErrors: propResults.length - propsOk.length,
        gameErrors: gameResults.length - gamesOk.length,
      },
    });
  } catch (e) {
    console.error('analyze-batch error', e);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
