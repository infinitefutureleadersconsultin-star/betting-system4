// lib/engines/statisticalModels.js
export class StatisticalModels {
  static poissonCDF(lambda, k) {
    if (!Number.isFinite(lambda) || lambda < 0) return 0.5;
    let sum = 0;
    let term = Math.exp(-lambda);
    for (let i = 0; i <= Math.max(0, Math.floor(k)); i++) {
      sum += term;
      term *= lambda / (i + 1);
    }
    return Math.min(1, Math.max(0, sum));
  }

  static normalCDF(x, mean, std) {
    if (!Number.isFinite(x) || !Number.isFinite(mean) || !Number.isFinite(std) || std <= 0) {
      return 0.5;
    }
    // Abramowitz-Stegun approximation for erf
    const z = (x - mean) / (std * Math.sqrt(2));
    const t = 1 / (1 + 0.3275911 * Math.abs(z));
    const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741, a4 = -1.453152027, a5 = 1.061405429;
    const erf =
      1 -
      (((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t) * Math.exp(-z * z);
    const sign = z < 0 ? -1 : 1;
    return 0.5 * (1 + sign * erf);
  }

  static calculatePoissonProbability(lambda, line) {
    const k = Math.ceil(Number(line) || 0) - 1;
    return 1 - this.poissonCDF(Number(lambda) || 0, k);
  }

  static calculateNormalProbability(mean, stdDev, line) {
    // continuity correction (+0.5 above the line)
    return 1 - this.normalCDF((Number(line) || 0) + 0.5, Number(mean) || 0, Math.max(0.1, Number(stdDev) || 1));
  }
}
