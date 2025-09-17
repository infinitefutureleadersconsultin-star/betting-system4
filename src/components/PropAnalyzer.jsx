import { useState } from 'react'
import axios from 'axios'
import ResultCard from './ResultCard.jsx'
import LoadingSpinner from './LoadingSpinner.jsx'

export default function PropAnalyzer() {
  const [form, setForm] = useState({
    sport: 'NBA',
    player: '',
    opponent: '',
    prop: '',
    odds: { over: '', under: '' },
    startTime: '',
    venue: '',
    workload: '',
    injuryNotes: '',
    additional: ''
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
          over: parseFloat(form.odds.over),
          under: parseFloat(form.odds.under)
        },
        workload: form.workload === '' ? 'AUTO' : form.workload
      }
      const res = await axios.post('/api/analyze-prop', payload, {
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
        <h2 className="text-xl font-bold mb-6 text-betting-green">Player Prop Analysis</h2>
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
              <label className="block text-sm font-medium mb-2">Player</label>
              <input className="w-full p-3 bg-gray-700 rounded-md border border-gray-600 focus:border-betting-green focus:ring-1 focus:ring-betting-green"
                value={form.player} onChange={e => handleChange('player', e.target.value)} placeholder="Player Name (TEAM)" required />
            </div>
            <div>
              <label className="block text-sm font-medium mb-2">Opponent</label>
              <input className="w-full p-3 bg-gray-700 rounded-md border border-gray-600 focus:border-betting-green focus:ring-1 focus:ring-betting-green"
                value={form.opponent} onChange={e => handleChange('opponent', e.target.value)} placeholder="OPP" required />
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium mb-2">Prop</label>
            <input className="w-full p-3 bg-gray-700 rounded-md border border-gray-600 focus:border-betting-green focus:ring-1 focus:ring-betting-green"
              value={form.prop} onChange={e => handleChange('prop', e.target.value)} placeholder="Assists 5.5, Strikeouts 6.5, etc." required />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium mb-2">Over Odds</label>
              <input type="number" step="0.01"
                className="w-full p-3 bg-gray-700 rounded-md border border-gray-600 focus:border-betting-green focus:ring-1 focus:ring-betting-green"
                value={form.odds.over} onChange={e => handleChange('odds.over', e.target.value)} placeholder="2.10" required />
            </div>
            <div>
              <label className="block text-sm font-medium mb-2">Under Odds</label>
              <input type="number" step="0.01"
                className="w-full p-3 bg-gray-700 rounded-md border border-gray-600 focus:border-betting-green focus:ring-1 focus:ring-betting-green"
                value={form.odds.under} onChange={e => handleChange('odds.under', e.target.value)} placeholder="1.75" required />
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium mb-2">Start Time</label>
              <input type="datetime-local"
                className="w-full p-3 bg-gray-700 rounded-md border border-gray-600 focus:border-betting-green focus:ring-1 focus:ring-betting-green"
                value={form.startTime} onChange={e => handleChange('startTime', e.target.value)} required />
            </div>
            <div>
              <label className="block text-sm font-medium mb-2">Workload</label>
              <input
                className="w-full p-3 bg-gray-700 rounded-md border border-gray-600 focus:border-betting-green focus:ring-1 focus:ring-betting-green"
                value={form.workload} onChange={e => handleChange('workload', e.target.value)} placeholder="32 min / 6.0 IP / 35 attempts" />
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium mb-2">Venue</label>
            <input className="w-full p-3 bg-gray-700 rounded-md border border-gray-600 focus:border-betting-green focus:ring-1 focus:ring-betting-green"
              value={form.venue} onChange={e => handleChange('venue', e.target.value)} placeholder="Stadium/Arena" />
          </div>

          <div>
            <label className="block text-sm font-medium mb-2">Injury/Rest Notes</label>
            <input className="w-full p-3 bg-gray-700 rounded-md border border-gray-600 focus:border-betting-green focus:ring-1 focus:ring-betting-green"
              value={form.injuryNotes} onChange={e => handleChange('injuryNotes', e.target.value)} placeholder="NONE, Questionable (knee), etc." />
          </div>

          <div>
            <label className="block text-sm font-medium mb-2">Additional Notes</label>
            <textarea className="w-full p-3 bg-gray-700 rounded-md border border-gray-600 focus:border-betting-green focus:ring-1 focus:ring-betting-green h-20"
              value={form.additional} onChange={e => handleChange('additional', e.target.value)} placeholder="Weather, matchup notes, etc." />
          </div>

          <button type="submit" disabled={loading}
            className="w-full bg-betting-green text-white py-3 px-6 rounded-md font-medium hover:bg-green-600 disabled:opacity-50 disabled:cursor-not-allowed transition-colors">
            {loading ? 'Analyzing...' : 'Analyze Prop'}
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
        {result && <ResultCard result={result} type="prop" />}
        {!loading && !result && (
          <div className="text-center text-gray-400 py-12">
            <div className="text-4xl mb-4">📊</div>
            <p>Enter prop details and click analyze to see results</p>
          </div>
        )}
      </div>
    </div>
  )
}
