import { useState } from 'react'
import axios from 'axios'

export default function BatchAnalyzer() {
  const [results, setResults] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const sample = {
    props: [
      {
        sport: 'WNBA',
        player: 'Natasha Cloud (LIB)',
        opponent: 'WAS',
        prop: 'Assists 5.5',
        odds: { over: 2.18, under: 1.63 },
        startTime: '2025-09-10T19:00:00',
        venue: 'Barclays Center',
        workload: 32,
        injuryNotes: 'NONE',
        additional: 'Opponent allows 22% AST rate last 30 games'
      }
    ],
    games: [
      {
        sport: 'NBA',
        home: 'LAL',
        away: 'GSW',
        line: '-3.5',
        odds: { home: 1.95, away: 1.85 },
        startTime: '2025-09-10T20:00:00',
        venue: 'Crypto.com Arena'
      }
    ]
  }

  const run = async () => {
    setLoading(true); setError(''); setResults(null)
    try {
      const res = await axios.post('/api/analyze-batch', sample, { headers: { 'Content-Type': 'application/json' }})
      setResults(res.data)
    } catch (e) {
      setError(e?.response?.data?.message || e.message || 'Batch analysis failed.')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="max-w-4xl mx-auto">
      <div className="bg-dark-card rounded-lg p-6">
        <h2 className="text-2xl font-bold mb-6 text-betting-green">Batch Analysis</h2>

        <div className="mb-6">
          <p className="text-gray-300 mb-4">Click to run a sample prop + game batch.</p>
          <button onClick={run} disabled={loading}
            className="bg-betting-green text-white py-3 px-6 rounded-md font-medium hover:bg-green-600 disabled:opacity-50 disabled:cursor-not-allowed transition-colors">
            {loading ? 'Processing...' : 'Run Sample Analysis'}
          </button>
        </div>

        {error && (
          <div className="mb-6 p-4 bg-red-900 border border-red-700 rounded-md">
            <p className="text-red-300">{error}</p>
          </div>
        )}

        {loading && (
          <div className="text-center py-8">
            <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-betting-green mx-auto mb-4"></div>
            <p className="text-betting-green">Processing batch analysis...</p>
          </div>
        )}

        {results && (
          <div className="space-y-6">
            <div className="bg-gray-800 p-4 rounded-lg">
              <h3 className="text-lg font-semibold mb-4 text-betting-green">Summary</h3>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-center">
                <div>
                  <div className="text-2xl font-bold text-betting-green">{results.summary.propsToLock}</div>
                  <div className="text-sm text-gray-400">Props to Lock</div>
                </div>
                <div>
                  <div className="text-2xl font-bold text-gray-300">{results.summary.totalProps}</div>
                  <div className="text-sm text-gray-400">Total Props</div>
                </div>
                <div>
                  <div className="text-2xl font-bold text-betting-green">{results.summary.gamesToBet}</div>
                  <div className="text-sm text-gray-400">Games to Bet</div>
                </div>
                <div>
                  <div className="text-2xl font-bold text-gray-300">{results.summary.totalGames}</div>
                  <div className="text-sm text-gray-400">Total Games</div>
                </div>
              </div>
            </div>

            {Array.isArray(results.props) && results.props.length > 0 && (
              <div>
                <h3 className="text-lg font-semibold mb-4 text-betting-green">Player Props</h3>
                <div className="space-y-4">
                  {results.props.map((p, i) => (
                    <div key={i} className="bg-gray-800 p-4 rounded-lg">
                      <div className="flex items-center justify-between">
                        <div>
                          <div className="font-semibold">{p.player}</div>
                          <div className="text-sm text-gray-400">{p.prop}</div>
                        </div>
                        <div className="text-right">
                          <div className={`font-bold ${p.decision === 'LOCK' ? 'text-betting-green' : 'text-gray-400'}`}>
                            {p.decision}
                          </div>
                          <div className="text-sm text-gray-400">{p.finalConfidence}% confidence</div>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {Array.isArray(results.games) && results.games.length > 0 && (
              <div>
                <h3 className="text-lg font-semibold mb-4 text-betting-green">Game Lines</h3>
                <div className="space-y-4">
                  {results.games.map((g, i) => (
                    <div key={i} className="bg-gray-800 p-4 rounded-lg">
                      <div className="flex items-center justify-between">
                        <div>
                          <div className="font-semibold">{g.game}</div>
                          <div className="text-sm text-gray-400">{g.line}</div>
                        </div>
                        <div className="text-right">
                          <div className={`font-bold ${g.recommendation === 'BET' ? 'text-betting-green' : 'text-gray-400'}`}>
                            {g.recommendation}
                          </div>
                          <div className="text-sm text-gray-400">{g.confidence}% confidence</div>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

          </div>
        )}
      </div>
    </div>
  )
}
