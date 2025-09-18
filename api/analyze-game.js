// api/analyze-game.js
import { runCors } from "./_cors.js";
import { APIClient } from "../lib/apiClient.js";
import { GameLinesEngine } from "../lib/engines/gameLinesEngine.js";

// Pass your key if set; fall back to empty so engine can still run with defaults
const apiClient = new APIClient(process.env.SPORTSDATA_API_KEY || "");
const engine = new GameLinesEngine(apiClient);

export default async function handler(req, res) {
  try {
    await runCors(req, res);
    if (req.method === "OPTIONS") return res.status(200).end();
    if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

    const bodyRaw = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
    // minimal sanitizing / defaults so UI never breaks
    const body = {
      sport: bodyRaw.sport || "NBA",
      home: bodyRaw.home || "HOME",
      away: bodyRaw.away || "AWAY",
      line: bodyRaw.line ?? "",
      startTime: bodyRaw.startTime || new Date(Date.now() + 6 * 3600e3).toISOString(),
      odds: {
        home: Number(bodyRaw?.odds?.home) || 1.95,
        away: Number(bodyRaw?.odds?.away) || 1.85,
      },
      venue: bodyRaw.venue || "",
    };

    const result = await engine.evaluateGameLine(body); // <-- await (engine method is async)

    // Harden response so UI always has the fields it expects
    const confidenceNum = Number.isFinite(result?.confidence) ? result.confidence : 0;
    const response = {
      game: result?.game || `${body.home} vs ${body.away}`,
      line: result?.line ?? body.line ?? "",
      suggestion: result?.suggestion || body.home,           // team name string
      recommendation: result?.recommendation || "PASS",      // "BET" | "PASS"
      confidence: confidenceNum,                              // number like 62.3
    };

    return res.status(200).json(response);
  } catch (e) {
    console.error("analyze-game error", e);
    return res.status(500).json({ error: "Internal server error" });
  }
}
