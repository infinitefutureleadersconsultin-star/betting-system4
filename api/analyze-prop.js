// api/analyze-prop.js
import { PlayerPropsEngine } from "../lib/engines/playerPropsEngine.js";
import { SportsDataIOClient } from "../lib/apiClient.js";

// Minimal CORS (no dependency on local _cors.js)
function applyCors(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type,Authorization");
  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    res.end();
    return true;
  }
  return false;
}

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
  try {
    if (applyCors(req, res)) return;
    if (req.method !== "POST") {
      res.status(405).json({ error: "Method Not Allowed" });
      return;
    }

    const body = typeof req.body === "object" && req.body ? req.body : {};
    const payload = {
      sport: body.sport || "",
      player: body.player || "",
      opponent: body.opponent || "",
      prop: body.prop || "",
      odds: {
        over: Number(body?.odds?.over) || Number(body?.over) || NaN,
        under: Number(body?.odds?.under) || Number(body?.under) || NaN,
      },
      startTime: body.startTime || body.date || null,
      workload: body.workload ?? "AUTO",
      injuryNotes: body.injuryNotes ?? "UNKNOWN",
    };

    const apiKey = resolveSportsDataKey();
    const sdio = new SportsDataIOClient({ apiKey });

    console.log("[analyze-prop] using SportsDataIO", {
      hasKey: apiKey ? `yes(len=${apiKey.length})` : "no",
      baseURL: sdio.baseURL
    });

    const engine = new PlayerPropsEngine(sdio);
    const result = await engine.evaluateProp(payload);

    // normalize meta
    const source = typeof result?.meta?.dataSource === "string" ? result.meta.dataSource : (engine.dataSource || "fallback");
    const usedEndpoints = Array.isArray(result?.meta?.usedEndpoints)
      ? result.meta.usedEndpoints
      : (engine.usedEndpoints || []);
    const meta = {
      dataSource: source,
      usedEndpoints,
      matchedName: engine.matchedName || result?.meta?.matchedName || "",
      zeroFiltered: Number.isFinite(engine.zeroFiltered) ? engine.zeroFiltered : (result?.meta?.zeroFiltered ?? 0),
      recentCount: Number.isFinite(engine.recentValsCount) ? engine.recentValsCount : (result?.meta?.recentCount ?? 0),
      recentSample: Array.isArray(engine.recentSample) ? engine.recentSample : (result?.meta?.recentSample || []),
    };

    const response = {
      player: result.player,
      prop: result.prop,
      suggestion: result.suggestion,
      decision: result.decision,
      finalConfidence: result.finalConfidence,
      suggestedStake: result.suggestedStake,
      topDrivers: result.topDrivers,
      flags: result.flags,
      rawNumbers: result.rawNumbers,
      meta,
    };

    console.log("[analyze-prop] ok", {
      source: meta.dataSource,
      usedEndpoints: meta.usedEndpoints,
      decision: response.decision,
      finalConfidence: response.finalConfidence
    });

    res.status(200).json(response);
  } catch (err) {
    console.error("[analyze-prop] error", err);
    res.status(500).json({ error: "Internal Server Error" });
  }
}
