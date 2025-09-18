// lib/engines/playerPropsEngine.js
import { StatisticalModels } from "./statisticalModels.js";

export class PlayerPropsEngine {
  constructor(apiClient) {
    this.apiClient = apiClient;
    this.errorFlags = [];
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
      if (input[field] === undefined || input[field] === null || input[field] === "") {
        this.errorFlags.push(`MISSING_${field.toUpperCase()}`);
      }
    }

    // Time-based checks (soft – we still continue with defaults)
    const start = new Date(input.startTime);
    const gameStartsInHrs = Number.isFinite(start.getTime())
      ? (start - new Date()) / 36e5
      : Infinity;

    if (gameStartsInHrs < 4) {
      if (!input.workload || input.workload === "AUTO") {
        this.errorFlags.push("WORKLOAD_MISSING_<4H");
      }
      if (!input?.odds?.over || !input?.odds?.under) {
        this.errorFlags.push("ODDS_MISSING_<4H");
      }
      if (input.injuryNotes === undefined) {
        this.errorFlags.push("INJURY_STATUS_MISSING_<4H");
      }
    }

    if (gameStartsInHrs < 2 && (input.injuryNotes && /questionable/i.test(input.injuryNotes))) {
      this.errorFlags.push("QUESTIONABLE_STATUS_<2H");
    }

    // Don’t hard-fail; just return whether there are blocking errors (none here)
    return this.errorFlags.length === 0;
  }

  async generateFeatures(input) {
    const sport = (input.sport || "").toUpperCase();
    const features = {};

    // ⚠️ This demo version uses synthetic numbers; hook up real API when ready.
    const playerStats = await this.getPlayerHistoricalStats(input.player, sport);
    const opponentStats = await this.getOpponentDefensiveStats(input.opponent, sport);

    // Exponential moving averages
    features.last60Avg = this.calculateExponentialAverage(playerStats.last60, 0.95);
    features.last30Avg = this.calculateExponentialAverage(playerStats.last30, 0.90);
    features.last7Avg = this.calculateExponentialAverage(playerStats.last7, 0.85);

    // Variance / stdev
    features.variance = this.calculateVariance(playerStats.recent);
    features.stdDev = Math.sqrt(features.variance || 1);

    // Matchup and minutes factors
    features.matchupFactor = this.calculateMatchupFactor(opponentStats, sport, input.prop);
    features.minutesFactor = this.calculateMinutesFactor(input.workload, sport);

    // Sport-specific
    if (sport === "MLB" && /strikeout/i.test(input.prop)) {
      features.specific = await this.calculateMLBStrikeoutFeatures(input);
    } else if ((sport === "NBA" || sport === "WNBA") && /(rebound|assist)/i.test(input.prop)) {
      features.specific = await this.calculateBasketballFeatures(input);
    } else if (sport === "NFL" && /passing/i.test(input.prop)) {
      features.specific = await this.calculateNFLPassingFeatures(input);
    }

    return features;
  }

  calculateStatisticalProbability(features, input) {
    const line = this.extractLineFromProp(input.prop);

    // Baseline expectation
    let expectedValue = (features.last30Avg || 0) * (features.matchupFactor || 1) * (features.minutesFactor || 1);

    if (features.specific && Number.isFinite(features.specific.adjustment)) {
      expectedValue += features.specific.adjustment;
    }

    let probability;
    if ((input.sport || "").toUpperCase() === "MLB" && /strikeout/i.test(input.prop)) {
      probability = StatisticalModels.calculatePoissonProbability(Math.max(expectedValue, 0.0001), line);
    } else {
      probability = StatisticalModels.calculateNormalProbability(
        expectedValue,
        Math.max(features.stdDev || 1, 0.0001),
        line
      );
    }

    return {
      probability: Math.max(0, Math.min(1, probability || 0.5)),
      expectedValue,
      stdDev: Math.max(features.stdDev || 1, 0.0001),
    };
  }

  calculateMarketProbability(odds) {
    const impliedOver = 1 / (Number(odds?.over) || 2.0);
    const impliedUnder = 1 / (Number(odds?.under) || 1.8);
    const denom = impliedOver + impliedUnder || 1;
    const vigFreeOver = impliedOver / denom;
    return {
      marketProbability: Math.max(0, Math.min(1, vigFreeOver)),
      vig: Math.max(0, denom - 1),
    };
  }

  applyHouseAdjustments(modelProb, input, features, statResult) {
    let adjustedProb = modelProb;
    const flags = [];

    // Name inflation penalty
    const starPlayers = ["Judge", "Ohtani", "Mahomes", "Brady", "Ionescu", "Wilson", "Cloud"];
    if (starPlayers.some((star) => (input.player || "").includes(star))) {
      adjustedProb -= this.thresholds.NAME_INFLATION;
      flags.push("NAME_INFLATION");
    }

    // Hook trap detection
    const line = this.extractLineFromProp(input.prop);
    if (Math.abs(line % 1) === 0.5) {
      flags.push("HOOK");
      if (Math.abs((statResult?.expectedValue || 0) - line) < 0.3) {
        adjustedProb -= this.thresholds.HOOK_BUFFER;
        flags.push("HOOK_TRAP");
      }
    }

    // Variance penalty
    if ((features.stdDev || 0) > this.getVarianceThreshold(input.sport)) {
      adjustedProb -= this.thresholds.VARIANCE_PENALTY;
      flags.push("HIGH_VARIANCE");
    }

    return { adjustedProb: Math.max(0, Math.min(1, adjustedProb)), flags };
  }

  calculateFinalConfidence(modelProb, marketProb, sharpSignal, adjustments) {
    const base =
      0.60 * modelProb +
      0.20 * marketProb +
      0.12 * (0.5 + sharpSignal) +
      0.08 * 0.5;

    const fused = base + (adjustments.adjustedProb - modelProb);
    return Math.max(0, Math.min(1, fused));
  }

  async evaluateProp(input) {
    // Validate but don’t hard-stop; we’ll return flags so UI can show issues
    this.validateInput(input);

    const features = await this.generateFeatures(input);
    const statResult = this.calculateStatisticalProbability(features, input);
    const marketResult = this.calculateMarketProbability(input.odds);
    const sharpSignal = 0; // placeholder
    const adjustments = this.applyHouseAdjustments(statResult.probability, input, features, statResult);

    const finalConfidence = this.calculateFinalConfidence(
      statResult.probability,
      marketResult.marketProbability,
      sharpSignal,
      adjustments
    );

    let decision = "PASS";
    let stake = 0;

    if (finalConfidence >= this.thresholds.LOCK_CONFIDENCE) {
      decision = "LOCK";
      stake = finalConfidence >= 0.75 ? 2.0 : 1.0;
    } else if (finalConfidence >= this.thresholds.STRONG_LEAN) {
      decision = "STRONG_LEAN";
      stake = 0.5;
    } else if (finalConfidence >= this.thresholds.LEAN) {
      decision = "LEAN";
      stake = 0.25;
    }

    const topDrivers = this.getTopDrivers(features, statResult, marketResult);

    return {
      player: input.player,
      prop: input.prop,
      suggestion: statResult.probability > 0.5 ? "OVER" : "UNDER",
      decision,
      finalConfidence: Math.round(finalConfidence * 1000) / 10, // percent with 0.1 precision
      suggestedStake: stake,
      topDrivers,
      flags: this.errorFlags.concat(adjustments.flags),
      rawNumbers: {
        expectedValue: Math.round(statResult.expectedValue * 100) / 100,
        stdDev: Math.round(statResult.stdDev * 100) / 100,
        modelProbability: Math.round(statResult.probability * 1000) / 1000,
        marketProbability: Math.round(marketResult.marketProbability * 1000) / 1000,
        sharpSignal: Math.round(sharpSignal * 1000) / 1000,
      },
    };
  }

  // ---- helpers ----

  extractLineFromProp(prop) {
    const match = String(prop || "").match(/(\d+\.?\d*)/);
    return match ? parseFloat(match[1]) : 0;
  }

  calculateExponentialAverage(data, decay) {
    const arr = Array.isArray(data) ? data : [];
    if (!arr.length) return 0;
    let weightedSum = 0;
    let totalWeight = 0;
    for (let i = 0; i < arr.length; i++) {
      const w = Math.pow(decay, i);
      weightedSum += (arr[i] || 0) * w;
      totalWeight += w;
    }
    return totalWeight ? weightedSum / totalWeight : 0;
  }

  calculateVariance(data) {
    const arr = Array.isArray(data) ? data : [];
    if (!arr.length) return 1;
    const mean = arr.reduce((a, b) => a + (b || 0), 0) / arr.length;
    return arr.reduce((acc, v) => acc + Math.pow((v || 0) - mean, 2), 0) / arr.length;
  }

  calculateMatchupFactor(_opp, _sport, _prop) { return 1.0; }
  calculateMinutesFactor(_workload, _sport) { return 1.0; }

  async getPlayerHistoricalStats(_player, _sport) {
    // Replace with real data later
    return {
      last60: Array.from({ length: 60 }, () => Math.random() * 10 + 5),
      last30: Array.from({ length: 30 }, () => Math.random() * 10 + 5),
      last7:  Array.from({ length: 7 },  () => Math.random() * 10 + 5),
      recent: Array.from({ length: 15 }, () => Math.random() * 10 + 5),
    };
  }

  async getOpponentDefensiveStats(_opponent, _sport) {
    return { reboundRate: 0.5, assistRate: 0.5, strikeoutRate: 0.2 };
  }

  async calculateMLBStrikeoutFeatures(_input) { return { adjustment: 0 }; }
  async calculateBasketballFeatures(_input)   { return { adjustment: 0 }; }
  async calculateNFLPassingFeatures(_input)   { return { adjustment: 0 }; }

  getVarianceThreshold(sport) {
    const map = { MLB: 1.0, NBA: 5.0, WNBA: 5.0, NFL: 15.0 };
    return map[(sport || "").toUpperCase()] ?? 5.0;
  }

  getTopDrivers(features, statResult, marketResult) {
    return [
      `Expected value: ${statResult.expectedValue.toFixed(1)}`,
      `Market inefficiency: ${(statResult.probability - marketResult.marketProbability).toFixed(3)}`,
      `Recent form: ${features.last7Avg.toFixed(1)} avg (last 7)`,
    ];
  }
}
