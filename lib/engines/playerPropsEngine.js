// lib/engines/playerPropsEngine.js
import { StatisticalModels } from "../statisticalModels.js";

const SMART = String(process.env.SMART_OVERLAYS || "").toUpperCase() === "ON";

export class PlayerPropsEngine {
  constructor(apiClient) {
    this.apiClient = apiClient || null; // may be null; we fallback gracefully
    this.errorFlags = [];
    this.dataSource = "fallback";
    this.usedEndpoints = [];
    this.matchedName = "";
    this.zeroFiltered = 0;

    this.thresholds = {
      LOCK_CONFIDENCE: 0.70,
      STRONG_LEAN: 0.675,
      LEAN: 0.65,
      HOOK_BUFFER: 0.05,
      VARIANCE_PENALTY: 0.05,
      NAME_INFLATION: 0.03,
      PROJECTION_GAP_TRIGGER: 0.15, // 15%
    };
    this.calibrationFactor = 1.0; // tune later with outcomes
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

  // ---------- Name matching helpers ----------
  _norm(s) { return String(s || "").toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim(); }
  _nameTokens(s) { return this._norm(s).split(" ").filter(Boolean); }
  _matchByTokens(inputName, candidate) {
    const toks = this._nameTokens(inputName);
    const c = this._norm(candidate);
    return toks.some(t => c.includes(t));
  }
  _preferLastName(inputName, rowName) {
    const toks = this._nameTokens(inputName);
    const last = toks[toks.length - 1] || "";
    return this._norm(rowName).includes(last);
  }

  pickStatFromProp(prop, row, sport, isSeasonTotals = false) {
    const p = String(prop || "").toLowerCase();

    // MLB strikeouts (pitching)
    if (sport === "MLB" && p.includes("strikeout")) {
      if (isSeasonTotals) {
        // Season → per-start/per-appearance average if possible
        const totalK = Number(row.StrikeoutsPitched ?? row.PitchingStrikeouts ?? row.Strikeouts ?? 0);
        const starts = Number(row.GamesStarted ?? row.Games ?? row.Appearances ?? 0);
        if (totalK > 0 && starts > 0) return totalK / starts;
        return 0; // treat 0 as "no usable signal"
      } else {
        return Number(row.StrikeoutsPitched ?? row.PitchingStrikeouts ?? row.Strikeouts ?? 0) || 0;
      }
    }

    // Generic hoops props (NBA/WNBA)
    if (p.includes("assist"))  return Number(row.Assists ?? row.AssistsPercentage) || 0;
    if (p.includes("rebound")) return Number(row.Rebounds ?? row.TotalRebounds) || 0;
    if (p.includes("point"))   return Number(row.Points) || 0;

    // NFL example (expand later)
    if (p.includes("passing")) return Number(row.PassingYards) || 0;

    return 0;
  }

  // ---------- Feature builder (tries SportsDataIO first; then historical season; then synthetic) ----------
  async generateFeatures(input) {
    const sport = String(input?.sport || "").toUpperCase();
    this.dataSource = "fallback";
    this.usedEndpoints = [];
    this.matchedName = "";
    this.zeroFiltered = 0;

    // Local date format to avoid UTC day shift
    const fmtLocalDate = (d) => {
      const y = d.getFullYear();
      const m = String(d.getMonth() + 1).padStart(2, '0');
      const day = String(d.getDate()).padStart(2, '0');
      return `${y}-${m}-${day}`;
    };

    let dateStr;
    try {
      const d = input?.startTime ? new Date(input.startTime) : new Date();
      const t = d.getTime();
      if (!Number.isFinite(t)) throw new Error("invalid date");
      dateStr = fmtLocalDate(d);
    } catch {
      dateStr = fmtLocalDate(new Date());
    }
    const seasonYear = new Date(dateStr).getFullYear();

    const acceptValue = (v) => {
      const n = Number(v);
      if (!Number.isFinite(n)) return null;
      if (n <= 0) { this.zeroFiltered += 1; return null; }
      return n;
    };

    // 1) BY-DATE GAME STATS (last ~3 days sweep) → target stat from per-game row
    try {
      if (this.apiClient && this.apiClient.apiKey) {
        const base = new Date(dateStr);
        const datesToTry = [0, -1, -2, -3].map(off => {
          const d = new Date(base);
          d.setDate(d.getDate() + off);
          return fmtLocalDate(d);
        });

        for (const dStr of datesToTry) {
          let stats = null;
          if (sport === "NBA") { this.usedEndpoints.push(`NBA:player-stats-by-date:${dStr}`); stats = await this.apiClient.getNBAPlayerStats(dStr); }
          else if (sport === "WNBA") { this.usedEndpoints.push(`WNBA:player-stats-by-date:${dStr}`); stats = await this.apiClient.getWNBAPlayerStats(dStr); }
          else if (sport === "MLB") { this.usedEndpoints.push(`MLB:player-stats-by-date:${dStr}`); stats = await this.apiClient.getMLBPlayerStats(dStr); }

          if (!Array.isArray(stats) || stats.length === 0) continue;

          // Prefer last-name matches
          let row = stats.find(s => this._preferLastName(input.player, s?.Name));
          if (!row) row = stats.find(s => this._matchByTokens(input.player, s?.Name));
          if (!row) continue;

          const val = acceptValue(this.pickStatFromProp(input.prop, row, sport, /*isSeasonTotals*/ false));
          if (val != null) {
            this.matchedName = String(row.Name || "");
            const variance = Math.max(0.5, Math.abs(val - val * 0.9));
            this.dataSource = "sportsdata";
            return {
              last60Avg: val,
              last30Avg: val,
              last7Avg:  val,
              variance,
              stdDev: Math.sqrt(variance),
              matchupFactor: 1.0,
              minutesFactor: 1.0,
              specific: { adjustment: 0 },
            };
          }
        }
      }
    } catch {/* swallow and continue */}

    // 2) SEASON-TO-DATE (FREE TIER) → per-game average
    try {
      if (this.apiClient && this.apiClient.apiKey) {
        let season = null;
        if (sport === "NBA") { this.usedEndpoints.push(`NBA:player-season-stats:${seasonYear}`); season = await this.apiClient.getNBAPlayerSeasonStats(seasonYear); }
        else if (sport === "WNBA") { this.usedEndpoints.push(`WNBA:player-season-stats:${seasonYear}`); season = await this.apiClient.getWNBAPlayerSeasonStats(seasonYear); }
        else if (sport === "MLB") { this.usedEndpoints.push(`MLB:player-season-stats:${seasonYear}`); season = await this.apiClient.getMLBPlayerSeasonStats(seasonYear); }
        // NFL analog available if you start doing NFL props

        if (Array.isArray(season) && season.length > 0) {
          // Prefer last-name matches first
          let row = season.find(s => this._preferLastName(input.player, s?.Name));
          if (!row) row = season.find(s => this._matchByTokens(input.player, s?.Name));
          if (row) {
            const val = acceptValue(this.pickStatFromProp(input.prop, row, sport, /*isSeasonTotals*/ true));
            if (val != null) {
              this.matchedName = String(row.Name || "");

              // try to enrich variance using up to last 10 non-zero game-by-date values (last 30 days)
              const recentVals = await this._collectRecentGamesForRollingMean(input, sport, dateStr, 30, 10);
              const last30Avg = (recentVals.length > 0)
                ? this.calculateExponentialAverage(recentVals.slice(0, 30), 0.90)
                : val;

              const variance = (recentVals.length >= 3)
                ? this.calculateVariance(recentVals)
                : Math.max(0.5, Math.abs(val - val * 0.9));

              this.dataSource = "sportsdata";
              return {
                last60Avg: last30Avg, // limited by free data — reuse last30Avg
                last30Avg,
                last7Avg:  recentVals.length > 0 ? this.calculateExponentialAverage(recentVals.slice(0, 7), 0.85) : val,
                variance,
                stdDev: Math.sqrt(variance),
                matchupFactor: 1.0,
                minutesFactor: 1.0,
                specific: { adjustment: 0 },
              };
            }
          }
        }
      }
    } catch {/* swallow and continue */}

    // 3) Absolute fallback (synthetic)
    const playerStats = await this.getPlayerHistoricalStats(input.player, sport);
    const opponentStats = await this.getOpponentDefensiveStats(input.opponent, sport);
    const last30Avg = this.calculateExponentialAverage(playerStats.last30, 0.90);
    const last7Avg  = this.calculateExponentialAverage(playerStats.last7, 0.85);
    const variance  = this.calculateVariance(playerStats.recent);
    return {
      last60Avg: this.calculateExponentialAverage(playerStats.last60, 0.95),
      last30Avg,
      last7Avg,
      variance,
      stdDev: Math.sqrt(variance),
      matchupFactor: this.calculateMatchupFactor(opponentStats, sport, input.prop),
      minutesFactor: this.calculateMinutesFactor(input.workload, sport),
      specific: { adjustment: 0 }
    };
  }

  // Collect up to `takeN` non-zero per-game values over `lookbackDays`
  async _collectRecentGamesForRollingMean(input, sport, anchorDateStr, lookbackDays = 30, takeN = 10) {
    if (!(this.apiClient && this.apiClient.apiKey)) return [];
    const fmtLocalDate = (d) => {
      const y = d.getFullYear();
      const m = String(d.getMonth() + 1).padStart(2, '0');
      const day = String(d.getDate()).padStart(2, '0');
      return `${y}-${m}-${day}`;
    };
    const base = new Date(anchorDateStr);
    const vals = [];
    for (let off = -1; off >= -lookbackDays; off--) {
      const d = new Date(base);
      d.setDate(d.getDate() + off);
      const ds = fmtLocalDate(d);

      let stats = null;
      if (sport === "NBA") { this.usedEndpoints.push(`NBA:player-stats-by-date:${ds}`); stats = await this.apiClient.getNBAPlayerStats(ds); }
      else if (sport === "WNBA") { this.usedEndpoints.push(`WNBA:player-stats-by-date:${ds}`); stats = await this.apiClient.getWNBAPlayerStats(ds); }
      else if (sport === "MLB") { this.usedEndpoints.push(`MLB:player-stats-by-date:${ds}`); stats = await this.apiClient.getMLBPlayerStats(ds); }

      if (!Array.isArray(stats) || stats.length === 0) continue;

      let row = stats.find(s => this._preferLastName(input.player, s?.Name));
      if (!row) row = stats.find(s => this._matchByTokens(input.player, s?.Name));
      if (!row) continue;

      const v = this.pickStatFromProp(input.prop, row, sport, false);
      const n = Number(v);
      if (Number.isFinite(n) && n > 0) vals.push(n);
      if (vals.length >= takeN) break;
    }
    return vals;
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

    const sigma = Math.max(0.8, Number(features.stdDev) || 1.0);

    const propText = String(input.prop || "").toLowerCase();
    let p;
    if (String(input.sport || "").toUpperCase() === "MLB" && propText.includes("strikeout")) {
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
    if ((features?.stdDev || 0) > 4) {
      adjustedProb -= this.thresholds.VARIANCE_PENALTY;
      flags.push("HIGH_VARIANCE");
    }

    return { adjustedProb: clamp01(adjustedProb), flags };
  }

  // ---------- Calibration + Fusion ----------
  applyCalibration(prob) {
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
        zeroFiltered: this.zeroFiltered
      }
    };
  }
}

// ---------- helpers ----------
function clamp01(x) { return Math.max(0, Math.min(1, Number.isFinite(x) ? x : 0)); }
function round2(x) { return Math.round((Number(x) || 0) * 100) / 100; }
function round3(x) { return Math.round((Number(x) || 0) * 1000) / 1000; }
