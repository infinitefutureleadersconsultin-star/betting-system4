// lib/engines/playerPropsEngine.js
import { StatisticalModels } from "../statisticalModels.js";

export class PlayerPropsEngine {
  constructor(apiClient) {
    this.apiClient = apiClient; // may be empty; we fallback gracefully
    this.errorFlags = [];
    this.dataSource = "fallback";
    this.thresholds = {
      LOCK_CONFIDENCE: 0.70,
      STRONG_LEAN: 0.675,
      LEAN: 0.65,
      HOOK_BUFFER: 0.05,
      VARIANCE_PENALTY: 0.05,
      NAME_INFLATION: 0.03,
    };
  }

  validateInput(input) {
    this.errorFlags = [];
    const required = ["sport", "player", "prop", "odds", "startTime"];
    for (const field of required) {
      if (!input || input[field] === undefined || input[field] === "") {
        this.errorFlags.push(`MISSING_${field.toUpperCase()}`);
      }
    }
    return this.errorFlags.length === 0;
  }

  extractLineFromProp(prop) {
    const m = String(prop || "").match(/(\d+(\.\d+)?)/);
    return m ? parseFloat(m[1]) : 0;
  }

  calculateExponentialAverage(arr, decay) {
    if (!Array.isArray(arr) || arr.length === 0) return 0;
    let ws = 0, tw = 0;
    for (let i = 0; i < arr.length; i++) {
      const w = Math.pow(decay, i);
      ws += (Number(arr[i]) || 0) * w;
      tw += w;
    }
    return tw > 0 ? ws / tw : 0;
  }

  calculateVariance(arr) {
    if (!Array.isArray(arr) || arr.length === 0) return 1;
    const nums = arr.map(x => Number(x) || 0);
    const mean = nums.reduce((a, b) => a + b, 0) / nums.length;
    const v = nums.reduce((a, x) => a + (x - mean) ** 2, 0) / nums.length;
    return Math.max(0.25, v);
  }

  calculateMatchupFactor() { return 1.0; }
  calculateMinutesFactor(workload) { return workload && Number(workload) > 0 ? 1.0 : 1.0; }

  async getPlayerHistoricalStats() {
    // Fallback synthetic history
    return {
      last60: Array.from({ length: 60 }, () => 5 + Math.random() * 6),
      last30: Array.from({ length: 30 }, () => 5 + Math.random() * 6),
      last7:  Array.from({ length: 7 },  () => 5 + Math.random() * 6),
      recent: Array.from({ length: 15 }, () => 5 + Math.random() * 6),
    };
  }

  async getOpponentDefensiveStats() {
    return { reboundRate: 0.5, assistRate: 0.5, strikeoutRate: 0.2 };
  }

  pickStatFromProp(prop, row) {
    const p = String(prop || "").toLowerCase();
    if (p.includes("assist"))     return Number(row.Assists) || 0;
    if (p.includes("rebound"))    return Number(row.Rebounds) || 0;
    if (p.includes("point"))      return Number(row.Points) || 0;
    if (p.includes("strikeout"))  return Number(row.StrikeoutsPitched) || 0;
    if (p.includes("passing"))    return Number(row.PassingYards) || 0;
    return 0;
  }

  async generateFeatures(input) {
    const sport = String(input?.sport || "").toUpperCase();
    const features = {};
    this.dataSource = "fallback";

    // YYYY-MM-DD from startTime or today
    const dateISO = input?.startTime ? new Date(input.startTime) : new Date();
    const dateStr = dateISO.toISOString().slice(0, 10);

    try {
      if (this.apiClient && this.apiClient.apiKey) {
        let row = null;
        if (sport === "NBA") {
          const stats = await this.apiClient.getNBAPlayerStats(dateStr);
          if (Array.isArray(stats)) {
            row = stats.find(s => String(s?.Name || "").toLowerCase().includes(String(input.player || "").split(" ")[0].toLowerCase()));
          }
        } else if (sport === "WNBA") {
          const stats = await this.apiClient.getWNBAPlayerStats(dateStr);
          if (Array.isArray(stats)) {
            row = stats.find(s => String(s?.Name || "").toLowerCase().includes(String(input.player || "").split(" ")[0].toLowerCase()));
          }
        } else if (sport === "MLB") {
          const stats = await this.apiClient.getMLBPlayerStats(dateStr);
          if (Array.isArray(stats)) {
            row = stats.find(s => String(s?.Name || "").toLowerCase().includes(String(input.player || "").split(" ")[0].toLowerCase()));
          }
        }
        if (row) {
          const statGuess = this.pickStatFromProp(input.prop, row);
          features.last60Avg = statGuess;
          features.last30Avg = statGuess;
          features.last7Avg  = statGuess;
          features.variance  = Math.max(0.5, Math.abs(statGuess - statGuess * 0.9));
          features.stdDev    = Math.sqrt(features.variance);
          features.matchupFactor = 1.0;
          features.minutesFactor = 1.0;
          features.specific = { adjustment: 0 };
          this.dataSource = "sportsdata";
          return features;
        }
      }

      // Fallback
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
      // safety valve
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

  calculateStatisticalProbability(features, input) {
    const line = this.extractLineFromProp(input.prop);
    let mu = (Number(features.last30Avg) || 0) * (Number(features.matchupFactor) || 1) * (Number(features.minutesFactor) || 1);
    if (features?.specific?.adjustment) mu += Number(features.specific.adjustment) || 0;
    const sigma = Math.max(0.8, Number(features.stdDev) || 1.0);

    let p;
    const propText = String(input.prop || "").toLowerCase();
    if (String(input.sport || "").toUpperCase() === "MLB" && propText.includes("strikeout")) {
      p = StatisticalModels.calculatePoissonProbability(mu, line);
    } else {
      p = StatisticalModels.calculateNormalProbability(mu, sigma, line);
    }

    return { probability: clamp01(p), expectedValue: mu, stdDev: sigma, line };
  }

  calculateMarketProbability(odds) {
    const over = Number(odds?.over);
    const under = Number(odds?.under);
    if (!isFinite(over) || !isFinite(under) || over <= 0 || under <= 0) {
      return { marketProbability: 0.5, vig: 0 };
    }
    const impliedOver = 1 / over;
    const impliedUnder = 1 / under;
    const sum = impliedOver + impliedUnder;
    return { marketProbability: sum > 0 ? impliedOver / sum : 0.5, vig: Math.max(0, sum - 1) };
  }

  applyHouseAdjustments(modelProb, input, features) {
    let adjustedProb = Number(modelProb);
    const flags = [];

    // Name inflation example
    const stars = ["Judge","Ohtani","Mahomes","Brady","Ionescu","Wilson","Cloud","Curry","LeBron","Jokic"];
    if (stars.some(s => String(input?.player || "").includes(s))) {
      adjustedProb -= this.thresholds.NAME_INFLATION;
      flags.push("NAME_INFLATION");
    }

    // Hook trap
    const line = this.extractLineFromProp(input.prop);
    if (Math.abs(line * 2 - Math.round(line * 2)) < 1e-9) {
      // integer
    } else if (Math.abs(line - Math.round(line)) > 1e-9) {
      // has .5, treat as hook
      flags.push("HOOK");
      if (Math.abs((features?.last30Avg || 0) - line) < 0.3) {
        adjustedProb -= this.thresholds.HOOK_BUFFER;
        flags.push("HOOK_TRAP");
      }
    }

    // Variance penalty
    if ((features?.stdDev || 0) > 4) {
      adjustedProb -= this.thresholds.VARIANCE_PENALTY;
      flags.push("HIGH_VARIANCE");
    }

    return { adjustedProb: clamp01(adjustedProb), flags };
  }

  calculateFinalConfidence(modelProb, marketProb, sharpSignal, adjustments) {
    const base =
      0.60 * modelProb +
      0.20 * marketProb +
      0.12 * (0.5 + (Number(sharpSignal) || 0)) +
      0.08 * 0.5;

    const fused = clamp01(base + (adjustments.adjustedProb - modelProb));
    return Math.round(fused * 1000) / 10; // percent with 0.1 precision
  }

  async evaluateProp(inputRaw) {
    const input = {
      sport: inputRaw?.sport || "NBA",
      player: inputRaw?.player || "",
      opponent: inputRaw?.opponent || "",
      prop: inputRaw?.prop || "Points 10.5",
      odds: {
        over: Number(inputRaw?.odds?.over) || 2.0,
        under: Number(inputRaw?.odds?.under) || 1.8,
      },
      startTime: inputRaw?.startTime || new Date(Date.now() + 6 * 3600e3).toISOString(),
      workload: inputRaw?.workload ?? "AUTO",
      injuryNotes: inputRaw?.injuryNotes ?? "UNKNOWN",
    };

    // Do NOT throw on invalid; just record flags and continue
    this.validateInput(input);

    const features = await this.generateFeatures(input);
    const stat = this.calculateStatisticalProbability(features, input);
    const market = this.calculateMarketProbability(input.odds);
    const sharpSignal = 0; // placeholder
    const adj = this.applyHouseAdjustments(stat.probability, input, features);
    const finalConfidence = this.calculateFinalConfidence(
      stat.probability,
      market.marketProbability,
      sharpSignal,
      adj
    );

    const decision =
      finalConfidence >= this.thresholds.LOCK_CONFIDENCE * 100
        ? "LOCK"
        : finalConfidence >= this.thresholds.STRONG_LEAN * 100
        ? "STRONG_LEAN"
        : finalConfidence >= this.thresholds.LEAN * 100
        ? "LEAN"
        : "PASS";

    const suggestion = (stat.probability >= 0.5) ? "OVER" : "UNDER";

    return {
      player: input.player,
      prop: input.prop,
      suggestion,
      decision,
      finalConfidence,
      suggestedStake:
        decision === "LOCK" ? (finalConfidence >= 75 ? 2.0 : 1.0) :
        decision === "STRONG_LEAN" ? 0.5 :
        decision === "LEAN" ? 0.25 : 0,
      topDrivers: [
        `Expected value μ = ${stat.expectedValue.toFixed(2)} vs line ${stat.line}`,
        `Model p_over = ${stat.probability.toFixed(3)}, Market p_over = ${market.marketProbability.toFixed(3)}`,
        `Recent form (last7≈${(features.last7Avg || 0).toFixed(2)}), variance σ≈${stat.stdDev.toFixed(2)}`
      ],
      flags: [...this.errorFlags, ...adj.flags],
      rawNumbers: {
        expectedValue: round2(stat.expectedValue),
        stdDev: round2(stat.stdDev),
        modelProbability: round3(stat.probability),
        marketProbability: round3(market.marketProbability),
        sharpSignal: round3(sharpSignal),
      },
      meta: { dataSource: this.dataSource }
    };
  }
}

function clamp01(x) {
  return Math.max(0, Math.min(1, Number.isFinite(x) ? x : 0));
}
function round2(x){ return Math.round((Number(x)||0)*100)/100; }
function round3(x){ return Math.round((Number(x)||0)*1000)/1000; }
