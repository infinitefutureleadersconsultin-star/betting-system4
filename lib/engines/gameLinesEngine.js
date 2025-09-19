// lib/engines/gameLinesEngine.js
// Simple, robust moneyline engine using SportsDataIO pregame odds.
// HouseFirst + Fusion: we lean on market (pregame odds) but apply small bounded nudges.
// Extend later for spreads/totals by parsing the odds payload similarly.

export class GameLinesEngine {
  constructor(apiClient) {
    this.apiClient = apiClient || null;

    this.usedEndpoints = [];
    this.dataSource = "fallback";
    this.matchInfo = null;

    this.thresholds = {
      LOCK_CONFIDENCE: 0.70,
      STRONG_LEAN: 0.675,
      LEAN: 0.65,
    };

    this.calibrationFactor = 1.0;
  }

  fmtLocalDate(d) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }

  _tokens(s) {
    return String(s || "").toLowerCase().split(/\s+/).filter(Boolean);
  }
  _teamMatches(tokens, nameOrCode) {
    const s = String(nameOrCode || "").toLowerCase();
    return tokens.some(t => s.includes(t));
  }

  _impliedProbFromMoneyline(ml) {
    const n = Number(ml);
    if (!Number.isFinite(n) || n === 0) return null;
    if (n > 0) return 100 / (n + 100);     // e.g. +120 -> 100/220 = 0.4545
    return Math.abs(n) / (Math.abs(n) + 100); // e.g. -150 -> 150/250 = 0.6
  }

  async _fetchOddsBySport(sport, dateStrOrWeek) {
    // returns array of odds objects or []
    try {
      if (!this.apiClient) return [];
      if (sport === "MLB" && this.apiClient.getMLBGameOdds) {
        const d = dateStrOrWeek;
        const r = await this.apiClient.getMLBGameOdds(d);
        this.usedEndpoints.push(`MLB:game-odds:${d}`);
        return Array.isArray(r) ? r : [];
      }
      if (sport === "NBA" && this.apiClient.getNBAGameOdds) {
        const d = dateStrOrWeek;
        const r = await this.apiClient.getNBAGameOdds(d);
        this.usedEndpoints.push(`NBA:game-odds:${d}`);
        return Array.isArray(r) ? r : [];
      }
      if (sport === "WNBA" && this.apiClient.getWNBAGameOdds) {
        const d = dateStrOrWeek;
        const r = await this.apiClient.getWNBAGameOdds(d);
        this.usedEndpoints.push(`WNBA:game-odds:${d}`);
        return Array.isArray(r) ? r : [];
      }
      if (sport === "NFL" && this.apiClient.getNFLGameOdds) {
        const w = dateStrOrWeek;
        const r = await this.apiClient.getNFLGameOdds(w);
        this.usedEndpoints.push(`NFL:game-odds:${w}`);
        return Array.isArray(r) ? r : [];
      }
      return [];
    } catch {
      return [];
    }
  }

  _inferNFLSeasonWeek(dateStr) {
    const d = new Date(dateStr);
    let season = d.getFullYear();
    const month = d.getMonth() + 1;
    if (month < 3) season = season - 1;
    const sep1 = new Date(season, 8, 1);
    const firstThu = new Date(sep1);
    while (firstThu.getDay() !== 4) firstThu.setDate(firstThu.getDate() + 1);
    const diffDays = Math.floor((d - firstThu) / 86400000);
    let week = Math.max(1, Math.min(22, Math.floor(diffDays / 7) + 1));
    return { season, week };
  }

  async evaluateGame(inputRaw) {
    const input = {
      sport: String(inputRaw?.sport || "NBA").toUpperCase(),
      team: inputRaw?.team || "",        // the side we care about (string)
      opponent: inputRaw?.opponent || "",
      startTime: inputRaw?.startTime || new Date().toISOString(),
      // optional: lineType: "ML" | "SPREAD" | "TOTAL" (we handle ML here)
    };

    // Build date selector
    let dateStr;
    try {
      const d = input?.startTime ? new Date(input.startTime) : new Date();
      if (!Number.isFinite(d.getTime())) throw new Error("bad date");
      dateStr = this.fmtLocalDate(d);
    } catch {
      dateStr = this.fmtLocalDate(new Date());
    }

    // Get odds list
    let oddsList = [];
    if (input.sport === "NFL") {
      const { week } = this._inferNFLSeasonWeek(dateStr);
      oddsList = await this._fetchOddsBySport("NFL", week);
      if (oddsList.length === 0) {
        // try nearby weeks just in case
        for (let wOff = -1; wOff >= -3 && oddsList.length === 0; wOff--) {
          const { week: w } = this._inferNFLSeasonWeek(dateStr);
          const tryW = Math.max(1, w + wOff);
          const tmp = await this._fetchOddsBySport("NFL", tryW);
          if (tmp.length) oddsList = tmp;
        }
      }
    } else {
      // try date, then date-1, then date+1
      const base = new Date(dateStr);
      const choices = [0, -1, 1].map(off => {
        const d = new Date(base);
        d.setDate(d.getDate() + off);
        return this.fmtLocalDate(d);
      });
      for (const ds of choices) {
        const tmp = await this._fetchOddsBySport(input.sport, ds);
        if (tmp.length) { oddsList = tmp; break; }
      }
    }

    // Match teams in odds
    const tTokens = this._tokens(input.team);
    const oTokens = this._tokens(input.opponent);

    let matched = null;
    for (const g of oddsList) {
      // SportsDataIO game odds entities differ per feed; try multiple keys
      const home = g?.HomeTeam ?? g?.HomeTeamName ?? g?.HomeTeamKey ?? g?.HomeTeamShort ?? "";
      const away = g?.AwayTeam ?? g?.AwayTeamName ?? g?.AwayTeamKey ?? g?.AwayTeamShort ?? "";

      const homeMatch = this._teamMatches(tTokens, home) || this._teamMatches(oTokens, home);
      const awayMatch = this._teamMatches(tTokens, away) || this._teamMatches(oTokens, away);

      if (homeMatch && awayMatch) {
        matched = g;
        break;
      }
    }

    if (!matched) {
      this.dataSource = "fallback";
      this.matchInfo = null;
      return this._formatResult({
        side: input.team,
        marketProb: 0.5,
        decision: "PASS",
        confidence: 50.0,
        reason: "No matching odds found",
      });
    }

    // Get a representative sportsbook's moneyline if present
    // Many feeds have an array of "PregameOdds"; choose the first with MLs
    let mlHome = null, mlAway = null, book = "unknown";
    const books = Array.isArray(matched?.PregameOdds) ? matched.PregameOdds : (Array.isArray(matched?.Odds) ? matched.Odds : null);
    if (Array.isArray(books)) {
      for (const b of books) {
        const h = Number(b?.HomeMoneyLine);
        const a = Number(b?.AwayMoneyLine);
        if (Number.isFinite(h) && Number.isFinite(a)) {
          mlHome = h; mlAway = a; book = b?.Sportsbook ?? b?.SportsbookDisplayName ?? "book";
          break;
        }
      }
    } else {
      // sometimes MLs are on the root
      mlHome = Number(matched?.HomeMoneyLine);
      mlAway = Number(matched?.AwayMoneyLine);
    }

    if (!Number.isFinite(mlHome) || !Number.isFinite(mlAway)) {
      this.dataSource = "sportsdata";
      this.matchInfo = { home: matched?.HomeTeam ?? "", away: matched?.AwayTeam ?? "", book };
      return this._formatResult({
        side: input.team,
        marketProb: 0.5,
        decision: "PASS",
        confidence: 50.0,
        reason: "No moneyline available",
      });
    }

    const pHome = this._impliedProbFromMoneyline(mlHome) ?? 0.5;
    const pAway = this._impliedProbFromMoneyline(mlAway) ?? 0.5;
    const norm = pHome + pAway;
    const mHome = norm > 0 ? pHome / norm : 0.5;
    const mAway = norm > 0 ? pAway / norm : 0.5;

    // Decide which side user cares about
    const userWantsHome = this._teamMatches(this._tokens(input.team), matched?.HomeTeam ?? matched?.HomeTeamName ?? "");
    const marketProb = userWantsHome ? mHome : mAway;

    // HouseFirst+Fusion: currently no proprietary model -> baseline 0.5
    const modelProb = 0.5;
    const fused = this._fuse(modelProb, marketProb, 0 /*sharp*/, 0 /*nudges*/);
    const finalConfidence = Math.round(fused * 1000) / 10;

    const decision =
      finalConfidence >= this.thresholds.LOCK_CONFIDENCE * 100 ? "LOCK" :
      finalConfidence >= this.thresholds.STRONG_LEAN * 100 ? "STRONG_LEAN" :
      finalConfidence >= this.thresholds.LEAN * 100 ? "LEAN" : "PASS";

    this.dataSource = "sportsdata";
    this.matchInfo = {
      home: matched?.HomeTeam ?? matched?.HomeTeamName ?? "",
      away: matched?.AwayTeam ?? matched?.AwayTeamName ?? "",
      book,
      mlHome,
      mlAway,
      marketHome: mHome,
      marketAway: mAway
    };

    return {
      side: input.team,
      suggestion: "MONEYLINE",
      decision,
      finalConfidence,
      rawNumbers: {
        marketProbability: Number(marketProb.toFixed(3)),
        modelProbability: Number(modelProb.toFixed(3)),
        fusedProbability: Number(fused.toFixed(3)),
      },
      meta: {
        dataSource: this.dataSource,
        usedEndpoints: this.usedEndpoints,
        matchInfo: this.matchInfo
      }
    };
  }

  _fuse(modelProb, marketProb, sharpSignal, addOnNudges) {
    // heavier weight on market for game lines
    const base = 0.25 * modelProb + 0.65 * marketProb + 0.10 * (0.5 + (Number(sharpSignal) || 0));
    const fused = Math.max(0, Math.min(1, base + addOnNudges));
    return fused * this.calibrationFactor;
  }

  _formatResult({ side, marketProb, decision, confidence, reason }) {
    return {
      side,
      suggestion: "MONEYLINE",
      decision,
      finalConfidence: confidence,
      rawNumbers: {
        marketProbability: Number((marketProb || 0.5).toFixed(3)),
        modelProbability: 0.5,
        fusedProbability: Number(((marketProb || 0.5)).toFixed(3)),
      },
      meta: {
        dataSource: this.dataSource,
        usedEndpoints: this.usedEndpoints,
        matchInfo: this.matchInfo,
        note: reason
      }
    };
  }
}
