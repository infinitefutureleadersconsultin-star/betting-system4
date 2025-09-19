// api/analyze-game.js
import { GameLinesEngine } from "../lib/engines/gameLinesEngine.js";
import { APIClient } from "../lib/apiClient.js";
import runCors from "./_cors.js";

export default async function handler(req, res) {
  const proceed = await runCors(req, res);
  if (proceed === false) return;

  try {
    let body = req.body;
    if (typeof body === "string") {
      try { body = JSON.parse(body); } catch {}
    }

    console.log("[analyze-game] start", { path: req.url });

    const client = new APIClient(process.env.SPORTSDATA_API_KEY || "");
    const engine = new GameLinesEngine(client);
    const result = await engine.evaluate(body || {});

    console.log("[analyze-game] ok", {
      source: result?.meta?.dataSource || "fallback",
      usedEndpoints: result?.meta?.usedEndpoints || [],
      decision: result.decision,
      finalConfidence: result.finalConfidence
    });

    return res.status(200).json(result);
  } catch (err) {
    console.error("[analyze-game] fatal", err?.stack || err?.message || err);
    return res.status(500).json({ error: "Internal server error", details: String(err?.message || err) });
  }
}
