// src/utils/analytics.js
// Self-contained analytics/calibration helpers (no external imports).
// Designed to be bundler-safe: no window/localStorage access at import time.

const KEY = 'mbs_calibration_log';

// Safe JSON.parse with fallback
function safeParse(str, fallback) {
  try { return JSON.parse(str); } catch { return fallback; }
}

// Get current calibration log (array)
export function getCalibrationLog() {
  try {
    if (typeof localStorage === 'undefined') return [];
    return safeParse(localStorage.getItem(KEY) || '[]', []);
  } catch {
    return [];
  }
}

// Clear the saved calibration log
export function clearCalibrationLog() {
  try {
    if (typeof localStorage === 'undefined') return;
    localStorage.removeItem(KEY);
  } catch {}
}

// Append a row (used by UI after each analysis)
export function logAnalysisEvent(type, payload) {
  try {
    const row = { ts: new Date().toISOString(), type, ...payload };

    // 1) Persist locally for calibration
    const current = getCalibrationLog();
    current.push(row);
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(KEY, JSON.stringify(current));
    }

    // 2) Ship to serverless (non-blocking)
    const body = JSON.stringify(row);
    if (typeof navigator !== 'undefined' && navigator.sendBeacon) {
      const blob = new Blob([body], { type: 'application/json' });
      navigator.sendBeacon('/api/analytics', blob);
    } else if (typeof fetch !== 'undefined') {
      fetch('/api/analytics', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
        keepalive: true,
      }).catch(() => {});
    }

    // 3) Optional Vercel Analytics (script tag variant). No import needed.
    if (typeof window !== 'undefined' && window.va && typeof window.va.track === 'function') {
      window.va.track('analysis', row);
    }
  } catch {
    // Never let logging break the app
  }
}

// --- CSV helpers (build-safe; only touch DOM when called) ---
function toCSVRow(obj, headers) {
  return headers.map((h) => {
    let v = obj[h];
    if (v == null) v = '';
    if (typeof v === 'object') v = JSON.stringify(v);
    v = String(v).replace(/"/g, '""');
    if (/[",\n]/.test(v)) v = `"${v}"`;
    return v;
  }).join(',');
}

// Download current log as CSV (what Header.jsx imports)
export function downloadLogsCSV(filename = 'mbs-calibration-log.csv') {
  const data = getCalibrationLog();
  if (!data.length) {
    // Nothing to download; silently return.
    return;
  }
  // Collect all keys across rows to make a consistent header
  const headers = Array.from(new Set(data.flatMap((r) => Object.keys(r))));
  const csv = [headers.join(','), ...data.map((r) => toCSVRow(r, headers))].join('\n');

  // If we don't have a browser environment, just return (build-safe)
  if (typeof window === 'undefined' || typeof document === 'undefined') return;

  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

// Optional: JSON export (not required by your build)
export function downloadLogsJSON(filename = 'mbs-calibration-log.json') {
  const data = getCalibrationLog();
  if (!data.length || typeof window === 'undefined' || typeof document === 'undefined') return;
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
