export class StatisticalModels {
  static poissonCDF(lambda, k) {
    let sum = 0
    let term = Math.exp(-lambda)
    for (let i = 0; i <= k; i++) {
      sum += term
      term *= lambda / (i + 1)
    }
    return sum
  }

  static erf(x) {
    const a1 =  0.254829592, a2 = -0.284496736, a3 =  1.421413741
    const a4 = -1.453152027, a5 =  1.061405429, p  =  0.3275911
    const sign = x < 0 ? -1 : 1
    x = Math.abs(x)
    const t = 1.0 / (1.0 + p * x)
    const y = 1.0 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-x * x)
    return sign * y
  }

  static normalCDF(x, mean, std) {
    return 0.5 * (1 + this.erf((x - mean) / (std * Math.sqrt(2))))
  }

  static probOverNormal(mean, std, line) {
    // half-unit continuity correction for .5 hooks
    return 1 - this.normalCDF(line + 0.5, mean, std)
  }

  static probOverPoisson(lambda, line) {
    const k = Math.ceil(line) - 1
    return 1 - this.poissonCDF(lambda, k)
  }
}
