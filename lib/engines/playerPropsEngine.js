// lib/engines/playerPropsEngine.js
import { StatisticalModels } from "./statisticalModels.js";

export class PlayerPropsEngine {
  constructor(apiClient) {
    this.apiClient = apiClient;
    this.thresholds = {
      LOCK_CONFIDENCE: 70.0,
      STRONG_LEAN: 67.5,
      LEAN: 65.0,
      NAME_INFLATION: 0.03,
      VARIANCE_PENALTY: 0.04,
      HOOK_BUFFER: 0.03
    };
  }

  extractLineFromProp(prop) {
    const m = String(prop || "").match(/(\d+(\.\d+)?)/);
    return m ? parseFloat(m[1]) : 0;
    }

  // Very defensive defaults so we always return a complete object
  async generateFeatures(input) {
    // TODO: wire real data later; these safe defaults ensure UI shows results now
    const last7 = Array(7).fill(0).map(() => 5 + Math.random() * 3);
    const last30 = Array(30).fill(0).map(() => 5 + Math.random() * 3);
    const mean7 = last7.reduce((a,b)=>a+b,0)/last7.length;
    const mean30 = last30.reduce((a,b)=>a+b,0)/last30.length;
    const variance = last30.reduce((acc,v)=>acc + Math.pow(v - mean30, 2), 0) / last30.length;
    const stdDev = Math.max(0.8, Math.sqrt(variance)); // floor to avoid zero

    // Minute/IP factor placeholder (1.0 baseline)
    const minutesFactor = 1.0;
    const matchupFactor = 1.0;

    return {
      last7Avg: mean7,
      last30Avg: mean30,
      variance,
      stdDev,
      minutesFactor,
      matchupFactor
    };
  }

  calculateStatisticalProbability(features, input) {
    const line = this.extractLineFromProp(input.prop);
    // baseline expectation = recent mean × matchup × minutes
    let mu = features.last30Avg * features.matchupFactor * features.minutesFactor;

    // If mu is missing or too close to 0, nudge it toward line to avoid NaN-y behavior
    if (!Number.isFinite(mu) || mu <= 0) mu = Math.max(0.1, line || 1);

    let pModel;
    if ((input.sport || "").toUpperCase() === "MLB" && /strikeout/i.test(input.prop || "")) {
      // Poisson for K
      const lambda = Math.max(0.1, mu);
      pModel = StatisticalModels.calculatePoissonProbability(lambda, line);
    } else {
      // Normal-ish for rebounds/assists/pass yards
      const std = Math.max(0.8, features.stdDev);
      pModel = StatisticalModels.calculateNormalProbability(mu, std, line);
    }

    if (!Number.isFinite(pModel)) pModel = 0.5;

    return { probability: pModel, expectedValue: mu, stdDev: Math.max(0.8, features.stdDev) };
  }

  calculateMarketProbability(odds) {
    const over = Number(odds?.over) || 2.0;
    const under = Number(odds?.under) || 1.8;
    const impliedOver = 1 / over;
    const impliedUnder = 1 / under;
    const denom = impliedOver + impliedUnder;
    const p = denom > 0 ? impliedOver / denom : 0.5;
    const vig = Math.max(0, denom - 1);
    return { marketProbability: p, vig };
  }

  applyHouseAdjustments(modelProb, input, features) {
    let adj = modelProb;
    const flags = [];

    // Name inflation penalty (tiny)
    const starList = ["Mahomes","Brady","Ionescu","Wilson","Judge","Ohtani","LeBron","Curry"];
    if (starList.some(s => (input.player || "").includes(s))) {
      adj -= this.thresholds.NAME_INFLATION;
      flags.push("NAME_INFLATION");
    }

    // Hook trap (.5) near median projection
    const line = this.extractLineFromProp(input.prop);
    if (Math.abs(line % 1 - 0.5) < 1e-6) {
      // If projection ~ line, tiny nudge down
      if (Math.abs(features.last30Avg - line) < 0.3) {
        adj -= this.thresholds.HOOK_BUFFER;
        flags.push("HOOK_TRAP");
      } else {
        flags.push("HOOK");
      }
    }

    // High variance penalty
    if (features.stdDev > 4.5) {
      adj -= this.thresholds.VARIANCE_PENALTY;
      flags.push("HIGH_VARIANCE");
    }

    adj = Math.max(0, Math.min(1, adj));
    return { adjustedProb: adj, flags };
  }

  calculateFinalConfidence(pModel, pMarket, sharpSignal = 0, adjustedProb) {
    // weights 60/20/12/8; convert to percentage later
    const base = 0.60 * pModel + 0.20 * pMarket + 0.12 * (0.5 + sharpSignal) + 0.08 * adjustedProb;
    const clamped = Math.max(0, Math.min(1, base));
    return clamped * 100; // percent
  }

  async evaluateProp(input) {
    try {
      const required = ["sport", "player", "prop", "odds"];
      for (const f of required) if (!input?.[f]) throw new Error(`Missing field: ${f}`);

      const features = await this.generateFeatures(input);
      const stat = this.calculateStatisticalProbability(features, input);
      const market = this.calculateMarketProbability(input.odds);
      const { adjustedProb, flags } = this.applyHouseAdjustments(stat.probability, input, features);

      const finalConfidence = this.calculateFinalConfidence(stat.probability, market.marketProbability, 0, adjustedProb);
      const suggestion = (stat.probability >= 0.5 ? "OVER" : "UNDER");

      let decision = "PASS", stake = 0;
      if (finalConfidence >= this.thresholds.LOCK_CONFIDENCE) { decision = "LOCK"; stake = finalConfidence >= 75 ? 2.0 : 1.0; }
      else if (finalConfidence >= this.thresholds.STRONG_LEAN) { decision = "STRONG_LEAN"; stake = 0.5; }
      else if (finalConfidence >= this.thresholds.LEAN) { decision = "LEAN"; stake = 0.25; }

      return {
        player: input.player,
        prop: input.prop,
        suggestion,
        decision,
        finalConfidence: Math.round(finalConfidence * 10) / 10, // one decimal
        suggestedStake: stake,
        topDrivers: [
          `Model P(>line) = ${(stat.probability*100).toFixed(1)}%`,
          `Market P(>line) = ${(market.marketProbability*100).toFixed(1)}% (vig≈${(market.vig*100).toFixed(1)}%)`,
          `Projection μ=${stat.expectedValue.toFixed(2)} vs line ${this.extractLineFromProp(input.prop)}`
        ],
        flags,
        rawNumbers: {
          expectedValue: Math.round(stat.expectedValue * 100) / 100,
          stdDev: Math.round(stat.stdDev * 100) / 100,
          modelProbability: Math.round(stat.probability * 1000) / 1000,
          marketProbability: Math.round(market.marketProbability * 1000) / 1000,
          sharpSignal: 0
        }
      };
    } catch (err) {
      return {
        decision: "ERROR",
        message: err.message || "Analysis failed"
      };
    }
  }
}
