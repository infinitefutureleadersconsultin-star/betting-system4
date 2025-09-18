import { track } from '@vercel/analytics';

const LS_KEY = 'mbs_logs_v1';

function toFlat(obj) {
  // remove big nested blobs; keep only useful fields for CSV
  const keep = {};
  for (const [k,v] of Object.entries(obj || {})) {
    if (v == null) continue;
    if (typeof v === 'object') continue;
    keep[k] = v;
  }
  return keep;
}

export function logAnalysisEvent(type, payload = {}) {
  try {
    // Send a compact event to Vercel Analytics
    track(`mbs_${type}`, toFlat(payload));
  } catch {}

  try {
    // Also store locally for CSV export
    const logs = JSON.parse(localStorage.getItem(LS_KEY) || '[]');
    logs.push({ ts: new Date().toISOString(), type, ...toFlat(payload) });
    // keep last 2000 entries
    while (logs.length > 2000) logs.shift();
    localStorage.setItem(LS_KEY, JSON.stringify(logs));
  } catch {}
}

export function downloadLogsCSV() {
  try {
    const logs = JSON.parse(localStorage.getItem(LS_KEY) || '[]');
    if (!logs.length) return alert('No logs yet.');
    const headers = Array.from(new Set(logs.flatMap(o => Object.keys(o))));
    const lines = [
      headers.join(',')
    ];
    for (const row of logs) {
      lines.push(headers.map(h => JSON.stringify(row[h] ?? '')).join(','));
    }
    const blob = new Blob([lines.join('\n')], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = 'mbs-logs.csv';
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  } catch (e) {
    alert('Failed to export CSV');
  }
}
