// lib/statisticalModels.js
// Minimal tail calculators used by engines.

function erf(x) {
  // Abramowitz–Stegun approximation
  const sign = x < 0 ? -1 : 1;
  x = Math.abs(x);
  const a1=0.254829592, a2=-0.284496736, a3=1.421413741, a4=-1.453152027, a5=1.061405429;
  const p=0.3275911;
  const t=1/(1+p*x);
  const y=1-((((a5*t+a4)*t)+a3)*t+a2)*t*a1*t*Math.exp(-x*x);
  return sign*y;
}
function normalCCDF(x, mu=0, sigma=1) {
  if (!(sigma>0)) sigma=1;
  const z = (x - mu) / (sigma * Math.SQRT2);
  return 0.5 * (1 - erf(z));
}
function factorial(n){ let r=1; for(let i=2;i<=n;i++) r*=i; return r; }
function poissonCDF(k, lambda){
  if (lambda <= 0) return k >= 0 ? 1 : 0;
  let sum = 0;
  for (let i=0;i<=Math.floor(k);i++){
    sum += Math.pow(lambda, i) / factorial(i);
  }
  return Math.exp(-lambda) * sum;
}

export const StatisticalModels = {
  // P(X > line) with a 0.5 continuity correction: P(X >= ceil(line+ε))
  calculatePoissonProbability(mu, line) {
    const thr = Math.floor(line + 0.5); // continuity-ish
    const cdf = poissonCDF(thr, Math.max(0, mu));
    const pOver = 1 - cdf;
    return Math.max(0, Math.min(1, pOver));
  },

  // P(X > line) using Normal tail with 0.5 continuity correction
  calculateNormalProbability(mu, sigma, line) {
    const x = line + 0.5;
    return normalCCDF(x, mu, sigma);
  }
};
