import { useState } from 'react'
import Header from './components/Header.jsx'
import PropAnalyzer from './components/PropAnalyzer.jsx'
import GameAnalyzer from './components/GameAnalyzer.jsx'
import BatchAnalyzer from './components/BatchAnalyzer.jsx'

export default function App() {
  const [tab, setTab] = useState('props')
  return (
    <div className="min-h-screen bg-dark-bg text-white">
      <Header />
      <div className="container mx-auto px-4 py-8">
        <div className="flex mb-8 bg-dark-card rounded-lg p-1">
          {[
            { id: 'props', label: 'Player Props' },
            { id: 'games', label: 'Game Lines' },
            { id: 'batch', label: 'Batch Analysis' }
          ].map(t => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={`${'flex-1 py-3 px-6 rounded-md transition-all'} ${tab === t.id ? 'bg-betting-green text-white shadow-lg' : 'text-gray-400 hover:text-white hover:bg-gray-700'}`}
            >
              {t.label}
            </button>
          ))}
        </div>

        <div className="max-w-6xl mx-auto">
          {tab === 'props' && <PropAnalyzer />}
          {tab === 'games' && <GameAnalyzer />}
          {tab === 'batch' && <BatchAnalyzer />}
        </div>
      </div>
    </div>
  )
}
