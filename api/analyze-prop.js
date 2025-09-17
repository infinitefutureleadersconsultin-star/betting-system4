import { PlayerPropsEngine } from '../lib/engines/playerPropsEngine.js'

const engine = new PlayerPropsEngine()

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  if (req.method === 'OPTIONS') return res.status(200).end()
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {})
    const result = engine.evaluateProp(body)
    return res.status(200).json(result)
  } catch (e) {
    console.error('analyze-prop error', e)
    return res.status(500).json({ error: 'Internal server error' })
  }
}
