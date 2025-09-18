// src/utils/analytics.js
// Self-contained logger: no package imports needed.

export function logAnalysisEvent(type, payload) {
  try {
    const row = { ts: new Date().toISOString(), type, ...payload };

    // 1) Save locally for calibration/export
    const KEY = 'mbs_calibration_log';
    const prev = JSON.parse(localStorage.getItem(KEY) || '[]');
    prev.push(row);
    localStorage.setItem(KEY, JSON.stringify(prev));

    // 2) Send to our serverless endpoint (non-blocking)
    const body = JSON.stringify(row);
    if (typeof navigator !== 'undefined' && navigator.sendBeacon) {
      const blob = new Blob([body], { type: 'application/json' });
      navigator.sendBeacon('/api/analytics', blob);
    } else {
      fetch('/api/analytics', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
        keepalive: true,
      }).catch(() => {});
    }

    // 3) Optional: if you later add Vercel’s script tag, this will fire too.
    if (typeof window !== 'undefined' && window.va && typeof window.va.track === 'function') {
      window.va.track('analysis', row);
    }
  } catch {
    // Never let logging break the app
  }
}
