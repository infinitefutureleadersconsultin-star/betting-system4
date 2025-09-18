// lib/statisticalModels.js
export class StatisticalModels {
  static poissonCDF(lambda, k) {
    if (!Number.isFinite(lambda) || lambda < 0) return 0;
    if (!Number.isFinite(k)) return 0;
    k = Math.floor(k);
    let sum = 0;
    let term = Math.exp(-lambda);
    for (let i = 0; i <= k; i++) {
      sum += term;
      term *= lambda / (i + 1);
    }
    return sum;
  }

  static normalCDF(x, mean, stdDev) {
    if (!Number.isFinite(x) || !Number.isFinite(mean) || !Number.isFinite(stdDev) || stdDev <= 0) {
      return 0.5;
    }
    const z = (x - mean) / (stdDev * Math.sqrt(2));
    return 0.5 * (1 + this.erf(z));
  }

  static erf(x) {
    // Abramowitz/Stegun approximation
    const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741,
          a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911;
    const sign = x < 0 ? -1 : 1;
    x = Math.abs(x);
    const t = 1 / (1 + p * x);
    const y =
      1 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);
    return sign * y;
  }

  static calculatePoissonProbability(lambda, line) {
    if (!Number.isFinite(lambda)) return 0.5;
    const k = Math.ceil(Number(line) || 0) - 1;
    return 1 - this.poissonCDF(lambda, k);
  }

  static calculateNormalProbability(mean, stdDev, line) {
    if (!Number.isFinite(mean) || !Number.isFinite(stdDev) || stdDev <= 0) return 0.5;
    // continuity correction (+0.5) for discrete prop lines
    return 1 - this.normalCDF((Number(line) || 0) + 0.5, mean, stdDev);
  }
}
