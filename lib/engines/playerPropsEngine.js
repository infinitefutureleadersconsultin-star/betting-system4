// lib/engines/playerPropsEngine.js
import { StatisticalModels } from "../statisticalModels.js";

const SMART = String(process.env.SMART_OVERLAYS || "").toUpperCase() === "ON";

export class PlayerPropsEngine {
  constructor(apiClient) {
    this.apiClient = apiClient || null; // may be null; we fallback gracefully

    // Diagnostics / meta
    this.errorFlags = [];
    this.dataSource = "fallback";
    this.usedEndpoints = [];
    this.matchedName = "";
    this.zeroFiltered = 0;
    this.recentValsCount = 0;
    this.recentSample = [];

    // Decision thresholds (slightly eased for practical grading)
    this.thresholds = {
      LOCK_CONFIDENCE: 0.72,  // was 0.70
      STRONG_LEAN:    0.66,   // was 0.675
      LEAN:           0.60,   // was 0.65
      HOOK_BUFFER:    0.05,
      VARIANCE_PENALTY: 0.05,
      NAME_INFLATION:   0.03,
      PROJECTION_GAP_TRIGGER: 0.15, // 15%
    };

    // Post-fusion calibration scalar (learn later; kept neutral now)
    this.calibrationFactor = 1.0;
  }

  // ---------- Utilities ----------
  _pushEndpoint(tag) {
    try { this.usedEndpoints.push(String(tag)); } catch {}
  }

  _fmtLocalDate(d) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
  }

  _nameTokens(str) {
    return String(str || "").toLowerCase().split(/\s+/).filter(Boolean);
  }

  _nameMatches(candidate, target) {
    const c = this._nameTokens(candidate);
    const t = this._nameTokens(target);
    if (t.length === 0 || c.length === 0) return false;
    // Prefer full token coverage (first + last); otherwise any token.
    const all = t.every(tok => c.includes(tok));
    if (all) return true;
    return t.some(tok => c.includes(tok));
  }

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
    // Synthetic fallback to keep engine alive with no live data
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

  // pick stat value by sport+prop from a row (SportsDataIO fields)
  _pickStatFromRow(sport, prop, row) {
    const p = String(prop || "").toLowerCase();
    const s = String(sport || "").toUpperCase();

    // MLB: pitcher strikeouts (by-date row fields commonly: StrikeoutsPitched)
    if (s === "MLB" && p.includes("strikeout")) {
      // ignore zero K on clear DNP/no pitching (attempt)
      const ip = Number(row.InningsPitched ?? row.PitchingInningsPitched ?? row.Innings ?? 0);
      const ks = Number(row.StrikeoutsPitched ?? row.PitchingStrikeouts ?? row.Strikeouts ?? 0);
      const started = Number(row.GamesStarted ?? row.Games ?? 0);
      if (ks === 0 && (ip === 0 || started === 0)) {
        this.zeroFiltered++;
        return null;
      }
      return Number.isFinite(ks) ? ks : null;
    }

    // NBA/WNBA: rebounds & assists
    if ((s === "NBA" || s === "WNBA")) {
      if (p.includes("rebound")) {
        const r = Number(row.Rebounds ?? row.TotalRebounds ?? row.Reb ?? 0);
        return Number.isFinite(r) ? r : null;
      }
      if (p.includes("assist")) {
        const a = Number(row.Assists ?? row.Ast ?? 0);
        return Number.isFinite(a) ? a : null;
      }
      // default: points if user enters points
      if (p.includes("point")) {
        const pts = Number(row.Points ?? row.Pts ?? 0);
        return Number.isFinite(pts) ? pts : null;
      }
    }

    // NFL: passing yards
    if (s === "NFL" && (p.includes("passing") || p.includes("pass"))) {
      const yds = Number(row.PassingYards ?? row.PassYards ?? 0);
      return Number.isFinite(yds) ? yds : null;
    }

    return null;
  }

  _trimOutliers(arr, alpha = 0.10) {
    if (!Array.isArray(arr) || arr.length < 5) return arr || [];
    const a = [...arr].sort((x, y) => x - y);
    const cut = Math.floor(a.length * alpha);
    return a.slice(cut, a.length - cut);
  }

  // Try by-date pulls over a window and build a recent sample
  async _collectRecentGamesForRollingMean(input, sport, anchorDateStr, lookbackDays, maxGames) {
    const out = [];
    const base = new Date(anchorDateStr);
    const player = String(input.player || "");
    let matchedName = "";
    for (let off = 0; off >= -lookbackDays && out.length < maxGames; off--) {
      const d = new Date(base);
      d.setDate(d.getDate() + off);
      const dStr = this._fmtLocalDate(d);

      let rows = null;
      if (sport === "MLB" && this.apiClient?.getMLBPlayerStats) {
        rows = await this.apiClient.getMLBPlayerStats(dStr) || [];
        this._pushEndpoint(`MLB:player-stats-by-date:${dStr}`);
      } else if (sport === "NBA" && this.apiClient?.getNBAPlayerStats) {
        rows = await this.apiClient.getNBAPlayerStats(dStr) || [];
        this._pushEndpoint(`NBA:player-stats-by-date:${dStr}`);
      } else if (sport === "WNBA") {
        // Prefer by-date if available in your plan; otherwise season-only fallback
        if (typeof this.apiClient?.getWNBAPlayerStatsByDate === "function") {
          rows = await this.apiClient.getWNBAPlayerStatsByDate(dStr) || [];
          this._pushEndpoint(`WNBA:player-stats-by-date:${dStr}`);
        } else {
          // Season stats fallback handled outside this loop
        }
      } else if (sport === "NFL") {
        // NFL often provides by-week not by-date; handle via season outside this loop
      }

      if (Array.isArray(rows) && rows.length) {
        // pick the matching player row
        const row = rows.find(r => this._nameMatches(r?.Name, player));
        if (row) {
          if (!this.matchedName) this.matchedName = String(row.Name || "");
          matchedName = this.matchedName;

          const val = this._pickStatFromRow(sport, input.prop, row);
          if (val != null) out.push(Number(val));
        }
      }
    }
    this.recentValsCount = out.length;
    this.recentSample = out.slice(0, maxGames);
    if (matchedName) this.matchedName = matchedName;
    return out;
  }

  async _seasonPerGameAvg(sport, seasonYear, player, prop) {
    // Attempt a season stats pull and derive per-game average for the requested stat
    try {
      let rows = null;
      if (sport === "MLB" && typeof this.apiClient?.getMLBPlayerSeasonStats === "function") {
        rows = await this.apiClient.getMLBPlayerSeasonStats(seasonYear) || [];
        this._pushEndpoint(`MLB:player-season-stats:${seasonYear}`);
      } else if (sport === "NBA" && typeof this.apiClient?.getNBAPlayerSeasonStats === "function") {
        rows = await this.apiClient.getNBAPlayerSeasonStats(seasonYear) || [];
        this._pushEndpoint(`NBA:player-season-stats:${seasonYear}`);
      } else if (sport === "WNBA" && typeof this.apiClient?.getWNBAPlayerSeasonStats === "function") {
        rows = await this.apiClient.getWNBAPlayerSeasonStats(seasonYear) || [];
        this._pushEndpoint(`WNBA:player-season-stats:${seasonYear}`);
      } else if (sport === "NFL" && typeof this.apiClient?.getNFLPlayerSeasonStats === "function") {
        rows = await this.apiClient.getNFLPlayerSeasonStats(seasonYear) || [];
        this._pushEndpoint(`NFL:player-season-stats:${seasonYear}`);
      }

      if (!Array.isArray(rows) || rows.length === 0) return null;

      // find name
      const row = rows.find(r => this._nameMatches(r?.Name, player));
      if (!row) return null;
      if (!this.matchedName) this.matchedName = String(row.Name || "");

      const s = String(sport || "").toUpperCase();
      const p = String(prop || "").toLowerCase();

      let total = null, games = null;

      if (s === "MLB" && p.includes("strikeout")) {
        total = Number(row.PitchingStrikeouts ?? row.Strikeouts ?? row.StrikeoutsPitched ?? null);
        games = Number(row.GamesPitched ?? row.GamesStarted ?? row.Games ?? null);
      } else if ((s === "NBA" || s === "WNBA") && p.includes("rebound")) {
        total = Number(row.Rebounds ?? row.TotalRebounds ?? null);
        games = Number(row.Games ?? null);
      } else if ((s === "NBA" || s === "WNBA") && p.includes("assist")) {
        total = Number(row.Assists ?? null);
        games = Number(row.Games ?? null);
      } else if (s === "NFL" && (p.includes("passing") || p.includes("pass"))) {
        total = Number(row.PassingYards ?? null);
        games = Number(row.Games ?? row.GamesPlayed ?? null);
      }

      if (!Number.isFinite(total) || !Number.isFinite(games) || games <= 0) return null;
      return total / games;
    } catch {
      return null;
    }
  }

  // ---------- Feature builder (tries SportsDataIO first, falls back safely) ----------
  async generateFeatures(input) {
    const sport = String(input?.sport || "").toUpperCase();
    const features = {};
    this.dataSource = "fallback";
    this.usedEndpoints = [];
    this.matchedName = "";
    this.zeroFiltered = 0;
    this.recentValsCount = 0;
    this.recentSample = [];

    // Robust local-date parsing (no UTC day-shift, never throws)
    let dateStr;
    try {
      const d = input?.startTime ? new Date(input.startTime) : new Date();
      const t = d.getTime();
      if (!Number.isFinite(t)) throw new Error("invalid date");
      dateStr = this._fmtLocalDate(d);
    } catch {
      dateStr = this._fmtLocalDate(new Date());
    }
    const seasonYear = Number(dateStr.slice(0, 4)) || new Date().getFullYear();

    try {
      if (this.apiClient && this.apiClient.apiKey) {
        // Build a recent sample from by-date stats (where available)
        const recentVals = await this._collectRecentGamesForRollingMean(
          input, sport, dateStr,
          sport === "NFL" ? 0 : 30,     // NFL handled via season (by-week not wired here)
          sport === "MLB" ? 10 : 8      // cap sample size
        );

        // Season per-game average (soft dependency)
        const seasonAvg = await this._seasonPerGameAvg(sport, seasonYear, input.player, input.prop);

        // Choose a baseline if seasonAvg not available
        const baselineBySport = (sp, prop) => {
          const s = sp.toUpperCase(); const p = prop.toLowerCase();
          if (s === "MLB" && p.includes("strikeout")) return 5.0;
          if ((s === "NBA" || s === "WNBA") && p.includes("rebound")) return 6.0;
          if ((s === "NBA" || s === "WNBA") && p.includes("assist")) return 4.0;
          if (s === "NFL" && (p.includes("passing") || p.includes("pass"))) return 225.0;
          return 5.0;
        };

        // Prepare final sample & blend
        let sample = recentVals;
        if (sport === "MLB") {
          // For MLB Ks, trim tails; ignore zero K games we flagged as likely DNP
          sample = this._trimOutliers(recentVals, 0.10);
        }

        const recentMean = (sample.length > 0)
          ? sample.reduce((a, b) => a + b, 0) / sample.length
          : (seasonAvg ?? baselineBySport(sport, input.prop));

        // Heavier recent weight
        const blendedMu = (seasonAvg != null) ? 0.7 * recentMean + 0.3 * seasonAvg : recentMean;

        // Variance from sample if we have >=3; otherwise conservative floor per stat class
        let variance =
          (sample.length >= 3) ? this.calculateVariance(sample)
                               : Math.max(1.44, Math.abs(blendedMu - blendedMu * 0.9)); // >= 1.2^2
        let sigma = Math.sqrt(variance);

        // Clamp sigma by stat type to avoid razor-thin or absurdly huge values
        const propText = String(input.prop || "").toLowerCase();
        if (sport === "MLB" && propText.includes("strikeout")) {
          sigma = Math.max(1.2, Math.min(sigma, 3.0));
        } else if ((sport === "NBA" || sport === "WNBA") && (propText.includes("rebound") || propText.includes("assist"))) {
          sigma = Math.max(1.0, Math.min(sigma, 6.0));
        } else if (sport === "NFL" && (propText.includes("passing") || propText.includes("pass"))) {
          sigma = Math.max(20, Math.min(sigma, 120));
        }
        variance = sigma * sigma;

        this.dataSource = "sportsdata";
        return {
          last60Avg: blendedMu,
          last30Avg: blendedMu,
          last7Avg:  (sample.length > 0) ? this.calculateExponentialAverage(sample.slice(0, 7), 0.85) : blendedMu,
          variance,
          stdDev: sigma,
          matchupFactor: 1.0,
          minutesFactor: 1.0,
          specific: { adjustment: 0 },
        };
      }

      // Fallback synthetic features (no API key or no data)
      const playerStats = await this.getPlayerHistoricalStats(input.player, sport);
      const opponentStats = await this.getOpponentDefensiveStats(input.opponent, sport);
      features.last60Avg = this.calculateExponentialAverage(playerStats.last60, 0.95);
      features.last30Avg = this.calculateExponentialAverage(playerStats.last30, 0.90);
      features.last7Avg  = this.calculateExponentialAverage(playerStats.last7, 0.85);
      features.variance  = this.calculateVariance(playerStats.recent);
      features.stdDev    = Math.sqrt(features.variance);
      features.matchupFactor = this.calculateMatchupFactor(opponentStats, sport, input.prop);
      features.minutesFactor = this.calculateMinutesFactor(input.workload, sport);
      features.specific = { adjustment: 0 };
      return features;

    } catch {
      // Absolute safety valve
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

    let sigma = Math.max(0.8, Number(features.stdDev) || 1.0);

    const propText = String(input.prop || "").toLowerCase();
    const sport = String(input.sport || "").toUpperCase();

    // Clamp σ by stat class (mirrors generateFeatures caps)
    if (sport === "MLB" && propText.includes("strikeout")) {
      sigma = Math.max(1.2, Math.min(sigma, 3.0));
    } else if ((sport === "NBA" || sport === "WNBA") && (propText.includes("rebound") || propText.includes("assist"))) {
      sigma = Math.max(1.0, Math.min(sigma, 6.0));
    } else if (sport === "NFL" && (propText.includes("passing") || propText.includes("pass"))) {
      sigma = Math.max(20, Math.min(sigma, 120));
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
    if ((features?.stdDev || 0) > 4) {
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
        recentSample: this.recentSample || [],
      }
    };
  }
}

// ---------- helpers (module local) ----------
function clamp01(x) { return Math.max(0, Math.min(1, Number.isFinite(x) ? x : 0)); }
function round2(x) { return Math.round((Number(x) || 0) * 100) / 100; }
function round3(x) { return Math.round((Number(x) || 0) * 1000) / 1000; }
