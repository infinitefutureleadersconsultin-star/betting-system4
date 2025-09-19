// api/analyze-prop.js
import { PlayerPropsEngine } from "../lib/engines/playerPropsEngine.js";
import { APIClient } from "../lib/apiClient.js";
import runCors from "./_cors.js";

export default async function handler(req, res) {
  const proceed = await runCors(req, res);
  if (proceed === false) return; // OPTIONS preflight handled

  try {
    let body = req.body;
    if (typeof body === "string") {
      try { body = JSON.parse(body); } catch {}
    }

    console.log("[analyze-prop] start", { path: req.url });

    const client = new APIClient(process.env.SPORTSDATA_API_KEY || "");
    const engine = new PlayerPropsEngine(client);
    const response = await engine.evaluateProp(body || {});

    const source = typeof response?.meta?.dataSource === "string" ? response.meta.dataSource : "fallback";
    const meta = {
      dataSource: source,
      usedEndpoints: Array.isArray(response?.meta?.usedEndpoints) ? response.meta.usedEndpoints : [],
      matchedName: response?.meta?.matchedName || "",
      zeroFiltered: Number(response?.meta?.zeroFiltered) || 0,
      recentCount: Number(response?.meta?.recentCount) || 0,
      recentSample: Array.isArray(response?.meta?.recentSample) ? response.meta.recentSample : []
    };

    console.log("[analyze-prop] ok", {
      source: meta.dataSource,
      usedEndpoints: meta.usedEndpoints,
      decision: response.decision,
      finalConfidence: response.finalConfidence
    });

    return res.status(200).json({ ...response, meta });
  } catch (err) {
    console.error("[analyze-prop] fatal", err?.stack || err?.message || err);
    return res.status(500).json({ error: "Internal server error", details: String(err?.message || err) });
  }
}
