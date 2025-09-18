// lib/statisticalModels.js
export class StatisticalModels {
  static poissonCDF(lambda, k) {
    let sum = 0;
    let term = Math.exp(-lambda);
    for (let i = 0; i <= k; i++) {
      sum += term;
      term *= lambda / (i + 1);
    }
    return sum;
  }

  static normalCDF(x, mean, stdDev) {
    return 0.5 * (1 + this.erf((x - mean) / (stdDev * Math.sqrt(2))));
  }

  static erf(x) {
    const a1 =  0.254829592;
    const a2 = -0.284496736;
    const a3 =  1.421413741;
    const a4 = -1.453152027;
    const a5 =  1.061405429;
    const p  =  0.3275911;

    const sign = x < 0 ? -1 : 1;
    x = Math.abs(x);

    const t = 1.0 / (1.0 + p * x);
    const y = 1.0 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);

    return sign * y;
  }

  static calculatePoissonProbability(lambda, line) {
    const k = Math.ceil(line) - 1;
    return 1 - this.poissonCDF(lambda, k);
  }

  static calculateNormalProbability(mean, stdDev, line) {
    return 1 - this.normalCDF(line + 0.5, mean, stdDev);
  }
}
