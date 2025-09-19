// lib/engines/playerPropsEngine.js
import { StatisticalModels } from "../statisticalModels.js";

const SMART = String(process.env.SMART_OVERLAYS || "").toUpperCase() === "ON";

// ---------- small helpers (pure) ----------
function clamp01(x) { return Math.max(0, Math.min(1, Number.isFinite(x) ? x : 0)); }
function round2(x) { return Math.round((Number(x) || 0) * 100) / 100; }
function round3(x) { return Math.round((Number(x) || 0) * 1000) / 1000; }

function fmtLocalDate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// STRICT: per-game pitcher strikeouts; avoid batting Ks/rates
function _mlbStrikeoutsFromRow(row) {
  // Preferred explicit game count fields
  const fields = [
    "PitchingStrikeouts",
    "PitcherStrikeouts",
    "StrikeoutsPitched",
  ];
  for (const k of fields) {
    const v = Number(row?.[k]);
    if (Number.isFinite(v)) return v;
  }

  // Derive from rate only if we also have game IP
  const k9 = (row?.PitchingStrikeoutsPerNine ?? row?.StrikeoutsPerNine);
  const ip =
    (row?.PitchingInningsPitchedDecimal ??
     row?.InningsPitchedDecimal ??
     row?.InningsPitched);

  const k9Num = Number(k9);
  const ipNum = Number(ip);

  if (Number.isFinite(k9Num) && Number.isFinite(ipNum) && ipNum > 0) {
    const k = (k9Num * ipNum) / 9;
    if (Number.isFinite(k)) return k;
  }

  // As a last resort, do NOT use batting "Strikeouts" or generic "Ks"
  return NaN;
}

function _nameMatcherFactory(inputName) {
  const toks = String(inputName || "").toLowerCase().split(/\s+/).filter(Boolean);
  return (candidate) => {
    const c = String(candidate || "").toLowerCase();
    // require ALL tokens to appear to reduce false positives
    return toks.length > 0 && toks.every(t => c.includes(t));
  };
}

function _uniqPush(arr, v) {
  if (!arr.includes(v)) arr.push(v);
}

// ---------- Engine ----------
export class PlayerPropsEngine {
  constructor(apiClient) {
    this.apiClient = apiClient || null;         // may be null; we fallback gracefully
    this.errorFlags = [];
    this.dataSource = "fallback";
    this.usedEndpoints = [];
    this.matchedName = "";
    this.zeroFiltered = 0;
    this.recentValsCount = 0;
    this.recentSample = [];

    this.thresholds = {
      LOCK_CONFIDENCE: 0.70,
      STRONG_LEAN: 0.675,
      LEAN: 0.65,
      HOOK_BUFFER: 0.05,
      VARIANCE_PENALTY: 0.05,
      NAME_INFLATION: 0.03,
      PROJECTION_GAP_TRIGGER: 0.15, // 15%
    };
    this.calibrationFactor = 1.0; // tune via calibration after you have outcomes
  }

  // ---------- Utilities ----------
  validateInput(input) {
    this.errorFlags = [];
    const required = ["sport", "player", "prop", "odds", "startTime"];
    for (const field of required) {
      if (!input || input[field] === undefined || input[field] === "") {
        this.errorFlags.push(`MISSING_${field.toUpperCase()}`);
      }
    }
    return this.errorFlags.length === 0;
  }

  extractLineFromProp(prop) {
    const m = String(prop || "").match(/(\d+(\.\d+)?)/);
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

  calculateVariance(arr) {
    if (!Array.isArray(arr) || arr.length === 0) return 1;
    const nums = arr.map(x => Number(x) || 0);
    const mean = nums.reduce((a, b) => a + b, 0) / nums.length;
    const v = nums.reduce((a, x) => a + (x - mean) ** 2, 0) / nums.length;
    return Math.max(0.25, v);
  }

  calculateMatchupFactor() { return 1.0; }
  calculateMinutesFactor(workload) { return workload && Number(workload) > 0 ? 1.0 : 1.0; }

  async getPlayerHistoricalStats() {
    // Fallback synthetic history (keeps engine alive when no live data)
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

  // ---------- Stat selection per sport/prop ----------
  _pickValueFromRow(prop, sport, row) {
    const p = String(prop || "").toLowerCase();
    const s = String(sport || "").toUpperCase();

    if (s === "MLB") {
      if (p.includes("strikeout")) {
        // Only pitcher per-game Ks (or K9×IP if needed)
        return _mlbStrikeoutsFromRow(row);
      }
      return NaN;
    }

    if (s === "NBA" || s === "WNBA") {
      if (p.includes("rebound")) return Number(row?.Rebounds);
      if (p.includes("assist"))  return Number(row?.Assists);
      if (p.includes("point"))   return Number(row?.Points); // optional
      return NaN;
    }

    if (s === "NFL") {
      if (p.includes("passing") && p.includes("yard")) {
        return Number(row?.PassingYards);
      }
      return NaN;
    }

    return NaN;
  }

  // ---------- SportsDataIO collectors ----------
  async _collectRecentByDateGeneric({ sport, prop, nameMatch, endDateStr, maxLookbackDays = 35, maxSamples = 10 }) {
    // Requires: get<SPORT>PlayerStatsByDate(date)
    // Returns array of per-game numbers for the prop
    const vals = [];
    const today = new Date(endDateStr);
    for (let i = 0; i < maxLookbackDays && vals.length < maxSamples; i++) {
      const d = new Date(today);
      d.setDate(d.getDate() - i);
      const ds = fmtLocalDate(d);

      let rows = [];
      try {
        if (sport === "MLB" && this.apiClient?.getMLBPlayerStatsByDate) {
          rows = await this.apiClient.getMLBPlayerStatsByDate(ds);
          _uniqPush(this.usedEndpoints, `MLB:player-stats-by-date:${ds}`);
        } else if (sport === "NBA" && this.apiClient?.getNBAPlayerStatsByDate) {
          rows = await this.apiClient.getNBAPlayerStatsByDate(ds);
          _uniqPush(this.usedEndpoints, `NBA:player-stats-by-date:${ds}`);
        } else if (sport === "WNBA" && this.apiClient?.getWNBAPlayerStatsByDate) {
          rows = await this.apiClient.getWNBAPlayerStatsByDate(ds);
          _uniqPush(this.usedEndpoints, `WNBA:player-stats-by-date:${ds}`);
        } else {
          break;
        }
      } catch {
        continue;
      }

      if (Array.isArray(rows) && rows.length) {
        const hit = rows.find(r => nameMatch(r?.Name));
        if (hit) {
          // MLB safeguard: ignore "games" where pitcher didn't pitch (IP <= 0)
          if (sport === "MLB") {
            const ip =
              Number(hit?.PitchingInningsPitchedDecimal) ??
              Number(hit?.InningsPitchedDecimal) ??
              Number(hit?.InningsPitched);
            if (!(Number.isFinite(ip) && ip > 0)) {
              this.zeroFiltered += 1;
              continue;
            }
          }

          const v = this._pickValueFromRow(prop, sport, hit);
          if (Number.isFinite(v)) {
            vals.push(v);
            this.matchedName = String(hit?.Name || this.matchedName);
          } else if (v === 0) {
            vals.push(0);
            this.matchedName = String(hit?.Name || this.matchedName);
          }
        }
      }
    }
    return vals;
  }

  async _collectRecentGamesNFL({ prop, nameMatch, maxWeeks = 8, maxSamples = 8 }) {
    // Prefer week-based pulls for NFL
    const vals = [];
    let season = null;
    let currentWeek = null;

    try {
      if (this.apiClient?.getNFLSeasonCurrent) {
        const sc = await this.apiClient.getNFLSeasonCurrent();
        if (sc) season = Number(sc?.Season) || Number(sc);
      }
    } catch {}

    try {
      if (this.apiClient?.getNFLWeekCurrent) {
        const wk = await this.apiClient.getNFLWeekCurrent();
        if (wk) currentWeek = Number(wk?.Week) || Number(wk);
      }
    } catch {}

    if (!season || !currentWeek) return vals;

    for (let w = currentWeek; w > 0 && vals.length < maxSamples && (currentWeek - w) < maxWeeks; w--) {
      try {
        if (!this.apiClient?.getNFLPlayerGameStatsByWeek) break;
        const rows = await this.apiClient.getNFLPlayerGameStatsByWeek(season, w);
        _uniqPush(this.usedEndpoints, `NFL:player-stats-by-week:${season}-W${w}`);
        if (Array.isArray(rows) && rows.length) {
          const hit = rows.find(r => nameMatch(r?.Name));
          if (hit) {
            const v = this._pickValueFromRow(prop, "NFL", hit);
            if (Number.isFinite(v)) {
              vals.push(v);
              this.matchedName = String(hit?.Name || this.matchedName);
            } else if (v === 0) {
              vals.push(0);
              this.matchedName = String(hit?.Name || this.matchedName);
            }
          }
        }
      } catch {}
    }

    return vals;
  }

  // Try to get season per-game average for the specific prop
  _seasonPerGameFromRow(sport, prop, row) {
    if (!row) return NaN;

    const s = String(sport || "").toUpperCase();
    const p = String(prop || "").toLowerCase();

    if (s === "MLB" && p.includes("strikeout")) {
      // Use cumulative pitcher Ks divided by GS (preferred), or GP if GS missing
      const totalKs =
        Number(row?.PitchingStrikeouts) ??
        Number(row?.StrikeoutsPitched) ??
        Number(row?.PitcherStrikeouts);
      const gs = Number(row?.GamesStarted);
      const gp = Number(row?.Games) || Number(row?.GamesPitched);
      const denom = Number.isFinite(gs) && gs > 0 ? gs
                   : (Number.isFinite(gp) && gp > 0 ? gp : NaN);
      if (Number.isFinite(totalKs) && Number.isFinite(denom) && denom > 0) {
        return totalKs / denom;
      }
      return NaN;
    }

    if ((s === "NBA" || s === "WNBA")) {
      const games = Number(row?.Games) || Number(row?.GamesPlayed) || NaN;
      if (!Number.isFinite(games) || games <= 0) return NaN;
      if (p.includes("rebound")) {
        const tot = Number(row?.Rebounds) ?? Number(row?.TotalRebounds);
        return Number.isFinite(tot) ? tot / games : NaN;
      }
      if (p.includes("assist")) {
        const tot = Number(row?.Assists);
        return Number.isFinite(tot) ? tot / games : NaN;
      }
      if (p.includes("point")) {
        const tot = Number(row?.Points);
        return Number.isFinite(tot) ? tot / games : NaN;
      }
      return NaN;
    }

    if (s === "NFL" && p.includes("passing") && p.includes("yard")) {
      const games = Number(row?.Games) || Number(row?.Played) || NaN;
      const yds = Number(row?.PassingYards);
      if (Number.isFinite(yds) && Number.isFinite(games) && games > 0) {
        return yds / games;
      }
      return NaN;
    }

    return NaN;
  }

  // ---------- Feature builder (SportsDataIO first, then fallback) ----------
  async generateFeatures(input) {
    const sport = String(input?.sport || "").toUpperCase();
    const features = {};
    this.dataSource = "fallback";
    this.usedEndpoints = [];
    this.matchedName = "";
    this.zeroFiltered = 0;
    this.recentValsCount = 0;
    this.recentSample = [];

    // Local date (avoid UTC day shift)
    let dateStr;
    try {
      const d = input?.startTime ? new Date(input.startTime) : new Date();
      const t = d.getTime();
      if (!Number.isFinite(t)) throw new Error("invalid date");
      dateStr = fmtLocalDate(d);
    } catch {
      dateStr = fmtLocalDate(new Date());
    }

    const nameMatch = _nameMatcherFactory(input.player);

    // ---- House-first: try SportsDataIO season + recent
    try {
      if (this.apiClient && this.apiClient.apiKey) {
        // 1) Season pull if available (per sport)
        let seasonRows = null;
        const activeSeason = (new Date(dateStr)).getFullYear();

        try {
          if (sport === "MLB" && this.apiClient.getMLBPlayerSeasonStats) {
            seasonRows = await this.apiClient.getMLBPlayerSeasonStats(activeSeason);
            _uniqPush(this.usedEndpoints, `MLB:player-season-stats:${activeSeason}`);
          } else if (sport === "NBA" && this.apiClient.getNBAPlayerSeasonStats) {
            seasonRows = await this.apiClient.getNBAPlayerSeasonStats(activeSeason);
            _uniqPush(this.usedEndpoints, `NBA:player-season-stats:${activeSeason}`);
          } else if (sport === "WNBA" && this.apiClient.getWNBAPlayerSeasonStats) {
            seasonRows = await this.apiClient.getWNBAPlayerSeasonStats(activeSeason);
            _uniqPush(this.usedEndpoints, `WNBA:player-season-stats:${activeSeason}`);
          } else if (sport === "NFL" && this.apiClient.getNFLPlayerSeasonStats) {
            seasonRows = await this.apiClient.getNFLPlayerSeasonStats(activeSeason);
            _uniqPush(this.usedEndpoints, `NFL:player-season-stats:${activeSeason}`);
          }
        } catch {}

        let seasonAvg = NaN;
        if (Array.isArray(seasonRows) && seasonRows.length) {
          const row = seasonRows.find(r => nameMatch(r?.Name));
          if (row) {
            seasonAvg = this._seasonPerGameFromRow(sport, input.prop, row);
            if (Number.isFinite(seasonAvg)) {
              this.matchedName = String(row.Name || this.matchedName);
            }
          }
        }

        // 2) Recent games
        let recentVals = [];
        if (sport === "NFL") {
          recentVals = await this._collectRecentGamesNFL({
            prop: input.prop,
            nameMatch,
            maxWeeks: 10,
            maxSamples: 8
          });
        } else {
          recentVals = await this._collectRecentByDateGeneric({
            sport,
            prop: input.prop,
            nameMatch,
            endDateStr: dateStr,
            maxLookbackDays: sport === "MLB" ? 60 : 35,
            maxSamples: sport === "MLB" ? 10 : 10
          });
        }

        // set debuggables
        this.recentValsCount = recentVals.length;
        this.recentSample = Array.isArray(recentVals) ? recentVals.slice(0, 10) : [];

        // 3) Blend recent with season
        if (Number.isFinite(seasonAvg) || recentVals.length > 0) {
          const recentMean = recentVals.length > 0
            ? recentVals.reduce((a, b) => a + b, 0) / recentVals.length
            : seasonAvg;

          // Emphasize recent but keep season in view
          const blendedMu = Number.isFinite(seasonAvg)
            ? (0.6 * recentMean + 0.4 * seasonAvg)
            : recentMean;

          // Variance: use sample if we have 3+; otherwise a conservative floor
          let variance;
          if (recentVals.length >= 3) {
            variance = this.calculateVariance(recentVals);
          } else {
            const floor =
              sport === "MLB" && String(input.prop).toLowerCase().includes("strikeout") ? 1.4 :
              (sport === "NFL" ? 400 : 1.0); // NFL yards vary a lot → higher floor
            variance = Math.max(floor, Math.abs(blendedMu - blendedMu * 0.9));
          }

          this.dataSource = "sportsdata";
          return {
            last60Avg: blendedMu,
            last30Avg: blendedMu,
            last7Avg:  recentVals.length > 0 ? this.calculateExponentialAverage(recentVals.slice(0, 7), 0.85) : blendedMu,
            variance,
            stdDev: Math.sqrt(variance),
            matchupFactor: 1.0,
            minutesFactor: 1.0,
            specific: { adjustment: 0 },
          };
        }
      }

      // ---- If here, season+recent didn’t materialize -> fallback synthetic
      const playerStats = await this.getPlayerHistoricalStats(input.player, sport);
      const opponentStats = await this.getOpponentDefensiveStats(input.opponent, sport);
      features.last60Avg = this.calculateExponentialAverage(playerStats.last60, 0.95);
      features.last30Avg = this.calculateExponentialAverage(playerStats.last30, 0.90);
      features.last7Avg  = this.calculateExponentialAverage(playerStats.last7,  0.85);
      features.variance  = this.calculateVariance(playerStats.recent);
      features.stdDev    = Math.sqrt(features.variance);
      features.matchupFactor = this.calculateMatchupFactor(opponentStats, sport, input.prop);
      features.minutesFactor = this.calculateMinutesFactor(input.workload, sport);
      features.specific = { adjustment: 0 };
      return features;

    } catch {
      // absolute safety valve
      const playerStats = await this.getPlayerHistoricalStats(input.player, sport);
      const variance = this.calculateVariance(playerStats.recent);
      return {
        last30Avg: this.calculateExponentialAverage(playerStats.last30, 0.90),
        last7Avg:  this.calculateExponentialAverage(playerStats.last7,  0.85),
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

    // Base sigma from features with sport/prop guard rails
    let sigma = Number(features.stdDev);
    const sport = String(input.sport || "").toUpperCase();
    const propText = String(input.prop || "").toLowerCase();

    if (!Number.isFinite(sigma)) sigma = 1.2;

    if (sport === "MLB" && propText.includes("strikeout")) {
      // MLB Ks: avoid razor-thin σ; cap huge outliers
      sigma = Math.max(1.2, Math.min(sigma, 3.5));
    } else if (sport === "NFL" && propText.includes("passing") && propText.includes("yard")) {
      // NFL passing yards are wide
      sigma = Math.max(25, Math.min(sigma, 150));
    } else {
      // NBA/WNBA props tend to be moderately dispersed
      sigma = Math.max(1.0, Math.min(sigma, 6.0));
    }

    let p;
    if (sport === "MLB" && propText.includes("strikeout")) {
      // Poisson for discrete MLB Ks
      p = StatisticalModels.calculatePoissonProbability(mu, line);
    } else {
      // Normal with continuity correction for most props
      p = StatisticalModels.calculateNormalProbability(mu, sigma, line);
    }

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

  // ---------- Smart overlays (small bounded nudges) ----------
  projectionGapNudge(modelProb, marketProb) {
    if (!SMART) return 0;
    const gap = Math.abs(modelProb - marketProb);
    if (gap >= this.thresholds.PROJECTION_GAP_TRIGGER) {
      const direction = Math.sign(modelProb - marketProb);
      return 0.03 * direction; // ±3% nudge toward model
    }
    return 0;
  }

  workloadGuardrail(input, features) {
    if (!SMART) return 0;
    const w = String(input?.workload || "").toLowerCase();
    if (!w || w.includes("low") || w.includes("?")) return -0.03; // light penalty
    if ((features?.stdDev || 0) > 4) return -0.02;                // high variance penalty
    return 0;
  }

  microContextNudge(input) {
    if (!SMART) return 0;
    const text = `${input?.injuryNotes || ""} ${input?.opponent || ""}`.toLowerCase();
    let nudge = 0;
    if (text.includes("wind out") || text.includes("coors") || text.includes("fast pace")) nudge += 0.02;
    if (text.includes("wind in") || text.includes("back-to-back") || text.includes("fatigue")) nudge -= 0.02;
    return nudge;
  }

  steamDetectionNudge() {
    if (!SMART) return 0;
    // Hook to line-move history later; neutral for now
    return 0;
  }

  applyHouseAdjustments(modelProb, input, features) {
    let adjustedProb = Number(modelProb);
    const flags = [];

    // Name inflation guard
    const stars = ["Judge","Ohtani","Mahomes","Brady","Ionescu","Wilson","Cloud","Curry","LeBron","Jokic"];
    if (stars.some(s => String(input?.player || "").includes(s))) {
      adjustedProb -= this.thresholds.NAME_INFLATION;
      flags.push("NAME_INFLATION");
    }

    // Hook handling
    const line = this.extractLineFromProp(input.prop);
    const isHalf = Math.abs(line - Math.round(line)) > 1e-9;
    if (isHalf) {
      flags.push("HOOK");
      if (Math.abs((features?.last30Avg || 0) - line) < 0.3) {
        adjustedProb -= this.thresholds.HOOK_BUFFER;
        flags.push("HOOK_TRAP");
      }
    }

    // Variance penalty
    if ((features?.stdDev || 0) > (String(input.sport).toUpperCase() === "NFL" ? 100 : 4)) {
      adjustedProb -= this.thresholds.VARIANCE_PENALTY;
      flags.push("HIGH_VARIANCE");
    }

    return { adjustedProb: clamp01(adjustedProb), flags };
  }

  // ---------- Calibration + Fusion ----------
  applyCalibration(prob) {
    // Scale probabilities after empirical calibration (kept = 1.0 now)
    return prob * this.calibrationFactor;
  }

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

  // ---------- Main entry ----------
  async evaluateProp(inputRaw) {
    const input = {
      sport: inputRaw?.sport || "NBA",
      player: inputRaw?.player || "",
      opponent: inputRaw?.opponent || "",
      prop: inputRaw?.prop || "Points 10.5",
      odds: {
        over: Number(inputRaw?.odds?.over) || 2.0,
        under: Number(inputRaw?.odds?.under) || 1.8,
      },
      startTime: inputRaw?.startTime || new Date(Date.now() + 6 * 3600e3).toISOString(),
      workload: inputRaw?.workload ?? "AUTO",
      injuryNotes: inputRaw?.injuryNotes ?? "UNKNOWN",
    };

    this.validateInput(input);

    // Robust: even if feature gen throws, continue with safe defaults
    let features;
    try {
      features = await this.generateFeatures(input);
    } catch {
      features = {
        last60Avg: 0,
        last30Avg: 0,
        last7Avg: 0,
        variance: 1,
        stdDev: 1,
        matchupFactor: 1,
        minutesFactor: 1,
        specific: { adjustment: 0 },
      };
    }

    const stat   = this.calculateStatisticalProbability(features, input);
    const market = this.calculateMarketProbability(input.odds);

    // Smart overlays (small bounded nudges)
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
      0 /* sharpSignal placeholder */,
      nudgesTotal
    );

    const finalConfidence = Math.round(fused * 1000) / 10; // percent with 0.1 precision

    const decision =
      finalConfidence >= this.thresholds.LOCK_CONFIDENCE * 100 ? "LOCK" :
      finalConfidence >= this.thresholds.STRONG_LEAN * 100 ? "STRONG_LEAN" :
      finalConfidence >= this.thresholds.LEAN * 100 ? "LEAN" : "PASS";

    const suggestion = (stat.probability >= 0.5) ? "OVER" : "UNDER";

    return {
      player: input.player,
      prop: input.prop,
      suggestion,
      decision,
      finalConfidence,
      suggestedStake:
        decision === "LOCK" ? (finalConfidence >= 75 ? 2.0 : 1.0) :
        decision === "STRONG_LEAN" ? 0.5 :
        decision === "LEAN" ? 0.25 : 0,
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
