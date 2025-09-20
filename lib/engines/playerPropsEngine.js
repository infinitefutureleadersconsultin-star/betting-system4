// lib/engines/playerPropsEngine.js
import { StatisticalModels } from "../statisticalModels.js";

const SMART = String(process.env.SMART_OVERLAYS || "").toUpperCase() === "ON";

// ---------- helpers ----------
function clamp01(x) { return Math.max(0, Math.min(1, Number.isFinite(Number(x)) ? Number(x) : 0)); }
function round2(x) { return Math.round((Number(x) || 0) * 100) / 100; }
function round3(x) { return Math.round((Number(x) || 0) * 1000) / 1000; }
function fmtLocalDate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
function _safeVariance(arr, minFloor = 1.4) {
  if (!Array.isArray(arr) || arr.length === 0) return minFloor;
  const nums = arr.map(x => Number(x) || 0);
  const mean = nums.reduce((a,b)=>a+b,0)/nums.length;
  const v = nums.reduce((a,x)=>a + Math.pow(x - mean, 2), 0) / nums.length;
  return Math.max(minFloor, v);
}
function _tokNameMatchFactory(targetName) {
  const tokens = String(targetName || "").toLowerCase().split(/\s+/).filter(Boolean);
  return (candidate) => {
    const c = String(candidate || "").toLowerCase();
    return tokens.every(tok => c.includes(tok));
  };
}

// STRICT: per-game pitcher strikeouts; avoid batting Ks/rates
function _mlbStrikeoutsFromRow(row) {
  const fields = ["PitchingStrikeouts", "PitcherStrikeouts", "StrikeoutsPitched"];
  for (const k of fields) {
    const v = Number(row?.[k]);
    if (Number.isFinite(v)) return v;
  }
  const k9 = Number.isFinite(Number(row?.PitchingStrikeoutsPerNine))
    ? Number(row?.PitchingStrikeoutsPerNine)
    : Number(row?.StrikeoutsPerNine);
  const ip = Number.isFinite(Number(row?.PitchingInningsPitchedDecimal))
    ? Number(row?.PitchingInningsPitchedDecimal)
    : (Number.isFinite(Number(row?.InningsPitchedDecimal)) ? Number(row?.InningsPitchedDecimal) : Number(row?.InningsPitched));
  if (Number.isFinite(k9) && Number.isFinite(ip) && ip > 0) {
    const k = (k9 * ip) / 9;
    if (Number.isFinite(k)) return k;
  }
  return NaN;
}

export class PlayerPropsEngine {
  constructor(apiClient) {
    this.apiClient = apiClient || null;

    this.errorFlags = [];
    this.dataSource = "fallback";
    this.usedEndpoints = [];
    this.matchedName = "";
    this.zeroFiltered = 0;
    this.recentValsCount = 0;
    this.recentSample = [];

    // store season-avg presence for gating
    this._seasonAvgUsed = false;

    this.thresholds = {
      LOCK_CONFIDENCE: 0.70,
      STRONG_LEAN: 0.675,
      LEAN: 0.65,
      HOOK_BUFFER: 0.05,
      VARIANCE_PENALTY: 0.05,
      NAME_INFLATION: 0.03,
      PROJECTION_GAP_TRIGGER: 0.15,
    };
    this.calibrationFactor = 1.0;
  }

  // ---------- Utilities ----------
  validateInput(input) {
    this.errorFlags = [];
    const required = ["sport", "player", "prop"];
    for (const field of required) {
      if (!input || input[field] === undefined || input[field] === "") {
        this.errorFlags.push(`MISSING_${field.toUpperCase()}`);
      }
    }
    return this.errorFlags.length === 0;
  }

  extractLineFromProp(prop) {
    const m = String(prop || "").match(/(-?\d+(\.\d+)?)/);
    return m ? parseFloat(m[1]) : 0;
  }

  calculateExponentialAverage(arr, decay) {
    if (!Array.isArray(arr) || arr.length === 0) return 0;
    let ws = 0, tw = 0;
    for (let i = 0; i < arr.length; i++) {
      const w = Math.pow(decay, i);
      ws += (Number(arr[i]) || 0) * w;
      tw += w;
    }
    return tw > 0 ? ws / tw : 0;
  }

  calculateVariance(arr) { return _safeVariance(arr, 1.4); }
  calculateMatchupFactor() { return 1.0; }
  calculateMinutesFactor() { return 1.0; }

  async getPlayerHistoricalStats() {
    return {
      last60: Array.from({ length: 60 }, () => 5 + Math.random() * 6),
      last30: Array.from({ length: 30 }, () => 5 + Math.random() * 6),
      last7:  Array.from({ length: 7 },  () => 5 + Math.random() * 6),
      recent: Array.from({ length: 15 }, () => 5 + Math.random() * 6),
    };
  }
  async getOpponentDefensiveStats() {
    return { reboundRate: 0.5, assistRate: 0.5, strikeoutRate: 0.2 };
  }

  _pickValueFromRow(sport, prop, row) {
    const s = String(sport || "").toUpperCase();
    const p = String(prop || "").toLowerCase();

    if (s === "MLB") {
      if (p.includes("strikeout")) return _mlbStrikeoutsFromRow(row);
      return NaN;
    }
    if (s === "NBA" || s === "WNBA") {
      if (p.includes("rebound")) return Number(row?.Rebounds) ?? Number(row?.ReboundsTotal) ?? NaN;
      if (p.includes("assist"))  return Number(row?.Assists)  ?? NaN;
      return NaN;
    }
    if (s === "NFL") {
      if (p.includes("passing")) return Number(row?.PassingYards) ?? NaN;
      return NaN;
    }
    return NaN;
  }

  _pushUsed(tag) {
    try { this.usedEndpoints.push(tag); } catch {}
  }

  async _byDateArray(sport, dateStr) {
    const c = this.apiClient;
    if (!c) return [];
    if (sport === "MLB" && typeof c.getMLBPlayerStatsByDate === "function") {
      this._pushUsed(`MLB:player-stats-by-date:${dateStr}`);
      return await c.getMLBPlayerStatsByDate(dateStr) || [];
    }
    if (sport === "NBA" && typeof c.getNBAPlayerStatsByDate === "function") {
      this._pushUsed(`NBA:player-stats-by-date:${dateStr}`);
      return await c.getNBAPlayerStatsByDate(dateStr) || [];
    }
    if (sport === "WNBA" && typeof c.getWNBAPlayerStatsByDate === "function") {
      this._pushUsed(`WNBA:player-stats-by-date:${dateStr}`);
      return await c.getWNBAPlayerStatsByDate(dateStr) || [];
    }
    return [];
  }

  async _seasonArray(sport, season) {
    const c = this.apiClient;
    if (!c) return [];
    if (sport === "MLB" && typeof c.getMLBPlayerSeasonStats === "function") {
      this._pushUsed(`MLB:player-season-stats:${season}`);
      return await c.getMLBPlayerSeasonStats(season) || [];
    }
    if (sport === "NBA" && typeof c.getNBAPlayerSeasonStats === "function") {
      this._pushUsed(`NBA:player-season-stats:${season}`);
      return await c.getNBAPlayerSeasonStats(season) || [];
    }
    if (sport === "WNBA" && typeof c.getWNBAPlayerSeasonStats === "function") {
      this._pushUsed(`WNBA:player-season-stats:${season}`);
      return await c.getWNBAPlayerSeasonStats(season) || [];
    }
    if (sport === "NFL" && typeof c.getNFLPlayerSeasonStats === "function") {
      this._pushUsed(`NFL:player-season-stats:${season}`);
      return await c.getNFLPlayerSeasonStats(season) || [];
    }
    return [];
  }

  async _nflWeekArray(season, week) {
    const c = this.apiClient;
    if (!c || typeof c.getNFLPlayerGameStatsByWeek !== "function") return [];
    this._pushUsed(`NFL:player-stats-by-week:${season}-W${week}`);
    const arr = await c.getNFLPlayerGameStatsByWeek(season, week);
    return Array.isArray(arr) ? arr : [];
  }

  async _collectRecentByDate(input, sport, startDateStr, lookbackDays, maxGames, idHint) {
    const nameMatch = _tokNameMatchFactory(input.player);
    const values = [];
    let date = new Date(startDateStr);

    for (let d = 0; d < lookbackDays && values.length < maxGames; d++) {
      const dStr = fmtLocalDate(date);
      const arr = await this._byDateArray(sport, dStr);
      if (Array.isArray(arr) && arr.length) {
        let row = null;

        if (idHint && idHint.key && idHint.value != null) {
          row = arr.find(r => Number(r?.[idHint.key]) === Number(idHint.value));
        }
        if (!row) row = arr.find(r => nameMatch(r?.Name));

        if (row) {
          const v = this._pickValueFromRow(sport, input.prop, row);
          if (Number.isFinite(v)) values.push(v);
          else this.zeroFiltered++;
        }
      }
      date.setDate(date.getDate() - 1);
    }
    return values;
  }

  async _collectNFLRecents(input, season, currentWeek, maxWeeks, idHint) {
    const values = [];
    const nameMatch = _tokNameMatchFactory(input.player);
    for (let w = currentWeek; w >= 1 && values.length < maxWeeks; w--) {
      const arr = await this._nflWeekArray(season, w);
      if (arr.length) {
        let row = null;
        if (idHint && idHint.key && idHint.value != null) {
          row = arr.find(r => Number(r?.[idHint.key]) === Number(idHint.value));
        }
        if (!row) row = arr.find(r => nameMatch(r?.Name));

        if (row) {
          const v = this._pickValueFromRow("NFL", input.prop, row);
          if (Number.isFinite(v)) values.push(v);
          else this.zeroFiltered++;
        }
      }
    }
    return values;
  }

  // ---------- Feature builder ----------
  async generateFeatures(input) {
    const sport = String(input?.sport || "").toUpperCase();
    this.dataSource = "fallback";
    this.usedEndpoints = [];
    this.matchedName = "";
    this.zeroFiltered = 0;
    this.recentValsCount = 0;
    this.recentSample = [];
    this._seasonAvgUsed = false;

    let dateStr;
    try {
      const d = input?.startTime ? new Date(input.startTime) : new Date();
      if (!Number.isFinite(d.getTime())) throw new Error("invalid date");
      dateStr = fmtLocalDate(d);
    } catch { dateStr = fmtLocalDate(new Date()); }

    const seasonYear = new Date(dateStr).getFullYear();

    try {
      if (this.apiClient && this.apiClient.apiKey) {
        const base = new Date(dateStr);
        const datesToTry = [0, -1, -2].map(off => {
          const d = new Date(base);
          d.setDate(d.getDate() + off);
          return fmtLocalDate(d);
        });

        const nameMatch = _tokNameMatchFactory(input.player);
        let matched = null;
        let idHint = null;

        for (const dStr of datesToTry) {
          const stats = await this._byDateArray(sport, dStr);
          if (Array.isArray(stats) && stats.length) {
            matched = stats.find(s => nameMatch(s?.Name));
            if (matched) {
              this.matchedName = String(matched.Name || "");
              if (matched.PlayerID) idHint = { key: "PlayerID", value: matched.PlayerID };
              break;
            }
          }
        }

        let seasonAvg = null;
        if (matched) {
          const seasonArr = await this._seasonArray(sport, seasonYear);
          if (Array.isArray(seasonArr) && seasonArr.length) {
            const sRow = seasonArr.find(r => r?.PlayerID && matched?.PlayerID && Number(r.PlayerID) === Number(matched.PlayerID))
              || seasonArr.find(r => nameMatch(r?.Name));
            if (sRow) {
              if (sport === "MLB") {
                const totalK  = Number(sRow?.PitchingStrikeouts ?? sRow?.Strikeouts ?? NaN);
                const starts  = Number(sRow?.GamesStarted ?? NaN);
                const games   = Number(sRow?.Games ?? sRow?.GamesPlayed ?? NaN);
                const denom = Number.isFinite(starts) && starts > 0 ? starts : (Number.isFinite(games) && games > 0 ? games : NaN);
                if (Number.isFinite(totalK) && Number.isFinite(denom) && denom > 0) seasonAvg = totalK / denom;
              } else if (sport === "NBA" || sport === "WNBA") {
                const gp = Number(sRow?.Games ?? sRow?.GamesPlayed ?? NaN);
                if (gp > 0) {
                  const prop = String(input.prop).toLowerCase();
                  if (prop.includes("rebound") && Number.isFinite(Number(sRow?.Rebounds))) seasonAvg = Number(sRow.Rebounds) / gp;
                  else if (prop.includes("assist") && Number.isFinite(Number(sRow?.Assists))) seasonAvg = Number(sRow.Assists) / gp;
                }
              } else if (sport === "NFL") {
                const gp = Number(sRow?.Games ?? sRow?.GamesPlayed ?? NaN);
                if (gp > 0 && String(input.prop).toLowerCase().includes("passing") && Number.isFinite(Number(sRow?.PassingYards))) {
                  seasonAvg = Number(sRow.PassingYards) / gp;
                }
              }
              if (Number.isFinite(seasonAvg)) this._seasonAvgUsed = true;
            }
          }
        }

        let recentVals = [];
        if (sport === "NFL") {
          const c = this.apiClient;
          let season = seasonYear;
          let curWeek = null;
          if (typeof c.getNFLSeasonCurrent === "function") {
            const s = await c.getNFLSeasonCurrent();
            if (Number.isFinite(Number(s))) season = Number(s);
          }
          if (typeof c.getNFLWeekCurrent === "function") {
            const w = await c.getNFLWeekCurrent();
            if (Number.isFinite(Number(w))) curWeek = Number(w);
          }
          if (!curWeek) curWeek = 18;
          recentVals = await this._collectNFLRecents(input, season, curWeek, 8, idHint);
        } else {
          recentVals = await this._collectRecentByDate(input, sport, dateStr, 45, 10, idHint);
        }

        this.recentValsCount = recentVals.length;
        this.recentSample = Array.isArray(recentVals) ? recentVals.slice(0, 10) : [];

        const recentMean = recentVals.length > 0
          ? (recentVals.reduce((a,b)=>a+b,0)/recentVals.length)
          : (Number.isFinite(seasonAvg) ? seasonAvg : NaN);

        let blendedMu = null;
        if (Number.isFinite(recentMean) && Number.isFinite(seasonAvg)) blendedMu = 0.6 * recentMean + 0.4 * seasonAvg;
        else if (Number.isFinite(recentMean)) blendedMu = recentMean;
        else if (Number.isFinite(seasonAvg)) blendedMu = seasonAvg;

        if (Number.isFinite(blendedMu)) {
          let variance;
          const propText = String(input.prop).toLowerCase();
          if (recentVals.length >= 3) variance = this.calculateVariance(recentVals);
          else {
            if (sport === "MLB" && propText.includes("strikeout")) variance = Math.max(1.44, Math.abs(blendedMu - blendedMu*0.9));
            else if (sport === "NFL" && propText.includes("passing")) variance = Math.max(400, Math.abs(blendedMu - blendedMu*0.8));
            else variance = Math.max(2.25, Math.abs(blendedMu - blendedMu*0.85));
          }

          this.dataSource = "sportsdata";
          return {
            last60Avg: blendedMu,
            last30Avg: blendedMu,
            last7Avg:  recentVals.length > 0 ? this.calculateExponentialAverage(recentVals.slice(0,7), 0.85) : blendedMu,
            variance,
            stdDev: Math.sqrt(variance),
            matchupFactor: 1.0,
            minutesFactor: 1.0,
            specific: { adjustment: 0 },
          };
        }
      }

      // ---------- FALLBACK ----------
      const playerStats = await this.getPlayerHistoricalStats(input.player, sport);
      const opponentStats = await this.getOpponentDefensiveStats(input.opponent, sport);
      const features = {
        last60Avg: this.calculateExponentialAverage(playerStats.last60, 0.95),
        last30Avg: this.calculateExponentialAverage(playerStats.last30, 0.90),
        last7Avg:  this.calculateExponentialAverage(playerStats.last7, 0.85),
        variance:  this.calculateVariance(playerStats.recent),
        stdDev:    0,
        matchupFactor: this.calculateMatchupFactor(opponentStats, sport, input.prop),
        minutesFactor: this.calculateMinutesFactor(input.workload, sport),
        specific: { adjustment: 0 }
      };
      features.stdDev = Math.sqrt(features.variance);
      return features;

    } catch {
      const playerStats = await this.getPlayerHistoricalStats(input.player, sport);
      const variance = this.calculateVariance(playerStats.recent);
      return {
        last30Avg: this.calculateExponentialAverage(playerStats.last30, 0.90),
        last7Avg:  this.calculateExponentialAverage(playerStats.last7, 0.85),
        variance,
        stdDev: Math.max(1, Math.sqrt(variance)),
        matchupFactor: 1.0,
        minutesFactor: 1.0,
        specific: { adjustment: 0 }
      };
    }
  }

  // ---------- Modeling ----------
  calculateStatisticalProbability(features, input) {
    const line = this.extractLineFromProp(input.prop);

    let mu =
      (Number(features.last30Avg) || 0) *
      (Number(features.matchupFactor) || 1) *
      (Number(features.minutesFactor) || 1);

    if (features?.specific?.adjustment) {
      mu += Number(features.specific.adjustment) || 0;
    }

    let sigma = Number(features.stdDev);
    if (!Number.isFinite(sigma) || sigma <= 0) sigma = 1.2;

    const sport = String(input.sport || "").toUpperCase();
    const propText = String(input.prop || "").toLowerCase();

    if (sport === "MLB" && propText.includes("strikeout")) {
      sigma = Math.max(1.2, Math.min(sigma, 3.5));
      const p = StatisticalModels.calculatePoissonProbability(mu, line);
      return { probability: clamp01(p), expectedValue: mu, stdDev: sigma, line };
    }

    if ((sport === "NBA" || sport === "WNBA") && (propText.includes("rebound") || propText.includes("assist"))) {
      sigma = Math.max(1.3, Math.min(sigma, 5.0));
    } else if (sport === "NFL" && propText.includes("passing")) {
      sigma = Math.max(20, Math.min(sigma, 120));
    }

    const p = StatisticalModels.calculateNormalProbability(mu, sigma, line);
    return { probability: clamp01(p), expectedValue: mu, stdDev: sigma, line };
  }

  calculateMarketProbability(odds) {
    const over = Number(odds?.over);
    const under = Number(odds?.under);
    if (!isFinite(over) || !isFinite(under) || over <= 0 || under <= 0) {
      return { marketProbability: 0.5, vig: 0 };
    }
    const impliedOver = 1 / over;
    const impliedUnder = 1 / under;
    const sum = impliedOver + impliedUnder;
    return { marketProbability: sum > 0 ? impliedOver / sum : 0.5, vig: Math.max(0, sum - 1) };
  }

  // ---------- Smart overlays ----------
  projectionGapNudge(modelProb, marketProb) {
    if (!SMART) return 0;
    const gap = Math.abs(modelProb - marketProb);
    if (gap >= this.thresholds.PROJECTION_GAP_TRIGGER) {
      const direction = Math.sign(modelProb - marketProb);
      return 0.03 * direction;
    }
    return 0;
  }
  workloadGuardrail() { return 0; }
  microContextNudge() { return 0; }
  steamDetectionNudge() { return 0; }

  applyHouseAdjustments(modelProb, input, features) {
    let adjustedProb = Number(modelProb);
    const flags = [];

    const stars = ["Judge","Ohtani","Mahomes","Brady","Ionescu","Wilson","Cloud","Curry","LeBron","Jokic"];
    if (stars.some(s => String(input?.player || "").includes(s))) {
      adjustedProb -= this.thresholds.NAME_INFLATION;
      flags.push("NAME_INFLATION");
    }

    const line = this.extractLineFromProp(input.prop);
    const isHalf = Math.abs(line - Math.round(line)) > 1e-9;
    if (isHalf) {
      flags.push("HOOK");
      if (Math.abs((features?.last30Avg || 0) - line) < 0.3) {
        adjustedProb -= this.thresholds.HOOK_BUFFER;
        flags.push("HOOK_TRAP");
      }
    }

    if ((features?.stdDev || 0) > 4 && (String(input.sport).toUpperCase() !== "NFL")) {
      adjustedProb -= this.thresholds.VARIANCE_PENALTY;
      flags.push("HIGH_VARIANCE");
    }

    return { adjustedProb: clamp01(adjustedProb), flags };
  }

  applyCalibration(prob) { return prob * this.calibrationFactor; }

  fuseProbabilities(modelProb, marketProb, sharpSignal, addOnNudges) {
    const base =
      0.60 * modelProb +
      0.20 * marketProb +
      0.12 * (0.5 + (Number(sharpSignal) || 0)) +
      0.08 * 0.5;
    let fused = base + addOnNudges;
    fused = this.applyCalibration(clamp01(fused));
    return clamp01(fused);
  }

  // ---------- Decision Gatekeeper (prevents "fast locks") ----------
  applySafetyGates({ fused, decision }, input, stat) {
    let final = fused;
    let dec = decision;
    const sport = String(input.sport || "").toUpperCase();
    const propText = String(input.prop || "").toLowerCase();

    // Gate A: require real SDIO data
    const hasData = this.dataSource === "sportsdata" && Array.isArray(this.usedEndpoints) && this.usedEndpoints.length > 0;
    if (!hasData) {
      final = Math.min(final, 0.499);
      dec = "PASS";
      this.errorFlags.push("FALLBACK_DATA");
    }

    // Gate B: require recent sample or season avg
    const hasRecents = Number(this.recentValsCount) >= 3;
    if (!hasRecents && !this._seasonAvgUsed) {
      final = Math.min(final, 0.499);
      dec = "PASS";
      this.errorFlags.push("INSUFFICIENT_SAMPLE");
    }

    // Gate C: MLB Ks sanity checks
    if (sport === "MLB" && propText.includes("strikeout")) {
      const zerosHeavy = Array.isArray(this.recentSample) && this.recentSample.length >= 5 && this.recentSample.every(v => Number(v) === 0);
      const tinySigmaBigMu = (stat.stdDev || 0) < 1.2 && (stat.expectedValue || 0) > 7.5;
      if (zerosHeavy || tinySigmaBigMu) {
        final = Math.min(final, 0.499);
        dec = "PASS";
        this.errorFlags.push(zerosHeavy ? "ZERO_SAMPLE" : "OUTLIER_SIGMA");
      }
    }

    // Map back to confidence and decision tier
    const finalConfidence = Math.round(final * 1000) / 10;
    const tier =
      finalConfidence >= this.thresholds.LOCK_CONFIDENCE * 100 ? "LOCK" :
      finalConfidence >= this.thresholds.STRONG_LEAN * 100 ? "STRONG_LEAN" :
      finalConfidence >= this.thresholds.LEAN * 100 ? "LEAN" : "PASS";

    return { finalConfidence, decision: tier === "PASS" ? "PASS" : dec };
  }

  // ---------- Main ----------
  async evaluateProp(inputRaw) {
    const input = {
      sport: inputRaw?.sport || "NBA",
      player: inputRaw?.player || "",
      opponent: inputRaw?.opponent || "",
      prop: inputRaw?.prop || "Rebounds 5.5",
      odds: {
        over: Number(inputRaw?.odds?.over) || Number(inputRaw?.over) || 2.0,
        under: Number(inputRaw?.odds?.under) || Number(inputRaw?.under) || 1.8,
      },
      startTime: inputRaw?.startTime || new Date(Date.now() + 6 * 3600e3).toISOString(),
      workload: inputRaw?.workload ?? "AUTO",
      injuryNotes: inputRaw?.injuryNotes ?? "UNKNOWN",
    };

    this.validateInput(input);

    let features;
    try { features = await this.generateFeatures(input); }
    catch {
      features = { last60Avg: 0, last30Avg: 0, last7Avg: 0, variance: 1, stdDev: 1, matchupFactor: 1, minutesFactor: 1, specific: { adjustment: 0 } };
    }

    const stat   = this.calculateStatisticalProbability(features, input);
    const market = this.calculateMarketProbability(input.odds);

    const gapNudge   = this.projectionGapNudge(stat.probability, market.marketProbability);
    const workNudge  = this.workloadGuardrail(input, features);
    const microNudge = this.microContextNudge(input);
    const steamNudge = this.steamDetectionNudge();

    const { adjustedProb, flags: houseFlags } =
      this.applyHouseAdjustments(stat.probability, input, features);

    const nudgesTotal = gapNudge + workNudge + microNudge + steamNudge + (adjustedProb - stat.probability);

    const fused = this.fuseProbabilities(
      stat.probability,
      market.marketProbability,
      0,
      nudgesTotal
    );

    const preDecision =
      fused >= this.thresholds.LOCK_CONFIDENCE ? "LOCK" :
      fused >= this.thresholds.STRONG_LEAN ? "STRONG_LEAN" :
      fused >= this.thresholds.LEAN ? "LEAN" : "PASS";

    // Safety gates (prevents “fast LOCK”)
    const gated = this.applySafetyGates({ fused, decision: preDecision }, input, stat);

    const suggestion = (stat.probability >= 0.5) ? "OVER" : "UNDER";

    return {
      player: input.player,
      prop: input.prop,
      suggestion,
      decision: gated.decision,
      finalConfidence: gated.finalConfidence,
      suggestedStake:
        gated.decision === "LOCK" ? (gated.finalConfidence >= 75 ? 2.0 : 1.0) :
        gated.decision === "STRONG_LEAN" ? 0.5 :
        gated.decision === "LEAN" ? 0.25 : 0,
      topDrivers: [
        `μ=${stat.expectedValue.toFixed(2)} vs line ${stat.line}`,
        `Model p_over=${stat.probability.toFixed(3)}, Market p_over=${market.marketProbability.toFixed(3)}`,
        `Nudges: gap=${gapNudge.toFixed(3)}, workload=${workNudge.toFixed(3)}, micro=${microNudge.toFixed(3)}`
      ],
      flags: [...this.errorFlags, ...houseFlags, SMART ? "SMART_OVERLAYS" : "SMART_OFF"],
      rawNumbers: {
        expectedValue: round2(stat.expectedValue),
        stdDev: round2(stat.stdDev),
        modelProbability: round3(stat.probability),
        marketProbability: round3(market.marketProbability),
        sharpSignal: 0,
      },
      meta: {
        dataSource: this.dataSource,
        usedEndpoints: this.usedEndpoints,
        matchedName: this.matchedName,
        zeroFiltered: this.zeroFiltered,
        recentCount: this.recentValsCount,
        recentSample: this.recentSample || []
      }
    };
  }
}
