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

  // -------- Validation (never throw) --------
  validateInput(input) {
    this.errorFlags = [];
    const required = ["sport", "player", "opponent", "prop", "odds", "startTime"];

    for (const field of required) {
      if (
        input[field] === undefined ||
        input[field] === null ||
        (typeof input[field] === "string" && input[field].trim() === "")
      ) {
        this.errorFlags.push(`MISSING_${field.toUpperCase()}`);
      }
    }

    const start = new Date(input.startTime);
    const gameStartsInHrs = Number.isFinite(start.getTime())
      ? (start.getTime() - Date.now()) / 36e5
      : 999;

    if (gameStartsInHrs < 4) {
      if (!input.workload || input.workload === "AUTO") {
        this.errorFlags.push(
          "WORKLOAD_MISSING: Provide minutes/IP/pass attempts for games <4h away"
        );
      }
      if (!input.odds || input.odds.over == null || input.odds.under == null) {
        this.errorFlags.push("ODDS_MISSING: Need both over and under odds");
      }
      if (input.injuryNotes === undefined) {
        this.errorFlags.push(
          "INJURY_STATUS_MISSING: Provide injury/rest status for games <4h"
        );
      }
    }

    return this.errorFlags.length === 0;
  }

  // -------- Features (safe placeholders; never throw) --------
  async generateFeatures(input) {
    const features = {};
    // Placeholders so the system works even without external feeds:
    const rand = () => 5 + Math.random() * 10;
    const mkArr = (n) => Array.from({ length: n }, rand);

    features.last60 = mkArr(60);
    features.last30 = mkArr(30);
    features.last7 = mkArr(7);
    features.recent = mkArr(15);

    features.last60Avg = this.calculateExponentialAverage(features.last60, 0.95);
    features.last30Avg = this.calculateExponentialAverage(features.last30, 0.90);
    features.last7Avg = this.calculateExponentialAverage(features.last7, 0.85);

    features.variance = this.calculateVariance(features.recent);
    features.stdDev = Math.max(0.6, Math.sqrt(features.variance)); // floor to avoid zero

    features.matchupFactor = 1.0;
    features.minutesFactor = 1.0;

    // Hooks to extend later by sport/prop type:
    features.specific = { adjustment: 0 };

    return features;
  }

  // -------- Modeling --------
  calculateStatisticalProbability(features, input) {
    const line = this.extractLineFromProp(input.prop);
    // baseline expectation
    let expectedValue =
      features.last30Avg * features.matchupFactor * features.minutesFactor;

    if (features.specific?.adjustment) expectedValue += features.specific.adjustment;

    let probability;
    const sport = (input.sport || "").toUpperCase();
    const propText = (input.prop || "").toLowerCase();

    if (sport === "MLB" && propText.includes("strikeout")) {
      probability = StatisticalModels.calculatePoissonProbability(expectedValue, line);
    } else {
      probability = StatisticalModels.calculateNormalProbability(
        expectedValue,
        features.stdDev,
        line
      );
    }

    // Clamp
    probability = Math.min(0.999, Math.max(0.001, Number(probability) || 0.5));

    return { probability, expectedValue, stdDev: features.stdDev, line };
  }

  calculateMarketProbability(odds) {
    const over = Number(odds?.over);
    const under = Number(odds?.under);
    if (!Number.isFinite(over) || !Number.isFinite(under) || over <= 1 || under <= 1) {
      return { marketProbability: 0.5, vig: 0 };
    }
    const impliedOver = 1 / over;
    const impliedUnder = 1 / under;
    const denom = impliedOver + impliedUnder;
    if (!denom) return { marketProbability: 0.5, vig: 0 };
    return {
      marketProbability: impliedOver / denom,
      vig: denom - 1,
    };
  }

  applyHouseAdjustments(modelProb, input, features, stat) {
    let adjustedProb = modelProb;
    const flags = [];

    // Name inflation (example list)
    const stars = ["Judge", "Ohtani", "Mahomes", "Brady", "Ionescu", "Wilson", "Cloud"];
    if (stars.some((s) => (input.player || "").includes(s))) {
      adjustedProb -= this.thresholds.NAME_INFLATION;
      flags.push("NAME_INFLATION");
    }

    // Hook trap detection
    if (stat.line % 1 === 0.5) {
      flags.push("HOOK");
      if (Math.abs(stat.expectedValue - stat.line) < 0.3) {
        adjustedProb -= this.thresholds.HOOK_BUFFER;
        flags.push("HOOK_TRAP");
      }
    }

    // Variance penalty
    const sport = (input.sport || "").toUpperCase();
    const varThresh = this.getVarianceThreshold(sport);
    if (features.stdDev > varThresh) {
      adjustedProb -= this.thresholds.VARIANCE_PENALTY;
      flags.push("HIGH_VARIANCE");
    }

    // Clamp
    adjustedProb = Math.min(0.999, Math.max(0.001, adjustedProb));
    return { adjustedProb, flags };
  }

  calculateFinalConfidence(modelProb, marketProb, sharpSignal, adjustments) {
    const base =
      0.60 * modelProb +
      0.20 * marketProb +
      0.12 * (0.5 + sharpSignal) +
      0.08 * 0.5;

    const fused = base + (adjustments.adjustedProb - modelProb);
    return Math.round(Math.min(1, Math.max(0, fused)) * 1000) / 10; // percent with 0.1 precision
  }

  // -------- Public API --------
  async evaluateProp(input) {
    try {
      // Normalize odds
      input = {
        ...input,
        odds: {
          over: Number(input?.odds?.over),
          under: Number(input?.odds?.under),
        },
      };

      const valid = this.validateInput(input);
      // We purposely DO NOT throw on validation; we keep going with flags.

      const features = await this.generateFeatures(input);
      const stat = this.calculateStatisticalProbability(features, input);
      const market = this.calculateMarketProbability(input.odds);
      const sharpSignal = 0; // TODO: plug in steam detection later

      const adjustments = this.applyHouseAdjustments(
        stat.probability,
        input,
        features,
        stat
      );

      const finalConfidence = this.calculateFinalConfidence(
        stat.probability,
        market.marketProbability,
        sharpSignal,
        adjustments
      );

      // Decision
      let decision = "PASS";
      let stake = 0;
      if (finalConfidence >= this.thresholds.LOCK_CONFIDENCE * 100) {
        decision = "LOCK";
        stake = finalConfidence >= 75 ? 2.0 : 1.0;
      } else if (finalConfidence >= this.thresholds.STRONG_LEAN * 100) {
        decision = "STRONG_LEAN";
        stake = 0.5;
      } else if (finalConfidence >= this.thresholds.LEAN * 100) {
        decision = "LEAN";
        stake = 0.25;
      }

      return {
        player: input.player,
        prop: input.prop,
        suggestion: stat.probability >= 0.5 ? "OVER" : "UNDER",
        decision: valid ? decision : "ERROR",
        finalConfidence, // percent number, e.g., 68.4
        suggestedStake: stake,
        topDrivers: this.getTopDrivers(features, stat, market),
        flags: [...(valid ? [] : this.errorFlags), ...adjustments.flags],
        rawNumbers: {
          expectedValue: Math.round(stat.expectedValue * 100) / 100,
          stdDev: Math.round(stat.stdDev * 100) / 100,
          modelProbability: Math.round(stat.probability * 1000) / 1000,
          marketProbability: Math.round(market.marketProbability * 1000) / 1000,
          sharpSignal: 0,
        },
      };
    } catch (err) {
      // Never leak stack to client
      console.error("PlayerPropsEngine.evaluateProp fatal:", err);
      return {
        decision: "ERROR",
        message: "Analysis failed internally.",
        flags: ["ENGINE_EXCEPTION"],
        rawNumbers: { modelProbability: 0.5, marketProbability: 0.5, sharpSignal: 0 },
      };
    }
  }

  // -------- Helpers --------
  extractLineFromProp(prop) {
    const m = String(prop || "").match(/(\d+\.?\d*)/);
    return m ? parseFloat(m[1]) : 0;
  }

  calculateExponentialAverage(arr, decay) {
    if (!arr?.length) return 0;
    let ws = 0;
    let wsum = 0;
    for (let i = 0; i < arr.length; i++) {
      const w = Math.pow(decay, i);
      wsum += arr[i] * w;
      ws += w;
    }
    return ws ? wsum / ws : 0;
  }

  calculateVariance(arr) {
    if (!arr?.length) return 1;
    const mean = arr.reduce((a, b) => a + b, 0) / arr.length;
    return (
      arr.reduce((acc, v) => acc + Math.pow(v - mean, 2), 0) / Math.max(1, arr.length)
    );
  }

  getVarianceThreshold(sport) {
    const map = { MLB: 1.0, NBA: 5.0, WNBA: 5.0, NFL: 15.0 };
    return map[sport] ?? 5.0;
  }

  getTopDrivers(features, stat, market) {
    return [
      `Expected value: ${stat.expectedValue.toFixed(1)}`,
      `Market gap: ${(stat.probability - market.marketProbability).toFixed(3)}`,
      `Recent form (7): ${features.last7Avg.toFixed(1)}`,
    ];
  }
}
