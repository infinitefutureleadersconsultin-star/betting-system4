// api/analyze-prop.js
import { runCors } from "./_cors.js";
import { APIClient } from "../lib/apiClient.js";
import { PlayerPropsEngine } from "../lib/engines/playerPropsEngine.js";

export default async function handler(req, res) {
  const proceed = await runCors(req, res);
  if (proceed === false) return;

  try {
    console.log("[analyze-prop] start", { path: req.url });

    let body = req.body;
    try { if (typeof body === "string") body = JSON.parse(body); } catch {}

    const client = new APIClient(process.env.SPORTSDATA_API_KEY || process.env.SPORTSDATAIO_API_KEY || "");
    const engine = new PlayerPropsEngine(client);

    const result = await engine.evaluateProp(body || {});
    const source = typeof result?.meta?.dataSource === "string" ? result.meta.dataSource : "fallback";
    const meta = {
      dataSource: source,
      usedEndpoints: Array.isArray(result?.meta?.usedEndpoints) ? result.meta.usedEndpoints : [],
      matchedName: result?.meta?.matchedName || "",
      zeroFiltered: result?.meta?.zeroFiltered ?? 0,
      recentCount: result?.meta?.recentCount ?? 0,
      recentSample: Array.isArray(result?.meta?.recentSample) ? result.meta.recentSample : []
    };

    console.log("[analyze-prop] ok", {
      source: meta.dataSource,
      usedEndpoints: meta.usedEndpoints,
      decision: result.decision,
      finalConfidence: result.finalConfidence
    });

    return res.status(200).json({ ...result, meta });
  } catch (err) {
    console.error("[analyze-prop] fatal", err?.stack || err?.message || err);
    return res.status(500).json({ error: "Internal server error", details: String(err?.message || err) });
  }
}
