import React, { useState } from 'react';
import axios from 'axios';
import LoadingSpinner from './LoadingSpinner';
import ResultCard from './ResultCard';

export default function PropAnalyzer() {
  const [form, setForm] = useState({
    sport: 'NBA',
    player: '',
    opponent: '',
    prop: '',               // e.g., "Points 23.5" or "Strikeouts 6.5"
    oddsOver: '2.0',        // decimal odds (e.g., 1.90, 2.05)
    oddsUnder: '1.8',
    startTimeLocal: ''      // HTML datetime-local string
  });

  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');

  const handleChange = (e) => {
    const { name, value } = e.target;
    setForm((prev) => ({ ...prev, [name]: value }));
  };

  const toISOFromLocal = (local) => {
    try {
      if (!local) return '';
      // "YYYY-MM-DDTHH:mm" -> ISO
      const d = new Date(local);
      if (isNaN(d)) return '';
      return d.toISOString();
    } catch {
      return '';
    }
  };

  const handleAnalyze = async (e) => {
    e.preventDefault();
    setLoading(true);
    setError('');
    setResult(null);

    const analysisData = {
      sport: (form.sport || '').trim(),
      player: (form.player || '').trim(),
      opponent: (form.opponent || '').trim(),
      prop: (form.prop || '').trim(),
      odds: {
        over: parseFloat(form.oddsOver),
        under: parseFloat(form.oddsUnder),
      },
      // if user didn't pick a time, backend will default to now+6h
      startTime: toISOFromLocal(form.startTimeLocal),
    };

    try {
      const response = await axios.post('/api/analyze-prop', analysisData);
      console.log('[UI] /api/analyze-prop status', response.status, response.data);
      const data = response.data;
      setResult(data);
    } catch (err) {
      console.error(
        '[UI] analyze-prop failed',
        err?.response?.status,
        err?.response?.data || err?.message
      );
      setError(
        err?.response?.data?.error ||
        err?.message ||
        'Analysis failed. Please try again.'
      );
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="max-w-3xl mx-auto p-4 space-y-6">
      <h2 className="text-2xl font-semibold">Player Prop Analyzer</h2>

      <form onSubmit={handleAnalyze} className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* Sport */}
        <label className="flex flex-col">
          <span className="text-sm font-medium mb-1">Sport</span>
          <select
            name="sport"
            value={form.sport}
            onChange={handleChange}
            className="border rounded p-2"
          >
            <option>NBA</option>
            <option>WNBA</option>
            <option>MLB</option>
            <option>NFL</option>
          </select>
        </label>

        {/* Start Time */}
        <label className="flex flex-col">
          <span className="text-sm font-medium mb-1">Start Time (local)</span>
          <input
            type="datetime-local"
            name="startTimeLocal"
            value={form.startTimeLocal}
            onChange={handleChange}
            className="border rounded p-2"
          />
        </label>

        {/* Player */}
        <label className="flex flex-col">
          <span className="text-sm font-medium mb-1">Player</span>
          <input
            type="text"
            name="player"
            value={form.player}
            onChange={handleChange}
            placeholder="e.g., Nikola Jokic"
            className="border rounded p-2"
            required
          />
        </label>

        {/* Opponent */}
        <label className="flex flex-col">
          <span className="text-sm font-medium mb-1">Opponent</span>
          <input
            type="text"
            name="opponent"
            value={form.opponent}
            onChange={handleChange}
            placeholder="e.g., Lakers"
            className="border rounded p-2"
          />
        </label>

        {/* Prop */}
        <label className="flex flex-col md:col-span-2">
          <span className="text-sm font-medium mb-1">Prop</span>
          <input
            type="text"
            name="prop"
            value={form.prop}
            onChange={handleChange}
            placeholder='e.g., "Points 23.5", "Assists 8.5", "Strikeouts 6.5"'
            className="border rounded p-2"
            required
          />
        </label>

        {/* Odds Over */}
        <label className="flex flex-col">
          <span className="text-sm font-medium mb-1">Over (decimal odds)</span>
          <input
            type="number"
            step="0.01"
            name="oddsOver"
            value={form.oddsOver}
            onChange={handleChange}
            className="border rounded p-2"
          />
        </label>

        {/* Odds Under */}
        <label className="flex flex-col">
          <span className="text-sm font-medium mb-1">Under (decimal odds)</span>
          <input
            type="number"
            step="0.01"
            name="oddsUnder"
            value={form.oddsUnder}
            onChange={handleChange}
            className="border rounded p-2"
          />
        </label>

        <div className="md:col-span-2 flex items-center gap-3">
          <button
            type="submit"
            className="bg-black text-white px-4 py-2 rounded hover:opacity-90 disabled:opacity-60"
            disabled={loading}
          >
            Analyze Prop
          </button>
          {loading && <LoadingSpinner />}
        </div>
      </form>

      {error && (
        <div className="text-red-600 text-sm border border-red-200 rounded p-3 bg-red-50">
          {error}
        </div>
      )}

      {result && (
        <div className="space-y-4">
          {/* If your ResultCard expects a specific shape, this should match what the API returns */}
          <ResultCard result={result} />

          {/* Simple fallback rendering (kept in case ResultCard has different props) */}
          <div className="border rounded p-4">
            <div className="font-semibold mb-2">Analysis Result (raw)</div>
            <pre className="text-xs overflow-auto">{JSON.stringify(result, null, 2)}</pre>
          </div>
        </div>
      )}
    </div>
  );
}
