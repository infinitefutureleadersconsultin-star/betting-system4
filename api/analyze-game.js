// api/analyze-game.js
import { GameLinesEngine } from "../lib/engines/gameLinesEngine.js";
import { SportsDataIOClient } from "../lib/apiClient.js";
import { runCors } from "./_cors.js";

function resolveSportsDataKey() {
  return (
    process.env.SPORTS_DATA_IO_KEY ||
    process.env.SPORTS_DATA_IO_API_KEY ||
    process.env.SPORTSDATAIO_KEY ||
    process.env.SDIO_KEY ||
    ""
  );
}

export default async function handler(req, res) {
  if (!runCors(req, res)) return;
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method Not Allowed" });
    return;
  }

  try {
    const b = typeof req.body === "object" && req.body ? req.body : {};
    const payload = {
      sport: b.sport || "",
      team: b.team || "",
      opponent: b.opponent || "",
      startTime: b.startTime || b.date || null,
    };

    const apiKey = resolveSportsDataKey();
    const sdio = new SportsDataIOClient({ apiKey });

    const engine = new GameLinesEngine(sdio);
    const result = await engine.evaluateGame(payload);

    console.log("[analyze-game] ok", {
      source: result?.meta?.dataSource,
      usedEndpoints: result?.meta?.usedEndpoints,
      decision: result?.decision,
      finalConfidence: result?.finalConfidence
    });

    res.status(200).json(result);
  } catch (err) {
    console.error("[analyze-game] error", err);
    res.status(500).json({ error: "Internal Server Error" });
  }
}
