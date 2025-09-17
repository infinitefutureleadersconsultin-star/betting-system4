import { PlayerPropsEngine } from '../lib/engines/playerPropsEngine.js'
import { GameLinesEngine } from '../lib/engines/gameLinesEngine.js'

const propsEngine = new PlayerPropsEngine()
const gameEngine  = new GameLinesEngine()

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  if (req.method === 'OPTIONS') return res.status(200).end()
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {})
    const { props = [], games = [] } = body

    const propResults = props.map(p => propsEngine.evaluateProp(p))
    const gameResults = games.map(g => gameEngine.evaluateGameLine(g))

    return res.status(200).json({
      props: propResults,
      games: gameResults,
      summary: {
        totalProps: propResults.length,
        propsToLock: propResults.filter(p => p.decision === 'LOCK').length,
        totalGames: gameResults.length,
        gamesToBet: gameResults.filter(g => g.recommendation === 'BET').length
      },
      errors: { propErrors: 0, gameErrors: 0 }
    })
  } catch (e) {
    console.error('analyze-batch error', e)
    return res.status(500).json({ error: 'Internal server error' })
  }
}
