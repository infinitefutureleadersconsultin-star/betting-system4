// lib/engines/statisticalModels.js
export class StatisticalModels {
  static erf(x) {
    const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741, a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911;
    const sign = x < 0 ? -1 : 1; x = Math.abs(x);
    const t = 1.0 / (1.0 + p * x);
    const y = 1.0 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);
    return sign * y;
  }

  static normalCDF(x, mean, std) {
    if (!Number.isFinite(x) || !Number.isFinite(mean) || !Number.isFinite(std) || std <= 0) return 0.5;
    return 0.5 * (1 + this.erf((x - mean) / (std * Math.sqrt(2))));
  }

  static poissonCDF(lambda, k) {
    if (!Number.isFinite(lambda) || lambda < 0) return 0.5;
    if (!Number.isFinite(k)) return 0.5;
    k = Math.floor(k);
    let sum = 0, term = Math.exp(-lambda);
    for (let i = 0; i <= k; i++) {
      sum += term;
      term *= lambda / (i + 1);
    }
    return sum;
  }

  static calculatePoissonProbability(lambda, line) {
    const threshold = Math.ceil(Number(line) - 1e-9);
    const cdf = this.poissonCDF(lambda, threshold - 1);
    return 1 - cdf; // P(X >= threshold)
  }

  static calculateNormalProbability(mean, std, line) {
    // P(X > line) with 0.5 continuity bump for discrete-ish stats
    const cdf = this.normalCDF((Number(line) + 0.5), mean, std);
    return 1 - cdf;
  }
}
