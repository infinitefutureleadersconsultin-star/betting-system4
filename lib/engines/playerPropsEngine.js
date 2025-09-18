import { StatisticalModels } from './statisticalModels.js';
import { MLB_PARK_K_ADJ } from '../../context/parkFactors.js';

export class PlayerPropsEngine {
  constructor(apiClient) {
    this.apiClient = apiClient;
    this.thresholds = {
      LOCK_CONF: 0.70,
      STRONG_LEAN: 0.675,
      LEAN: 0.65,
      HOOK_BUFFER: 0.03,
      NAME_INFLATION: 0.03,
      VARIANCE_PENALTY: 0.05,
      OVERLAY_GAP: 0.18 // >= 18% disagreement to consider overlay
    };
    this.starNames = ['Mahomes','Brady','Ohtani','Judge','Ionescu','Wilson','Curry','LeBron','Jokic','Giannis'];
  }

  _extractLine(propText) {
    const m = String(propText||'').match(/(\d+(\.\d+)?)/);
    return m ? parseFloat(m[1]) : 0;
  }
  _isHook(line) { return Math.abs(line % 1 - 0.5) < 1e-9; }
  _teamFromPlayer(player) {
    const m = String(player||'').match(/\(([A-Z]{2,3})\)/);
    return m ? m[1] : null;
  }

  // micro-context: MLB park K adjustment on mu (small, safe)
  _applyMLBParkAdjust(mu, team) {
    if (!team) return mu;
    const adj = MLB_PARK_K_ADJ[team];
    if (!adj) return mu;
    return mu + adj; // very small additive
  }

  async evaluateProp(input) {
    const errors = [];
    const required = ['sport','player','opponent','prop','odds','startTime'];
    for (const k of required) if (!input[k]) errors.push(`MISSING_${k.toUpperCase()}`);
    if (!input?.odds?.over || !input?.odds?.under) errors.push('MISSING_ODDS_PAIR');
    if (errors.length) return { decision: 'ERROR', message: `Missing: ${errors.join(', ')}`, errors };

    const sport = String(input.sport).toUpperCase();
    const prop = String(input.prop);
    const line = this._extractLine(prop);
    const team = this._teamFromPlayer(input.player);

    // ===== Base features (prior)
    let mu = line;      // start close to market
    let sigma = 1.2;    // safe default spread

    // ===== Projection overlay + workload (NBA/WNBA free)
    let overlayProb = null;
    let workload = null;
    const overlayPkg = await this.apiClient.getProjectionOverlay({ sport, player: input.player, prop, line });
    if (overlayPkg?.overlay) {
      const { meanStat, sdStat } = overlayPkg.overlay;
      // Blend projection mean with line (avoid overfitting)
      mu = 0.65*meanStat + 0.35*line;
      sigma = Math.max(0.8, sdStat);
      overlayProb = StatisticalModels.calculateNormalProbability(mu, sigma, line);
    }
    if (overlayPkg?.workload) {
      workload = overlayPkg.workload;
    }

    // ===== MLB micro-context (park) if strikeouts
    if (sport==='MLB' && /strikeout/i.test(prop)) {
      mu = this._applyMLBParkAdjust(mu, team);
    }

    // ===== Model probability
    let pModelOver;
    if (sport==='MLB' && /strikeout/i.test(prop)) {
      const lambda = Math.max(0.1, mu);
      pModelOver = StatisticalModels.calculatePoissonProbability(lambda, line);
    } else {
      pModelOver = StatisticalModels.calculateNormalProbability(mu, sigma, line);
    }

    // ===== Market implied
    const { pMarket, vig } = await this.apiClient.getMarketImplied(input.odds.over, input.odds.under);

    // ===== Workload variance penalty (NBA/WNBA minutes stdev)
    const flags = [];
    if ((sport==='NBA' || sport==='WNBA') && workload?.sdMin != null) {
      if (workload.sdMin > 5) {
        // reduce probability 5% absolute, via final fusion later (track via flag)
        flags.push('HIGH_MINUTE_VARIANCE');
      }
    }

    // ===== Hook & Name penalties (house)
    let pAdj = pModelOver;
    if (this.starNames.some(n => input.player.includes(n))) { pAdj -= this.thresholds.NAME_INFLATION; flags.push('NAME_INFLATION'); }
    if (this._isHook(line)) flags.push('HOOK');

    // ===== Steam detection (optional)
    let steamAgainst = false;
    const steamInfo = await this.apiClient.getSteamDelta(/* sport, input.player, prop */);
    if (steamInfo?.against) { steamAgainst = true; flags.push('STEAM_AGAINST'); }

    // ===== Overlay acceptance rule (only if strong disagreement & no steam against)
    let overlayBoost = 0;
    if (overlayProb != null) {
      const gap = Math.abs(overlayProb - pMarket);
      if (gap >= this.thresholds.OVERLAY_GAP && !steamAgainst) {
        // nudge final by 3-6% depending on gap (capped)
        overlayBoost = Math.min(0.06, 0.03 + (gap - this.thresholds.OVERLAY_GAP));
        flags.push('PROJECTION_OVERLAY');
        // align pAdj direction toward overlay a touch
        pAdj = (pAdj*0.8) + (overlayProb*0.2);
      }
    }

    // ===== Base fusion (house-first)
    let base = 0.60*pAdj + 0.20*pMarket + 0.12*(0.5 /* sharp placeholder */) + 0.08*0.5;

    // Hook trap if mu near line
    if (this._isHook(line) && Math.abs(mu - line) < 0.3) { base -= this.thresholds.HOOK_BUFFER; flags.push('HOOK_TRAP'); }
    // Vig awareness penalty
    if (vig > 0.07) { base -= 0.03; flags.push('HIGH_VIG'); }
    // Steam against penalty
    if (steamAgainst) { base -= 0.05; }
    // Workload variance penalty
    if (flags.includes('HIGH_MINUTE_VARIANCE')) { base -= this.thresholds.VARIANCE_PENALTY; }

    // Overlay boost
    base += overlayBoost;

    let final = Math.max(0, Math.min(1, base));
    const confidencePct = Math.round(final*1000)/10;
    const suggestion = pAdj > 0.5 ? 'OVER' : 'UNDER';

    let decision = 'PASS';
    if (final >= this.thresholds.LOCK_CONF) decision = 'LOCK';
    else if (final >= this.thresholds.STRONG_LEAN) decision = 'STRONG_LEAN';
    else if (final >= this.thresholds.LEAN) decision = 'LEAN';

    // If steam is against and confidence is marginal, downgrade to PASS
    if (steamAgainst && final < 0.70) decision = 'PASS';

    return {
      player: input.player,
      prop: input.prop,
      suggestion,
      decision,
      finalConfidence: confidencePct,
      suggestedStake: decision==='LOCK' ? (final >= 0.75 ? 2.0 : 1.0)
                        : decision==='STRONG_LEAN' ? 0.5
                        : decision==='LEAN' ? 0.25 : 0,
      topDrivers: [
        `Expected μ ≈ ${mu.toFixed(2)}, σ ≈ ${sigma.toFixed(2)}`,
        `Model vs Market delta = ${(pAdj - pMarket).toFixed(3)}`,
        overlayBoost ? `Overlay boost applied (+${Math.round(overlayBoost*100)}%)` : 'No overlay boost'
      ],
      flags,
      rawNumbers: {
        expectedValue: Math.round(mu * 100)/100,
        stdDev: Math.round(sigma * 100)/100,
        modelProbability: Math.round(pAdj * 1000)/1000,
        marketProbability: Math.round(pMarket * 1000)/1000,
        overlayProbability: overlayProb != null ? Math.round(overlayProb * 1000)/1000 : null,
        vig: Math.round(vig * 1000)/1000
      }
    };
  }
}
