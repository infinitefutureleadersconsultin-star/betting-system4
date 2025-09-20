// api/health.js
export default function handler(req, res) {
  const time = new Date().toISOString();

  // --- DEBUG: log what env keys exist ---
  const names = [
    "SPORTS_DATA_IO_KEY",
    "SPORTS_DATA_IO_API_KEY",
    "SPORTSDATAIO_KEY",
    "SDIO_KEY",
    "SPORTSDATA_API_KEY",
    "SPORTS_DATA_API_KEY",
    "SPORTS_DATA_KEY"
  ];
  const seen = {};
  for (const n of names) {
    const v = process.env[n];
    seen[n] = v ? `present(len=${String(v).length})` : "missing";
  }

  console.log("[/api/health] ENV CHECK", seen);

  res.status(200).json({
    ok: true,
    time,
    env: seen
  });
}
