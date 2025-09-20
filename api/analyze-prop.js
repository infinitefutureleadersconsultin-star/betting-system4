// api/analyze-prop.js
import { PlayerPropsEngine } from "../lib/engines/playerPropsEngine.js";
import { SportsDataIOClient } from "../lib/apiClient.js";

function applyCors(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type,Authorization");
  if (req.method === "OPTIONS") { res.statusCode = 204; res.end(); return true; }
  return false;
}
function resolveSportsDataKey() {
  return process.env.SPORTS_DATA_IO_KEY ||
         process.env.SPORTS_DATA_IO_API_KEY ||
         process.env.SPORTSDATAIO_KEY ||
         process.env.SDIO_KEY || "";
}

// one-shot probe to explain why we fell back
async function diagnoseWhyNoSportsData({ sdio, sport, dateStr, seasonYear }) {
  const diag = { reason: "UNKNOWN", last: sdio.getLastResponseMeta() || null };
  const hasKey = !!(sdio?.apiKey);
  if (!hasKey) { diag.reason = "NO_API_KEY"; return diag; }

  try {
    if (sport === "MLB") {
      const probe = await sdio.getMLBPlayerSeasonStats(seasonYear);
      const meta  = sdio.getLastResponseMeta();
      diag.last = meta;
      if (meta?.status === 401 || meta?.status === 403) diag.reason = "AUTH_DENIED";
      else if (Array.isArray(probe) && probe.length === 0) diag.reason = "EMPTY_SEASON_RESPONSE";
      else if (!Array.isArray(probe)) diag.reason = "BAD_SEASON_SHAPE";
      else diag.reason = "NO_MATCH_ON_BY_DATE_OR_NAME";
    } else if (sport === "NBA") {
      const probe = await sdio.getNBAPlayerSeasonStats(seasonYear);
      const meta  = sdio.getLastResponseMeta();
      diag.last = meta;
      if (meta?.status === 401 || meta?.status === 403) diag.reason = "AUTH_DENIED";
      else if (Array.isArray(probe) && probe.length === 0) diag.reason = "EMPTY_SEASON_RESPONSE";
      else diag.reason = "NO_MATCH_ON_BY_DATE_OR_NAME";
    } else if (sport === "WNBA") {
      const probe = await sdio.getWNBAPlayerSeasonStats(seasonYear);
      const meta  = sdio.getLastResponseMeta();
      diag.last = meta;
      if (meta?.status === 401 || meta?.status === 403) diag.reason = "AUTH_DENIED";
      else if (Array.isArray(probe) && probe.length === 0) diag.reason = "EMPTY_SEASON_RESPONSE";
      else diag.reason = "NO_MATCH_ON_BY_DATE_OR_NAME";
    } else if (sport === "NFL") {
      const probe = await sdio.getNFLPlayerSeasonStats(seasonYear);
      const meta  = sdio.getLastResponseMeta();
      diag.last = meta;
      if (meta?.status === 401 || meta?.status === 403) diag.reason = "AUTH_DENIED";
      else if (Array.isArray(probe) && probe.length === 0) diag.reason = "EMPTY_SEASON_RESPONSE";
      else diag.reason = "NO_MATCH_ON_BY_WEEK_OR_NAME";
    }
  } catch {
    const meta = sdio.getLastResponseMeta();
    diag.last = meta || { status: -1, reason: "NETWORK_ERROR" };
    diag.reason = "NETWORK_ERROR";
  }
  return diag;
}

export default async function handler(req, res) {
  try {
    if (applyCors(req, res)) return;
    if (req.method !== "POST") { res.status(405).json({ error: "Method Not Allowed" }); return; }

    const body = typeof req.body === "object" && req.body ? req.body : {};
    const payload = {
      sport: body.sport || "",
      player: body.player || "",
      opponent: body.opponent || "",
      prop: body.prop || "",
      odds: { over: Number(body?.odds?.over)||Number(body?.over)||NaN, under: Number(body?.odds?.under)||Number(body?.under)||NaN },
      startTime: body.startTime || body.date || null,
      workload: body.workload ?? "AUTO",
      injuryNotes: body.injuryNotes ?? "UNKNOWN",
    };

    const apiKey = resolveSportsDataKey();
    const sdio = new SportsDataIOClient({ apiKey });
    console.log("[analyze-prop] SportsDataIO", { hasKey: apiKey ? `yes(len=${apiKey.length})` : "no", baseURL: sdio.baseURL });

    const engine = new PlayerPropsEngine(sdio);
    const result = await engine.evaluateProp(payload);

    // Normalize meta (engine already carries these)
    const source = typeof result?.meta?.dataSource === "string" ? result.meta.dataSource : (engine.dataSource || "fallback");
    const usedEndpoints = Array.isArray(result?.meta?.usedEndpoints) ? result.meta.usedEndpoints : (engine.usedEndpoints || []);

    // If safety gates forced fallback, add deterministic diagnostics so you can fix env / plan / date.
    let debug = null;
    if (source !== "sportsdata" || usedEndpoints.length === 0) {
      // compute local date string + season for probe
      let dStr;
      try { const d = payload?.startTime ? new Date(payload.startTime) : new Date(); dStr = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; }
      catch { const d=new Date(); dStr = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; }
      const seasonYear = new Date(dStr).getFullYear();

      const diag = await diagnoseWhyNoSportsData({ sdio, sport: String(payload.sport||"").toUpperCase(), dateStr: dStr, seasonYear });
      debug = { fallbackReason: diag.reason, lastHttp: diag.last };
    }

    const response = {
      player: result.player,
      prop: result.prop,
      suggestion: result.suggestion,
      decision: result.decision,
      finalConfidence: result.finalConfidence,
      suggestedStake: result.suggestedStake,
      topDrivers: result.topDrivers,
      flags: [
        ...result.flags,
        ...(debug?.fallbackReason ? [`FALLBACK_REASON:${debug.fallbackReason}`] : [])
      ],
      rawNumbers: result.rawNumbers,
      meta: {
        dataSource: source,
        usedEndpoints,
        matchedName: engine.matchedName || result?.meta?.matchedName || "",
        zeroFiltered: Number.isFinite(engine.zeroFiltered) ? engine.zeroFiltered : (result?.meta?.zeroFiltered ?? 0),
        recentCount: Number.isFinite(engine.recentValsCount) ? engine.recentValsCount : (result?.meta?.recentCount ?? 0),
        recentSample: Array.isArray(engine.recentSample) ? engine.recentSample : (result?.meta?.recentSample || []),
        debug: debug || undefined
      },
    };

    console.log("[analyze-prop] ok", {
      source: response.meta.dataSource,
      usedEndpoints: response.meta.usedEndpoints,
      decision: response.decision,
      finalConfidence: response.finalConfidence,
      fallbackReason: response.meta.debug?.fallbackReason || null,
      lastHttp: response.meta.debug?.lastHttp || null
    });

    res.status(200).json(response);
  } catch (err) {
    console.error("[analyze-prop] error", err);
    res.status(500).json({ error: "Internal Server Error" });
  }
}
