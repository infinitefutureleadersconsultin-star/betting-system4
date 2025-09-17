import { useState } from 'react'
import axios from 'axios'

export default function App() {
  const [ping, setPing] = useState(null)
  const [error, setError] = useState('')

  const checkHealth = async () => {
    setError('')
    setPing(null)
    try {
      const res = await axios.get('/api/health')
      setPing(res.data)
    } catch (e) {
      setError(e?.response?.data?.message || e.message)
    }
  }

  return (
    <div className="min-h-screen text-white" style={{ background: '#0F172A', padding: 24 }}>
      <h1 className="text-3xl font-bold" style={{ color: '#10B981' }}>
        ✅ Vite + React + Vercel Functions
      </h1>
      <p className="text-gray-300 mt-2">
        If you can see this, the white screen problem is fixed.
      </p>

      <div className="mt-6">
        <button
          onClick={checkHealth}
          className="px-4 py-2 rounded"
          style={{ background: '#10B981' }}
        >
          Call /api/health
        </button>
      </div>

      {ping && (
        <pre className="mt-4 p-3 rounded" style={{ background: '#1E293B' }}>
{JSON.stringify(ping, null, 2)}
        </pre>
      )}

      {error && (
        <div className="mt-4 p-3 rounded" style={{ background: '#7f1d1d' }}>
          <div className="text-red-200">Error: {error}</div>
        </div>
      )}
    </div>
  )
}
