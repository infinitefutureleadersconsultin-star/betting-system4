// api/analyze-prop.js
import { PlayerPropsEngine } from "../lib/engines/playerPropsEngine.js";
import { SportsDataIOClient } from "../lib/apiClient.js";

// --- Minimal CORS so we don't depend on ./_cors.js ---
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

// debug helper — safe: logs only presence/length, not the key value
function debugShowKeyPresence() {
  const names = [
    "SPORTS_DATA_IO_KEY",
    "SPORTS_DATA_IO_API_KEY",
    "SPORTSDATAIO_KEY",
    "SDIO_KEY",
    "SPORTSDATA_API_KEY",
    "SPORTS_DATA_API_KEY",
    "SPORTS_DATA_KEY"
  ];
  const found = {};
  for (const n of names) {
    const v = process.env[n];
    if (v !== undefined) found[n] = `present(len=${String(v || "").length})`;
    else found[n] = "missing";
  }
  console.log("[KEY_DEBUG] SportsData env keys:", found);
}

// Resolve a SportsDataIO API key from common env names (trim whitespace)
function resolveSportsDataKey() {
  const candidates = [
    "SPORTS_DATA_IO_KEY",
    "SPORTS_DATA_IO_API_KEY",
    "SPORTSDATAIO_KEY",
    "SDIO_KEY",
    "SPORTSDATA_API_KEY",  // your var
    "SPORTS_DATA_API_KEY",
    "SPORTS_DATA_KEY",
  ];
  for (const name of candidates) {
    const v = process.env[name];
    if (v !== undefined && v !== null && String(v).trim() !== "") {
      return String(v).trim();
    }
  }
  return "";
}

export default async function handler(req, res) {
  try {
    if (applyCors(req, res)) return;
    if (req.method !== "POST") {
      res.status(405).json({ error: "Method Not Allowed" });
      return;
    }

    console.log("[analyze-prop] starting");
    debugShowKeyPresence();

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

    // Create a fresh client with the explicit key (from env resolver)
    const apiKey = resolveSportsDataKey();
    const sdio = new SportsDataIOClient({ apiKey });

    console.log("[analyze-prop] using SportsDataIO", {
      hasKey: apiKey ? `yes(len=${apiKey.length})` : "no",
      baseURL: sdio.baseURL
    });

    const engine = new PlayerPropsEngine(sdio);
    const result = await engine.evaluateProp(payload);

    // Normalize meta for the client
    const source = typeof result?.meta?.dataSource === "string"
      ? result.meta.dataSource
      : (engine.dataSource || "fallback");
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
      debug: {
        fallbackReason: (result?.meta?.debug?.fallbackReason) || (engine._fallbackReason || null),
        lastHttp: (sdio && sdio.lastHttp) ? sdio.lastHttp : null
      }
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
