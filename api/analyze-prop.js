// api/analyze-prop.js
import { PlayerPropsEngine } from "../lib/engines/playerPropsEngine.js";
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
      player: b.player || "",
      opponent: b.opponent || "",
      prop: b.prop || "",
      odds: {
        over: Number(b?.odds?.over ?? b?.over ?? NaN),
        under: Number(b?.odds?.under ?? b?.under ?? NaN),
      },
      startTime: b.startTime || b.date || null,
      workload: b.workload ?? "AUTO",
      injuryNotes: b.injuryNotes ?? "UNKNOWN",
    };

    const apiKey = resolveSportsDataKey();
    const sdio = new SportsDataIOClient({ apiKey });

    const engine = new PlayerPropsEngine(sdio);
    const result = await engine.evaluateProp(payload);

    const meta = {
      dataSource: result?.meta?.dataSource ?? engine.dataSource,
      usedEndpoints: result?.meta?.usedEndpoints ?? engine.usedEndpoints,
      matchedName: result?.meta?.matchedName ?? engine.matchedName ?? "",
      zeroFiltered: result?.meta?.zeroFiltered ?? engine.zeroFiltered ?? 0,
      recentCount: result?.meta?.recentCount ?? engine.recentValsCount ?? 0,
      recentSample: result?.meta?.recentSample ?? engine.recentSample ?? [],
      debug: result?.meta?.debug ?? engine.debug ?? null,
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
      finalConfidence: response.finalConfidence,
      fallbackReason: meta?.debug?.fallbackReason ?? null,
    });

    res.status(200).json(response);
  } catch (err) {
    console.error("[analyze-prop] error", err);
    res.status(500).json({ error: "Internal Server Error" });
  }
}
