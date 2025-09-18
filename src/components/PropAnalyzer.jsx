// src/components/PropAnalyzer.jsx
import React, { useState } from 'react';
import axios from 'axios';
import ResultCard from './ResultCard';
import LoadingSpinner from './LoadingSpinner';
import { logAnalysisEvent } from '../utils/analytics';

const PropAnalyzer = () => {
  const [formData, setFormData] = useState({
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
  });

  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const handleSubmit = async (e) => {
    e.preventDefault();
    setLoading(true);
    setError('');
    setResult(null);

    try {
      const analysisData = {
        ...formData,
        odds: {
          over: parseFloat(formData.odds.over),
          under: parseFloat(formData.odds.under),
        },
        // keep AUTO if user leaves blank
        workload: formData.workload === '' ? 'AUTO' : formData.workload,
      };

      const response = await axios.post('/api/analyze-prop', analysisData);
      const data = response.data;

      setResult(data);

      // === Calibration log (Vercel Analytics + localStorage CSV) ===
      logAnalysisEvent('prop', {
        sport: formData.sport,
        player: formData.player,
        opponent: formData.opponent,
        prop: formData.prop,
        over: formData.odds.over,
        under: formData.odds.under,
        startTime: formData.startTime,
        decision: data?.decision,
        suggestion: data?.suggestion,
        finalConfidence: data?.finalConfidence
      });
      // =============================================================
    } catch (err) {
      setError(err.response?.data?.message || 'Analysis failed. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  const handleInputChange = (field, value) => {
    if (field.includes('.')) {
      const [parent, child] = field.split('.');
      setFormData((prev) => ({
        ...prev,
        [parent]: {
          ...prev[parent],
          [child]: value,
        },
      }));
    } else {
      setFormData((prev) => ({
        ...prev,
        [field]: value,
      }));
    }
  };

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
      {/* Input Form */}
      <div className="bg-dark-card rounded-lg p-6">
        <h2 className="text-xl font-bold mb-6 text-betting-green">Player Prop Analysis</h2>

        <form onSubmit={handleSubmit} className="space-y-4">
          {/* Sport Selection */}
          <div>
            <label className="block text-sm font-medium mb-2">Sport</label>
            <select
              value={formData.sport}
              onChange={(e) => handleInputChange('sport', e.target.value)}
              className="w-full p-3 bg-gray-700 rounded-md border border-gray-600 focus:border-betting-green focus:ring-1 focus:ring-betting-green"
            >
              <option value="MLB">MLB</option>
              <option value="NBA">NBA</option>
              <option value="WNBA">WNBA</option>
              <option value="NFL">NFL</option>
            </select>
          </div>

          {/* Player Info */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium mb-2">Player</label>
              <input
                type="text"
                value={formData.player}
                onChange={(e) => handleInputChange('player', e.target.value)}
                placeholder="Player Name (TEAM)"
                className="w-full p-3 bg-gray-700 rounded-md border border-gray-600 focus:border-betting-green focus:ring-1 focus:ring-betting-green"
                required
              />
            </div>
            <div>
              <label className="block text-sm font-medium mb-2">Opponent</label>
              <input
                type="text"
                value={formData.opponent}
                onChange={(e) => handleInputChange('opponent', e.target.value)}
                placeholder="OPP"
                className="w-full p-3 bg-gray-700 rounded-md border border-gray-600 focus:border-betting-green focus:ring-1 focus:ring-betting-green"
                required
              />
            </div>
          </div>

          {/* Prop & Odds */}
          <div>
            <label className="block text-sm font-medium mb-2">Prop</label>
            <input
              type="text"
              value={formData.prop}
              onChange={(e) => handleInputChange('prop', e.target.value)}
              placeholder="e.g., Assists 5.5, Strikeouts 6.5, Pass Yards 275.5"
              className="w-full p-3 bg-gray-700 rounded-md border border-gray-600 focus:border-betting-green focus:ring-1 focus:ring-betting-green"
              required
            />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium mb-2">Over Odds</label>
              <input
                type="number"
                step="0.01"
                value={formData.odds.over}
                onChange={(e) => handleInputChange('odds.over', e.target.value)}
                placeholder="2.10"
                className="w-full p-3 bg-gray-700 rounded-md border border-gray-600 focus:border-betting-green focus:ring-1 focus:ring-betting-green"
                required
              />
            </div>
            <div>
              <label className="block text-sm font-medium mb-2">Under Odds</label>
              <input
                type="number"
                step="0.01"
                value={formData.odds.under}
                onChange={(e) => handleInputChange('odds.under', e.target.value)}
                placeholder="1.75"
                className="w-full p-3 bg-gray-700 rounded-md border border-gray-600 focus:border-betting-green focus:ring-1 focus:ring-betting-green"
                required
              />
            </div>
          </div>

          {/* Game Details */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium mb-2">Start Time</label>
              <input
                type="datetime-local"
                value={formData.startTime}
                onChange={(e) => handleInputChange('startTime', e.target.value)}
                className="w-full p-3 bg-gray-700 rounded-md border border-gray-600 focus:border-betting-green focus:ring-1 focus:ring-betting-green"
                required
              />
            </div>
            <div>
              <label className="block text-sm font-medium mb-2">Workload</label>
              <input
                type="text"
                value={formData.workload}
                onChange={(e) => handleInputChange('workload', e.target.value)}
                placeholder="32 min / 6.0 IP / 35 attempts (optional)"
                className="w-full p-3 bg-gray-700 rounded-md border border-gray-600 focus:border-betting-green focus:ring-1 focus:ring-betting-green"
              />
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium mb-2">Venue</label>
            <input
              type="text"
              value={formData.venue}
              onChange={(e) => handleInputChange('venue', e.target.value)}
              placeholder="Stadium/Arena (optional)"
              className="w-full p-3 bg-gray-700 rounded-md border border-gray-600 focus:border-betting-green focus:ring-1 focus:ring-betting-green"
            />
          </div>

          <div>
            <label className="block text-sm font-medium mb-2">Injury/Rest Notes</label>
            <input
              type="text"
              value={formData.injuryNotes}
              onChange={(e) => handleInputChange('injuryNotes', e.target.value)}
              placeholder="NONE, Questionable (knee), etc. (optional)"
              className="w-full p-3 bg-gray-700 rounded-md border border-gray-600 focus:border-betting-green focus:ring-1 focus:ring-betting-green"
            />
          </div>

          <div>
            <label className="block text-sm font-medium mb-2">Additional Notes</label>
            <textarea
              value={formData.additional}
              onChange={(e) => handleInputChange('additional', e.target.value)}
              placeholder="Weather, matchup notes, etc. (optional)"
              className="w-full p-3 bg-gray-700 rounded-md border border-gray-600 focus:border-betting-green focus:ring-1 focus:ring-betting-green h-20"
            />
          </div>

          <button
            type="submit"
            disabled={loading}
            className="w-full bg-betting-green text-white py-3 px-6 rounded-md font-medium hover:bg-green-600 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
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
  );
};

export default PropAnalyzer;
