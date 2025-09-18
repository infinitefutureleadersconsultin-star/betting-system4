// api/analyze-batch.js
import { runCors } from "./_cors.js";
import { APIClient } from "../lib/apiClient.js";
import { PlayerPropsEngine } from "../lib/engines/playerPropsEngine.js";
import { GameLinesEngine } from "../lib/engines/gameLinesEngine.js";

const apiClient   = new APIClient(process.env.SPORTSDATA_API_KEY || "");
const propsEngine = new PlayerPropsEngine(apiClient);
const gameEngine  = new GameLinesEngine(apiClient);

export default async function handler(req, res) {
  try {
    await runCors(req, res);
    if (req.method === "OPTIONS") return res.status(200).end();
    if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

    const raw = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
    const { props = [], games = [] } = raw;

    // Run both lists safely; do not explode the whole batch if one fails
    const propSettled = await Promise.allSettled(props.map(p => propsEngine.evaluateProp(p)));
    const gameSettled = await Promise.allSettled(games.map(g => gameEngine.evaluateGameLine(g)));

    const propResults = propSettled
      .map(r => r.status === "fulfilled" ? r.value : { decision: "ERROR", message: "Prop analysis failed" });

    const gameResults = gameSettled
      .map(r => r.status === "fulfilled" ? r.value : { recommendation: "PASS", confidence: 0, message: "Game analysis failed" });

    return res.status(200).json({
      props: propResults,
      games: gameResults,
      summary: {
        totalProps: propResults.length,
        propsToLock: propResults.filter(p => p.decision === "LOCK").length,
        totalGames: gameResults.length,
        gamesToBet: gameResults.filter(g => g.recommendation === "BET").length,
      },
      errors: {
        propErrors: propSettled.filter(r => r.status === "rejected").length,
        gameErrors: gameSettled.filter(r => r.status === "rejected").length,
      },
    });
  } catch (e) {
    console.error("analyze-batch error", e);
    return res.status(500).json({ error: "Internal server error" });
  }
}
