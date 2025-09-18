// api/analyze-prop.js
import { runCors } from "./_utils/_cors.js";
import { APIClient } from "../lib/apiClient.js";
import { PlayerPropsEngine } from "../lib/engines/playerPropsEngine.js";

const apiClient = new APIClient(process.env.SPORTSDATA_API_KEY || "");
const engine = new PlayerPropsEngine(apiClient);

export default async function handler(req, res) {
  try {
    await runCors(req, res);
    if (req.method === "OPTIONS") return res.status(200).end();
    if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

    // Parse body safely
    const raw = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
    // Normalize odds to numbers (fallbacks so we never get NaN)
    const body = {
      ...raw,
      odds: {
        over: Number(raw?.odds?.over) || 2.0,
        under: Number(raw?.odds?.under) || 1.8
      },
      startTime: raw?.startTime || new Date(Date.now() + 6 * 3600e3).toISOString() // +6h default
    };

    const result = await engine.evaluateProp(body);

    // Hard guarantee that UI fields exist (no undefined/NaN)
    const safe = (n, d = 0) => (Number.isFinite(n) ? n : d);
    const response = {
      player: result.player || body.player || "Unknown Player",
      prop: result.prop || body.prop || "Prop",
      suggestion: result.suggestion || (safe(result.rawNumbers?.modelProbability, 0.5) >= 0.5 ? "OVER" : "UNDER"),
      decision: result.decision || "PASS",
      finalConfidence: safe(result.finalConfidence, 0), // percent number like 68.7
      suggestedStake: safe(result.suggestedStake, 0),
      topDrivers: Array.isArray(result.topDrivers) ? result.topDrivers : [],
      flags: Array.isArray(result.flags) ? result.flags : [],
      rawNumbers: {
        expectedValue: safe(result?.rawNumbers?.expectedValue, 0),
        stdDev: safe(result?.rawNumbers?.stdDev, 1),
        modelProbability: safe(result?.rawNumbers?.modelProbability, 0.5),
        marketProbability: safe(result?.rawNumbers?.marketProbability, 0.5),
        sharpSignal: safe(result?.rawNumbers?.sharpSignal, 0)
      }
    };

    return res.status(200).json(response);
  } catch (err) {
    console.error("analyze-prop fatal", err);
    return res.status(500).json({
      error: "Internal server error",
      message: process.env.NODE_ENV === "development" ? err.message : "Something went wrong"
    });
  }
}
