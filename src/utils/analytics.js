// src/utils/analytics.js
export function logAnalysisEvent(kind, payload) {
  try {
    const key = 'mbs_logs';
    const arr = JSON.parse(localStorage.getItem(key) || '[]');
    arr.push({ kind, ...payload, ts: Date.now() });
    localStorage.setItem(key, JSON.stringify(arr));
  } catch (_) {}
}

export function downloadLogsCSV() {
  try {
    const key = 'mbs_logs';
    const arr = JSON.parse(localStorage.getItem(key) || '[]');
    const header = Object.keys(arr[0] || { kind: '', ts: '' });
    const rows = [header.join(',')].concat(
      arr.map(obj => header.map(h => JSON.stringify(obj[h] ?? '')).join(','))
    );
    const blob = new Blob([rows.join('\n')], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = 'analysis_logs.csv';
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
  } catch (_) {}
}
