// lib/engines/gameLinesEngine.js
export class GameLinesEngine {
  constructor(apiClient) {
    this.apiClient = apiClient;
  }

  async evaluateGameLine(input) {
    try {
      const features = await this.generateGameFeatures(input);
      const probability = this.calculateGameProbability(features, input);
      const marketProb = this.calculateMarketProbability(input.odds);

      const confidence = this.calculateGameConfidence(probability, marketProb);

      return {
        game: `${input.home} vs ${input.away}`,
        line: input.line,
        suggestion: probability > 0.5 ? input.home : input.away,
        confidence: Math.round(confidence * 1000) / 10,
        recommendation: confidence >= 0.6 ? 'BET' : 'PASS'
      };
    } catch (error) {
      return {
        decision: 'ERROR',
        message: `Game line analysis failed: ${error.message}`
      };
    }
  }

  async generateGameFeatures() {
    return {};
  }

  calculateGameProbability() {
    return 0.5;
  }

  calculateGameConfidence(modelProb, marketProb) {
    return Math.abs(modelProb - marketProb);
  }

  calculateMarketProbability(odds) {
    if (!odds || !odds.home || !odds.away) return 0.5;
    const impliedHome = 1 / Number(odds.home);
    const impliedAway = 1 / Number(odds.away);
    return impliedHome / (impliedHome + impliedAway);
  }
}
