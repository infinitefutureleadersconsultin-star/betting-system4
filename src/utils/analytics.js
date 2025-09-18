// src/utils/analytics.js
// No imports needed — works with Vite out of the box.

export function logAnalysisEvent(type, payload) {
  try {
    const row = {
      ts: new Date().toISOString(),
      type,
      ...payload,
    };

    // 1) Persist to localStorage for calibration exports later
    const KEY = 'mbs_calibration_log';
    const existing = JSON.parse(localStorage.getItem(KEY) || '[]');
    existing.push(row);
    localStorage.setItem(KEY, JSON.stringify(existing));

    // 2) Send to a tiny serverless endpoint for centralized logs
    const body = JSON.stringify(row);
    if (typeof navigator !== 'undefined' && navigator.sendBeacon) {
      const blob = new Blob([body], { type: 'application/json' });
      navigator.sendBeacon('/api/analytics', blob);
    } else {
      // fallback for older browsers / SSR
      fetch('/api/analytics', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
        keepalive: true
      }).catch(() => {});
    }

    // 3) Optional: Vercel Analytics (only if their script is on the page)
    if (typeof window !== 'undefined' && window.va && typeof window.va.track === 'function') {
      window.va.track('analysis', row);
    }
  } catch (e) {
    // swallow — logging should never break the app
    // console.warn('logAnalysisEvent failed', e);
  }
}
