import { useState } from 'react'
import axios from 'axios'
import ResultCard from './ResultCard.jsx'
import LoadingSpinner from './LoadingSpinner.jsx'

export default function GameAnalyzer() {
  const [form, setForm] = useState({
    sport: 'NBA',
    home: '',
    away: '',
    line: '',
    odds: { home: '', away: '' },
    startTime: '',
    venue: ''
  })
  const [result, setResult] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const handleChange = (field, value) => {
    if (field.includes('.')) {
      const [p, c] = field.split('.')
      setForm(prev => ({ ...prev, [p]: { ...prev[p], [c]: value } }))
    } else {
      setForm(prev => ({ ...prev, [field]: value }))
    }
  }

  const onSubmit = async (e) => {
    e.preventDefault()
    setLoading(true); setError(''); setResult(null)
    try {
      const payload = {
        ...form,
        odds: {
          home: parseFloat(form.odds.home),
          away: parseFloat(form.odds.away)
        }
      }
      const res = await axios.post('/api/analyze-game', payload, {
        headers: { 'Content-Type': 'application/json' }
      })
      setResult(res.data)
    } catch (err) {
      setError(err?.response?.data?.message || err.message || 'Analysis failed.')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
      {/* Form */}
      <div className="bg-dark-card rounded-lg p-6">
        <h2 className="text-xl font-bold mb-6 text-betting-green">Game Line Analysis</h2>

        <form onSubmit={onSubmit} className="space-y-4">
          <div>
            <label className="block text-sm font-medium mb-2">Sport</label>
            <select
              value={form.sport}
              onChange={(e) => handleChange('sport', e.target.value)}
              className="w-full p-3 bg-gray-700 rounded-md border border-gray-600 focus:border-betting-green focus:ring-1 focus:ring-betting-green"
            >
              <option value="MLB">MLB</option>
              <option value="NBA">NBA</option>
              <option value="WNBA">WNBA</option>
              <option value="NFL">NFL</option>
            </select>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium mb-2">Home Team</label>
              <input className="w-full p-3 bg-gray-700 rounded-md border border-gray-600 focus:border-betting-green focus:ring-1 focus:ring-betting-green"
                value={form.home} onChange={e => handleChange('home', e.target.value)} placeholder="HOME" required />
            </div>
            <div>
              <label className="block text-sm font-medium mb-2">Away Team</label>
              <input className="w-full p-3 bg-gray-700 rounded-md border border-gray-600 focus:border-betting-green focus:ring-1 focus:ring-betting-green"
                value={form.away} onChange={e => handleChange('away', e.target.value)} placeholder="AWAY" required />
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium mb-2">Line</label>
            <input className="w-full p-3 bg-gray-700 rounded-md border border-gray-600 focus:border-betting-green focus:ring-1 focus:ring-betting-green"
              value={form.line} onChange={e => handleChange('line', e.target.value)} placeholder="-3.5 / +7.5 / O/U 220.5" required />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium mb-2">Home Odds</label>
              <input type="number" step="0.01"
                className="w-full p-3 bg-gray-700 rounded-md border border-gray-600 focus:border-betting-green focus:ring-1 focus:ring-betting-green"
                value={form.odds.home} onChange={e => handleChange('odds.home', e.target.value)} placeholder="1.95" required />
            </div>
            <div>
              <label className="block text-sm font-medium mb-2">Away Odds</label>
              <input type="number" step="0.01"
                className="w-full p-3 bg-gray-700 rounded-md border border-gray-600 focus:border-betting-green focus:ring-1 focus:ring-betting-green"
                value={form.odds.away} onChange={e => handleChange('odds.away', e.target.value)} placeholder="1.85" required />
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium mb-2">Start Time</label>
            <input type="datetime-local"
              className="w-full p-3 bg-gray-700 rounded-md border border-gray-600 focus:border-betting-green focus:ring-1 focus:ring-betting-green"
              value={form.startTime} onChange={e => handleChange('startTime', e.target.value)} required />
          </div>

          <div>
            <label className="block text-sm font-medium mb-2">Venue</label>
            <input className="w-full p-3 bg-gray-700 rounded-md border border-gray-600 focus:border-betting-green focus:ring-1 focus:ring-betting-green"
              value={form.venue} onChange={e => handleChange('venue', e.target.value)} placeholder="Stadium/Arena" />
          </div>

          <button type="submit" disabled={loading}
            className="w-full bg-betting-green text-white py-3 px-6 rounded-md font-medium hover:bg-green-600 disabled:opacity-50 disabled:cursor-not-allowed transition-colors">
            {loading ? 'Analyzing...' : 'Analyze Game'}
          </button>
        </form>

        {error && (
          <div className="mt-4 p-4 bg-red-900 border border-red-700 rounded-md">
            <p className="text-red-300">{error}</p>
          </div>
        )}
      </div>

      {/* Results */}
      <div className="bg-dark-card rounded-lg p-6">
        <h2 className="text-xl font-bold mb-6 text-betting-green">Analysis Result</h2>
        {loading && <LoadingSpinner />}
        {result && <ResultCard result={result} type="game" />}
        {!loading && !result && (
          <div className="text-center text-gray-400 py-12">
            <div className="text-4xl mb-4">🏀</div>
            <p>Enter game details and click analyze to see results</p>
          </div>
        )}
      </div>
    </div>
  )
}
