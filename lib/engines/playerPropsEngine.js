// lib/engines/playerPropsEngine.js
import { StatisticalModels } from '../statisticalModels.js';

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
      NAME_INFLATION: 0.03
    };
  }

  validateInput(input) {
    this.errorFlags = [];
    const required = ['sport', 'player', 'prop', 'odds', 'startTime'];
    for (const field of required) {
      if (!input[field]) {
        this.errorFlags.push(`MISSING_${field.toUpperCase()}`);
      }
    }

    const gameStartsInHours = (new Date(input.startTime) - new Date()) / (1000 * 60 * 60);

    if (gameStartsInHours < 4) {
      if (!input.workload || input.workload === 'AUTO') {
        this.errorFlags.push('WORKLOAD_MISSING: Must provide actual minutes/IP/pass attempts for games starting < 4 hours');
      }
      if (!input.odds || !input.odds.over || !input.odds.under) {
        this.errorFlags.push('ODDS_MISSING: Both over and under odds required');
      }
      if (input.injuryNotes === undefined) {
        this.errorFlags.push('INJURY_STATUS_MISSING: Injury/rest status required for games starting < 4 hours');
      }
    }

    if (gameStartsInHours < 2 && (input.injuryNotes && `${input.injuryNotes}`.toLowerCase().includes('questionable'))) {
      this.errorFlags.push('QUESTIONABLE_STATUS: Player status unresolved < 2 hours before start');
    }

    return this.errorFlags.length === 0;
  }

  async generateFeatures(input) {
    const sport = `${input.sport}`.toUpperCase();
    const features = {};
    // NOTE: Replace placeholders with real API usage as you wire up data.
    const playerStats = await this.getPlayerHistoricalStats(input.player, sport);
    const opponentStats = await this.getOpponentDefensiveStats(input.opponent, sport);

    features.last60Avg = this.calculateExponentialAverage(playerStats.last60, 0.95);
    features.last30Avg = this.calculateExponentialAverage(playerStats.last30, 0.90);
    features.last7Avg  = this.calculateExponentialAverage(playerStats.last7,  0.85);

    features.variance = this.calculateVariance(playerStats.recent);
    features.stdDev = Math.sqrt(features.variance);

    features.matchupFactor = this.calculateMatchupFactor(opponentStats, sport, input.prop);
    features.minutesFactor = this.calculateMinutesFactor(input.workload, sport);

    if (sport === 'MLB' && input.prop.toLowerCase().includes('strikeout')) {
      features.specific = await this.calculateMLBStrikeoutFeatures(input);
    } else if ((sport === 'NBA' || sport === 'WNBA') &&
               (input.prop.toLowerCase().includes('rebound') || input.prop.toLowerCase().includes('assist'))) {
      features.specific = await this.calculateBasketballFeatures(input);
    } else if (sport === 'NFL' && input.prop.toLowerCase().includes('passing')) {
      features.specific = await this.calculateNFLPassingFeatures(input);
    }

    return features;
  }

  calculateStatisticalProbability(features, input) {
    const prop = input.prop;
    const line = this.extractLineFromProp(prop);

    let expectedValue = features.last30Avg * features.matchupFactor * features.minutesFactor;
    if (features.specific && typeof features.specific.adjustment === 'number') {
      expectedValue += features.specific.adjustment;
    }

    let probability;
    if (`${input.sport}`.toUpperCase() === 'MLB' && prop.toLowerCase().includes('strikeout')) {
      probability = StatisticalModels.calculatePoissonProbability(expectedValue, line);
    } else {
      probability = StatisticalModels.calculateNormalProbability(expectedValue, features.stdDev || 1, line);
    }

    return { probability, expectedValue, stdDev: features.stdDev || 1 };
  }

  calculateMarketProbability(odds) {
    const impliedOver = 1 / Number(odds.over);
    const impliedUnder = 1 / Number(odds.under);
    const marketProbability = impliedOver / (impliedOver + impliedUnder);
    return { marketProbability, vig: (impliedOver + impliedUnder) - 1 };
  }

  applyHouseAdjustments(statResult, input, features) {
    let adjustedProb = statResult.probability;
    const flags = [];

    const starPlayers = ['Judge', 'Ohtani', 'Mahomes', 'Brady', 'Ionescu', 'Wilson', 'Cloud'];
    if (starPlayers.some(star => `${input.player}`.includes(star))) {
      adjustedProb -= this.thresholds.NAME_INFLATION;
      flags.push('NAME_INFLATION');
    }

    const line = this.extractLineFromProp(input.prop);
    if (line % 1 === 0.5) {
      flags.push('HOOK');
      if (Math.abs(statResult.expectedValue - line) < 0.3) {
        adjustedProb -= this.thresholds.HOOK_BUFFER;
        flags.push('HOOK_TRAP');
      }
    }

    if ((features.stdDev || 0) > this.getVarianceThreshold(input.sport)) {
      adjustedProb -= this.thresholds.VARIANCE_PENALTY;
      flags.push('HIGH_VARIANCE');
    }

    return { adjustedProb, flags };
  }

  calculateFinalConfidence(modelProb, marketProb, sharpSignal, adjustmentsDelta) {
    const base =
      0.60 * modelProb +
      0.20 * marketProb +
      0.12 * (0.5 + sharpSignal) +
      0.08 * 0.5;

    // adjustmentsDelta = adjustedProb - modelProb
    return Math.max(0, Math.min(1, base + adjustmentsDelta));
  }

  async evaluateProp(input) {
    if (!this.validateInput(input)) {
      return {
        decision: 'ERROR',
        errors: this.errorFlags,
        message: 'Missing required data: ' + this.errorFlags.join(', ')
      };
    }

    try {
      const features = await this.generateFeatures(input);
      const statResult = this.calculateStatisticalProbability(features, input);
      const marketResult = this.calculateMarketProbability(input.odds);
      const sharpSignal = 0; // placeholder
      const { adjustedProb, flags } = this.applyHouseAdjustments(statResult, input, features);

      const finalConfidence = this.calculateFinalConfidence(
        statResult.probability,
        marketResult.marketProbability,
        sharpSignal,
        adjustedProb - statResult.probability
      );

      let decision = 'PASS';
      let stake = 0;
      if (finalConfidence >= this.thresholds.LOCK_CONFIDENCE) {
        decision = 'LOCK';
        stake = finalConfidence >= 0.75 ? 2.0 : 1.0;
      } else if (finalConfidence >= this.thresholds.STRONG_LEAN) {
        decision = 'STRONG_LEAN';
        stake = 0.5;
      } else if (finalConfidence >= this.thresholds.LEAN) {
        decision = 'LEAN';
        stake = 0.25;
      }

      return {
        player: input.player,
        prop: input.prop,
        suggestion: statResult.probability > 0.5 ? 'OVER' : 'UNDER',
        decision,
        finalConfidence: Math.round(finalConfidence * 1000) / 10,
        suggestedStake: stake,
        topDrivers: this.getTopDrivers(features, statResult, marketResult),
        flags,
        rawNumbers: {
          expectedValue: Math.round(statResult.expectedValue * 100) / 100,
          stdDev: Math.round((statResult.stdDev || 0) * 100) / 100,
          modelProbability: Math.round(statResult.probability * 1000) / 1000,
          marketProbability: Math.round(marketResult.marketProbability * 1000) / 1000,
          sharpSignal: Math.round(sharpSignal * 1000) / 1000
        }
      };
    } catch (error) {
      console.error('analyze-prop engine error', error);
      return {
        decision: 'ERROR',
        message: `Analysis failed: ${error.message}`
      };
    }
  }

  // ---------- helpers ----------
  extractLineFromProp(prop) {
    const match = `${prop}`.match(/(\d+\.?\d*)/);
    return match ? parseFloat(match[1]) : 0;
  }

  calculateExponentialAverage(data, decay) {
    if (!data || data.length === 0) return 0;
    let weightedSum = 0;
    let totalWeight = 0;
    for (let i = 0; i < data.length; i++) {
      const weight = Math.pow(decay, i);
      weightedSum += data[i] * weight;
      totalWeight += weight;
    }
    return weightedSum / totalWeight;
  }

  calculateVariance(data) {
    if (!data || data.length === 0) return 0;
    const mean = data.reduce((a, b) => a + b, 0) / data.length;
    return data.reduce((acc, val) => acc + Math.pow(val - mean, 2), 0) / data.length;
  }

  calculateMatchupFactor() { return 1.0; }
  calculateMinutesFactor() { return 1.0; }

  async getPlayerHistoricalStats() {
    // Placeholder randoms — replace with real API calls later
    return {
      last60: Array(60).fill(0).map(() => Math.random() * 10 + 5),
      last30: Array(30).fill(0).map(() => Math.random() * 10 + 5),
      last7:  Array(7).fill(0).map(() => Math.random() * 10 + 5),
      recent: Array(15).fill(0).map(() => Math.random() * 10 + 5),
    };
  }
  async getOpponentDefensiveStats() { return { reboundRate: 0.5, assistRate: 0.5, strikeoutRate: 0.2 }; }
  async calculateMLBStrikeoutFeatures() { return { adjustment: 0 }; }
  async calculateBasketballFeatures() { return { adjustment: 0 }; }
  async calculateNFLPassingFeatures() { return { adjustment: 0 }; }

  getVarianceThreshold(sport) {
    const t = { MLB: 1.0, NBA: 5.0, WNBA: 5.0, NFL: 15.0 };
    return t[`${sport}`.toUpperCase()] ?? 5.0;
  }

  getTopDrivers(features, statResult, marketResult) {
    return [
      `Expected value: ${statResult.expectedValue.toFixed(1)}`,
      `Market inefficiency: ${(statResult.probability - marketResult.marketProbability).toFixed(3)}`,
      `Recent form: ${features.last7Avg.toFixed(1)} avg last 7 games`
    ];
  }
}
