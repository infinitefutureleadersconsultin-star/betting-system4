// api/analyze-game.js
import { GameLinesEngine } from "../lib/engines/gameLinesEngine.js";
import { SportsDataIOClient } from "../lib/apiClient.js";

function applyCors(req, res){
  res.setHeader("Access-Control-Allow-Origin","*");
  res.setHeader("Access-Control-Allow-Methods","POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers","Content-Type,Authorization");
  if (req.method==="OPTIONS"){ res.statusCode=204; res.end(); return true; }
  return false;
}

function resolveSportsDataKey(){
  return (
    process.env.SPORTS_DATA_IO_KEY ||
    process.env.SPORTS_DATA_IO_API_KEY ||
    process.env.SPORTSDATAIO_KEY ||
    process.env.SDIO_KEY ||
    ""
  );
}

export default async function handler(req, res){
  try{
    if (applyCors(req,res)) return;
    if (req.method!=="POST"){ res.status(405).json({error:"Method Not Allowed"}); return; }

    const body = typeof req.body==="object" && req.body ? req.body : {};
    const payload = {
      sport: body.sport || "",
      team: body.team || "",
      opponent: body.opponent || "",
      startTime: body.startTime || body.date || null
    };

    const apiKey = resolveSportsDataKey();
    const sdio = new SportsDataIOClient({ apiKey });

    console.log("[analyze-game] using SportsDataIO", { hasKey: apiKey ? `yes(len=${apiKey.length})` : "no", baseURL: sdio.baseURL });

    const engine = new GameLinesEngine(sdio);
    const result = await engine.evaluateGame(payload);

    const response = {
      ...result,
      meta: { ...result.meta, debug: { lastHttp: sdio.lastHttp || null } }
    };

    console.log("[analyze-game] ok", { source: response.meta.dataSource, usedEndpoints: response.meta.usedEndpoints, decision: response.decision, finalConfidence: response.finalConfidence, lastHttp: response.meta?.debug?.lastHttp || null });

    res.status(200).json(response);
  } catch (err){
    console.error("[analyze-game] error", err);
    res.status(500).json({ error: "Internal Server Error" });
  }
}
