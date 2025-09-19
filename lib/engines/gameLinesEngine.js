// lib/engines/gameLinesEngine.js
const SMART = String(process.env.SMART_OVERLAYS || "").toUpperCase() === "ON";

export class GameLinesEngine {
  constructor(apiClient) {
    this.apiClient = apiClient || null;
    this.usedEndpoints = [];
    this.dataSource = "fallback";
  }

  fmtLocalDate(d) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
  }

  async evaluate(inputRaw) {
    const input = {
      sport: String(inputRaw?.sport || "").toUpperCase(), // MLB|NBA|WNBA|NFL
      homeTeam: inputRaw?.homeTeam || "",
      awayTeam: inputRaw?.awayTeam || "",
      market: inputRaw?.market || "SPREAD", // SPREAD | TOTAL | ML
      side: inputRaw?.side || "", // e.g., HOME, AWAY, OVER, UNDER
      startTime: inputRaw?.startTime || new Date().toISOString()
    };

    let dateStr;
    try {
      const d = new Date(input.startTime);
      if (!Number.isFinite(d.getTime())) throw new Error();
      dateStr = this.fmtLocalDate(d);
    } catch { dateStr = this.fmtLocalDate(new Date()); }

    // 1) pull market odds from SportsDataIO
    const market = await this.fetchMarketOdds(input, dateStr);

    // if we didn’t find the game, safe fallback
    if (!market.found) {
      return {
        decision: "PASS",
        finalConfidence: 50.0,
        suggestion: "NO_BET",
        lines: {},
        topDrivers: ["No matching game odds found"],
        flags: ["NO_MARKET"],
        rawNumbers: { modelProbability: 0.5, marketProbability: 0.5, edge: 0 },
        meta: { dataSource: this.dataSource, usedEndpoints: this.usedEndpoints }
      };
    }

    // 2) very simple model baseline (placeholder)
    const model = this.buildModelEstimate(input, market);

    // 3) fuse (HouseFirst + Fusion)
    const fused = this.fuse(model.modelProbability, market.marketProbability, 0, 0);

    // 4) decisioning
    const finalConfidence = Math.round(fused * 1000) / 10;
    let decision = "PASS";
    if (finalConfidence >= 70) decision = "LOCK";
    else if (finalConfidence >= 67.5) decision = "STRONG_LEAN";
    else if (finalConfidence >= 65) decision = "LEAN";

    const topDrivers = [
      `Model p=${model.modelProbability.toFixed(3)}, Market p=${market.marketProbability.toFixed(3)}`,
      `Line=${market.line != null ? String(market.line) : "N/A"}`
    ];

    this.dataSource = market.dataSource;
    return {
      decision,
      finalConfidence,
      suggestion: model.suggestion || "NO_BET",
      lines: market.lines || {},
      topDrivers,
      flags: market.flags || [],
      rawNumbers: {
        modelProbability: round3(model.modelProbability),
        marketProbability: round3(market.marketProbability),
        edge: round3(model.modelProbability - market.marketProbability),
      },
      meta: { dataSource: this.dataSource, usedEndpoints: this.usedEndpoints }
    };
  }

  // --- Market pulls by league ---
  async fetchMarketOdds(input, dateStr) {
    const sport = input.sport;
    let rows = null;
    if (!this.apiClient) return { found: false, marketProbability: 0.5, dataSource: "fallback" };

    if (sport === "MLB") {
      rows = await this.apiClient.getMLBGameOdds(dateStr);
      this.usedEndpoints.push(`MLB:game-odds:${dateStr}`);
    } else if (sport === "NBA") {
      rows = await this.apiClient.getNBAGameOdds(dateStr);
      this.usedEndpoints.push(`NBA:game-odds:${dateStr}`);
    } else if (sport === "WNBA") {
      rows = await this.apiClient.getWNBAGameOdds(dateStr);
      this.usedEndpoints.push(`WNBA:game-odds:${dateStr}`);
    } else if (sport === "NFL") {
      // NFL: pull by current week (best effort)
      const wk = await this.apiClient.getNFLCurrentWeek();
      if (typeof wk === "number") {
        rows = await this.apiClient.getNFLGameOdds(wk);
        this.usedEndpoints.push(`NFL:game-odds:week-${wk}`);
      }
    }

    if (!Array.isArray(rows) || rows.length === 0) {
      return { found: false, marketProbability: 0.5, dataSource: "sportsdata" };
    }

    // naive match (you can refine with team IDs later)
    const homeLC = String(input.homeTeam || "").toLowerCase();
    const awayLC = String(input.awayTeam || "").toLowerCase();

    const game = rows.find(g => {
      const hlc = String(g?.HomeTeam || g?.HomeTeamName || "").toLowerCase();
      const alc = String(g?.AwayTeam || g?.AwayTeamName || "").toLowerCase();
      return (!homeLC || hlc.includes(homeLC)) && (!awayLC || alc.includes(awayLC));
    }) || rows[0];

    const markets = Array.isArray(game?.PregameOdds) ? game.PregameOdds : [];
    const best = markets[0] || {};

    // derive probabilities
    const lines = {
      spread: Number(best?.Spread) ?? null,
      total: Number(best?.OverUnder) ?? null,
      moneylineHome: Number(best?.HomeMoneyLine) ?? null,
      moneylineAway: Number(best?.AwayMoneyLine) ?? null
    };

    let marketProbability = 0.5;
    let line = null;
    let flags = [];

    if (input.market === "SPREAD") {
      line = lines.spread;
      // map to probability via simple transform (placeholder)
      marketProbability = 0.5; // market-neutral base; can be enhanced with price
    } else if (input.market === "TOTAL") {
      line = lines.total;
      marketProbability = 0.5;
    } else if (input.market === "ML") {
      // convert moneyline to probability if the selected side is given
      const side = String(input.side || "").toUpperCase(); // HOME|AWAY
      const price = side === "HOME" ? lines.moneylineHome : lines.moneylineAway;
      if (Number.isFinite(price) && price !== 0) {
        // american -> prob
        const p = price > 0 ? 100 / (price + 100) : -price / (-price + 100);
        marketProbability = clamp01(p);
      }
    }

    return {
      found: true,
      marketProbability,
      line,
      lines,
      flags,
      dataSource: "sportsdata"
    };
  }

  // --- Simple model (placeholder) ---
  buildModelEstimate(input, market) {
    // Start neutral and let overlays calibrate; you can replace with your rating model later.
    const modelProbability = clamp01(market.marketProbability); // same as market for now
    const suggestion = this.suggestFromMarket(input, market);
    return { modelProbability, suggestion };
  }

  suggestFromMarket(input, market) {
    const m = String(input.market || "SPREAD").toUpperCase();
    if (m === "TOTAL") return input.side?.toUpperCase() === "UNDER" ? "UNDER" : "OVER";
    if (m === "ML") return input.side?.toUpperCase() === "AWAY" ? "AWAY" : "HOME";
    // spread: choose the side provided, else HOME
    return input.side?.toUpperCase() || "HOME";
  }

  // --- Fusion (same as props) ---
  fuse(modelProb, marketProb, sharpSignal, addOnNudges) {
    const base =
      0.60 * modelProb +
      0.20 * marketProb +
      0.12 * (0.5 + (Number(sharpSignal) || 0)) +
      0.08 * 0.5;

    let fused = base + addOnNudges;
    return clamp01(fused);
  }
}

// helpers
function clamp01(x) { return Math.max(0, Math.min(1, Number.isFinite(x) ? x : 0)); }
function round3(x) { return Math.round((Number(x) || 0) * 1000) / 1000; }
