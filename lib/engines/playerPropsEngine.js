// lib/engines/playerPropsEngine.js
import { StatisticalModels } from "../statisticalModels.js";

export class PlayerPropsEngine {
  constructor(apiClient) {
    this.apiClient = apiClient;       // holds the SportsDataIO client
    this.errorFlags = [];
    this.dataSource = "fallback";     // "sportsdata" when live fetch succeeds
    this.thresholds = {
      LOCK_CONFIDENCE: 0.70,
      STRONG_LEAN: 0.675,
      LEAN: 0.65,
      HOOK_BUFFER: 0.05,
      VARIANCE_PENALTY: 0.05,
      NAME_INFLATION: 0.03,
    };
  }

  // ---------- public entry ----------
  async evaluateProp(input) {
    // tolerate missing inputs – never throw
    const body = {
      sport: (input?.sport || "").toUpperCase(),
      player: input?.player || "Unknown Player",
      opponent: input?.opponent || "",
      prop: input?.prop || "Prop 0.0",
      odds: {
        over: Number(input?.odds?.over) || 2.0,
        under: Number(input?.odds?.under) || 1.8,
      },
      startTime: input?.startTime || new Date(Date.now() + 6 * 3600e3).toISOString(),
      workload: input?.workload ?? "AUTO",
      injuryNotes: input?.injuryNotes ?? "UNKNOWN",
    };

    const features = await this.generateFeatures(body);
    const stat = this.calculateStatisticalProbability(features, body);
    const market = this.calculateMarketProbability(body.odds);
    const hookFlags = this.applyHouseAdjustments(stat.probability, body, features);

    // Base fusion (model + market). Sharp signal & last-minute adj kept 0 for now.
    let final = 0.60 * stat.probability
              + 0.20 * market.marketProbability
              + 0.12 * 0   // sharpSignal placeholder
              + 0.08 * 0;  // lastMinuteAdjust placeholder

    // Apply penalties/bonuses from adjustments (delta vs modelProb)
    final = Math.max(0, Math.min(1, final - (stat.probability - hookFlags.adjustedProb)));

    // Simple variance penalty
    if (features.stdDev > this.getVarianceThreshold(body.sport)) {
      final = Math.max(0, final - this.thresholds.VARIANCE_PENALTY);
    }

    // Decision
    let decision = "PASS";
    let stake = 0;
    const line = this.extractLineFromProp(body.prop);
    const isHook = (line % 1) === 0.5;

    // Require a tad more for hooks that look “trappy”
    let lockThreshold = this.thresholds.LOCK_CONFIDENCE;
    if (isHook && Math.abs(stat.expectedValue - line) < 0.3) {
      lockThreshold += this.thresholds.HOOK_BUFFER;
    }

    if (final >= lockThreshold) {
      decision = "LOCK";
      stake = final >= 0.75 ? 2.0 : 1.0;
    } else if (final >= this.thresholds.STRONG_LEAN) {
      decision = "STRONG_LEAN";
      stake = 0.5;
    } else if (final >= this.thresholds.LEAN) {
      decision = "LEAN";
      stake = 0.25;
    }

    const suggestion = stat.probability >= 0.5 ? "OVER" : "UNDER";

    return {
      player: body.player,
      prop: body.prop,
      suggestion,
      decision,
      finalConfidence: Math.round(final * 1000) / 10, // percent 0–100 with 0.1 precision
      suggestedStake: stake,
      topDrivers: [
        `Model vs Line: EV=${stat.expectedValue.toFixed(2)} vs line ${line}`,
        `Market (vig-free) over p=${market.marketProbability.toFixed(3)}`,
        `Variance stdDev=${features.stdDev.toFixed(2)} (source: ${this.dataSource})`,
      ],
      flags: hookFlags.flags,
      rawNumbers: {
        expectedValue: Math.round(stat.expectedValue * 100) / 100,
        stdDev: Math.round(features.stdDev * 100) / 100,
        modelProbability: Math.round(stat.probability * 1000) / 1000,
        marketProbability: Math.round(market.marketProbability * 1000) / 1000,
        sharpSignal: 0,
      },
      meta: { dataSource: this.dataSource },
    };
  }

  // ---------- hybrid data layer (SportsDataIO → fallback) ----------
  async generateFeatures(input) {
    const sport = (input.sport || "").toUpperCase();
    const features = {};
    this.dataSource = "fallback";

    const dateISO = input.startTime ? new Date(input.startTime) : new Date();
    const dateStr = dateISO.toISOString().slice(0, 10);

    try {
      if (this.apiClient && this.apiClient.apiKey) {
        let row = null;

        if (sport === "NBA") {
          const stats = await this.apiClient.getNBAPlayerStats(dateStr);
          if (Array.isArray(stats)) {
            row = stats.find(s =>
              (s?.Name || "").toLowerCase().includes((input.player || "").split(" ")[0].toLowerCase())
            );
          }
        } else if (sport === "WNBA") {
          // your earlier API returns season stats, no date arg
          const stats = await this.apiClient.getWNBAPlayerStats();
          if (Array.isArray(stats)) {
            row = stats.find(s =>
              (s?.Name || "").toLowerCase().includes((input.player || "").split(" ")[0].toLowerCase())
            );
          }
        } else if (sport === "MLB") {
          const stats = await this.apiClient.getMLBPlayerStats(dateStr);
          if (Array.isArray(stats)) {
            row = stats.find(s =>
              (s?.Name || "").toLowerCase().includes((input.player || "").split(" ")[0].toLowerCase())
            );
          }
        }
        // NFL path can be added similarly if you’re entering NFL props now

        if (row) {
          const statGuess = this.pickStatFromProp(input.prop, row);
          features.last60Avg = statGuess;
          features.last30Avg = statGuess;
          features.last7Avg  = statGuess;
          features.variance  = Math.max(0.5, Math.abs(statGuess - (statGuess * 0.9)));
          features.stdDev    = Math.sqrt(features.variance);
          features.matchupFactor = 1.0;
          features.minutesFactor = 1.0;
          features.specific = { adjustment: 0 };
          this.dataSource = "sportsdata";
          return features;
        }
      }

      // ----- Fallback synthetic features (keeps engine functional offline) -----
      const playerStats = await this.getPlayerHistoricalStats(input.player, sport);
      const opponentStats = await this.getOpponentDefensiveStats(input.opponent, sport);
      features.last60Avg = this.calculateExponentialAverage(playerStats.last60, 0.95);
      features.last30Avg = this.calculateExponentialAverage(playerStats.last30, 0.90);
      features.last7Avg  = this.calculateExponentialAverage(playerStats.last7, 0.85);
      features.variance  = this.calculateVariance(playerStats.recent);
      features.stdDev    = Math.sqrt(features.variance);
      features.matchupFactor = this.calculateMatchupFactor(opponentStats, sport, input.prop);
      features.minutesFactor = this.calculateMinutesFactor(input.workload, sport);
      features.specific = { adjustment: 0 };
      return features;

    } catch {
      // absolute safety net
      const playerStats = await this.getPlayerHistoricalStats(input.player, sport);
      features.last30Avg = this.calculateExponentialAverage(playerStats.last30, 0.90);
      features.last7Avg  = this.calculateExponentialAverage(playerStats.last7, 0.85);
      features.variance  = this.calculateVariance(playerStats.recent);
      features.stdDev    = Math.max(1, Math.sqrt(features.variance));
      features.matchupFactor = 1.0;
      features.minutesFactor = 1.0;
      features.specific = { adjustment: 0 };
      this.dataSource = "fallback";
      return features;
    }
  }

  pickStatFromProp(prop, row) {
    const p = (prop || "").toLowerCase();
    if (p.includes("assist"))     return Number(row.Assists) || 0;
    if (p.includes("rebound"))    return Number(row.Rebounds) || 0;
    if (p.includes("point"))      return Number(row.Points) || 0;
    if (p.includes("strikeout"))  return Number(row.StrikeoutsPitched) || 0;
    if (p.includes("passing"))    return Number(row.PassingYards) || 0;
    return 0;
  }

  // ---------- modeling ----------
  calculateStatisticalProbability(features, input) {
    const prop = input.prop || "";
    const line = this.extractLineFromProp(prop);
    let expectedValue = (features.last30Avg || 0) * (features.matchupFactor || 1) * (features.minutesFactor || 1);

    if (features?.specific?.adjustment) expectedValue += features.specific.adjustment;

    let probability;
    if (input.sport === "MLB" && prop.toLowerCase().includes("strikeout")) {
      probability = StatisticalModels.calculatePoissonProbability(Math.max(0.01, expectedValue), line);
    } else {
      const std = Math.max(0.5, Number(features.stdDev) || 1);
      probability = StatisticalModels.calculateNormalProbability(expectedValue, std, line);
    }
    return { probability, expectedValue };
  }

  calculateMarketProbability(odds) {
    const over = Number(odds?.over) || 2.0;
    const under = Number(odds?.under) || 1.8;
    const impliedOver = 1 / over;
    const impliedUnder = 1 / under;
    const denom = impliedOver + impliedUnder || 1;
    return {
      marketProbability: impliedOver / denom,
      vig: denom - 1,
    };
  }

  applyHouseAdjustments(modelProb, input, features) {
    let adjustedProb = modelProb;
    const flags = [];

    const stars = ["Judge", "Ohtani", "Mahomes", "Brady", "Ionescu", "Wilson", "Cloud"];
    if (stars.some(n => (input.player || "").includes(n))) {
      adjustedProb -= this.thresholds.NAME_INFLATION;
      flags.push("NAME_INFLATION");
    }

    const line = this.extractLineFromProp(input.prop || "");
    if ((line % 1) === 0.5) {
      flags.push("HOOK");
      if (Math.abs((features?.expectedValue ?? 0) - line) < 0.3) {
        adjustedProb -= this.thresholds.HOOK_BUFFER;
        flags.push("HOOK_TRAP");
      }
    }

    return { adjustedProb, flags };
  }

  // ---------- helpers ----------
  extractLineFromProp(prop) {
    const m = String(prop).match(/(\d+\.?\d*)/);
    return m ? parseFloat(m[1]) : 0;
  }

  calculateExponentialAverage(arr, decay) {
    const data = Array.isArray(arr) ? arr : [];
    if (!data.length) return 0;
    let ws = 0, tw = 0;
    for (let i = 0; i < data.length; i++) {
      const w = Math.pow(decay, i);
      ws += (Number(data[i]) || 0) * w;
      tw += w;
    }
    return ws / (tw || 1);
  }

  calculateVariance(arr) {
    const data = Array.isArray(arr) ? arr : [];
    if (!data.length) return 1;
    const mean = data.reduce((a,b) => a + (Number(b)||0), 0) / data.length;
    return data.reduce((acc, v) => acc + Math.pow((Number(v)||0) - mean, 2), 0) / data.length;
  }

  calculateMatchupFactor() { return 1.0; }
  calculateMinutesFactor() { return 1.0; }
  getVarianceThreshold(sport) {
    const t = { MLB: 1.0, NBA: 5.0, WNBA: 5.0, NFL: 15.0 };
    return t[sport] ?? 5.0;
  }

  // Fallback data (keeps engine usable without external APIs)
  async getPlayerHistoricalStats() {
    return {
      last60: Array.from({ length: 60 }, () => 5 + Math.random() * 10),
      last30: Array.from({ length: 30 }, () => 5 + Math.random() * 10),
      last7:  Array.from({ length: 7 },  () => 5 + Math.random() * 10),
      recent: Array.from({ length: 15 }, () => 5 + Math.random() * 10),
    };
  }
  async getOpponentDefensiveStats() {
    return { reboundRate: 0.5, assistRate: 0.5, strikeoutRate: 0.2 };
  }
}
