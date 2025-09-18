// api/analytics.js
// Minimal same-origin logger for calibration. No CORS needed.

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    console.log('[CALIBRATION]', body); // View in Vercel > Deployment > Functions > Logs
    return res.status(204).end();
  } catch (e) {
    return res.status(400).json({ error: 'Bad JSON' });
  }
}
