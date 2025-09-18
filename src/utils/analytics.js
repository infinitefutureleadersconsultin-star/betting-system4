// src/utils/analytics.js
let vercel;
try { vercel = await import('@vercel/analytics'); } catch { vercel = null; }
const va = vercel?.track ? vercel : { track: () => {} };

const logs = [];

export function logAnalysisEvent(kind, payload) {
  logs.push({ ts: new Date().toISOString(), kind, ...payload });
  try { va.track('analysis', { kind, ...payload }); } catch {}
}

export function downloadLogsCSV() {
  const cols = ['ts','kind','sport','player','opponent','prop','over','under','startTime','decision','suggestion','finalConfidence'];
  const header = cols.join(',');
  const rows = logs.map(r => cols.map(c => (r[c] ?? '')).join(','));
  const blob = new Blob([ [header, ...rows].join('\n') ], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = 'analysis-logs.csv'; a.click();
  URL.revokeObjectURL(url);
}
