// lib/engines/playerPropsEngine.js
import { StatisticalModels } from "../statisticalModels.js";

const SMART = String(process.env.SMART_OVERLAYS || "").toUpperCase() === "ON";

export class PlayerPropsEngine {
  constructor(apiClient) {
    this.apiClient = apiClient || null;
    this.errorFlags = [];
    this.dataSource = "fallback";
    this._usedEndpoints = [];
    this._matchedName = "";
    this._zeroFiltered = 0;

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

  // ---------- name helpers ----------
  normalizeName(s) {
    return String(s || '')
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }
  makeNameMatcher(targetFull) {
    const norm = this.normalizeName(targetFull);
    const tokens = norm.split(' ').filter(Boolean);
    const last = tokens[tokens.length - 1] || '';
    return (candidate) => {
      const c = ` ${this.normalizeName(candidate)} `;
      const ok = c.includes(` ${last} `) || tokens.some(t => c.includes(` ${t} `));
      if (ok) this._matchedName = candidate || "";
      return ok;
    };
  }

  // ---------- tolerant numeric extraction ----------
  numericFromAny(row, keys, regexIfMissing) {
    for (const k of keys) {
      const v = row?.[k];
      if (v !== undefined && v !== null && v !== '' && isFinite(Number(v))) return Number(v);
    }
    if (regexIfMissing) {
      const re = regexIfMissing;
      for (const k of Object.keys(row || {})) {
        if (re.test(k)) {
          const v = row[k];
          if (v !== undefined && v !== null && v !== '' && isFinite(Number(v))) return Number(v);
        }
      }
    }
    return undefined;
  }

  /** Return undefined for MLB Ks if value is 0 — we treat that as “no valid data”. */
  pickStatFromProp(prop, row, sport) {
    const p = String(prop || "").toLowerCase();

    if (sport === "MLB" && p.includes("strikeout")) {
      const keys = [
        "StrikeoutsPitched", "PitcherStrikeouts", "Strikeouts",
        "PitchingStrikeouts", "StrikeoutsPitching", "Ks", "ProjectedPitcherStrikeouts"
      ];
      const v = this.numericFromAny(row, keys, /strikeout/i);
      if (Number.isFinite(v) && v > 0) return v;   // accept only positive Ks
      this._zeroFiltered += Number(v === 0);       // count zeros for debugging
      return undefined;
    }

    if (p.includes("assist")) {
      const v = this.numericFromAny(row, ["Assists"], /assist/i);
      return Number.isFinite(v) ? v : undefined;
    }
    if (p.includes("rebound")) {
      const v = this.numericFromAny(row, ["Rebounds", "TotalRebounds"], /rebound/i);
      return Number.isFinite(v) ? v : undefined;
    }
    if (p.includes("point")) {
      const v = this.numericFromAny(row, ["Points"], /point/i);
      return Number.isFinite(v) ? v : undefined;
    }
    if (p.includes("passing")) {
      const v = this.numericFromAny(row, ["PassingYards"], /passing.*yard/i);
      return Number.isFinite(v) ? v : undefined;
    }
    return undefined;
  }

  // ---------- Feature builder (projections → by-date stats → season stats) ----------
  async generateFeatures(input) {
    const sport = String(input?.sport || "").toUpperCase();
    const features = {};
    this.dataSource = "fallback";
    this._usedEndpoints = [];
    this._matchedName = "";
    this._zeroFiltered = 0;

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

    try {
      if (this.apiClient && this.apiClient.apiKey) {
        const match = this.makeNameMatcher(input.player);

        const base = new Date(dateStr);
        const datesToTry = [0, -1].map(off => {
          const d = new Date(base);
          d.setDate(d.getDate() + off);
          return fmtLocalDate(d);
        });

        let row = null;
        let statGuess;

        for (const dStr of datesToTry) {
          if (sport === "MLB") {
            this._usedEndpoints.push(`MLB:player-projections-by-date:${dStr}`);
            let list = await this.apiClient.getMLBPlayerProjections(dStr);
            if (Array.isArray(list)) {
              row = list.find(s => match(s?.Name));
              statGuess = row ? this.pickStatFromProp(input.prop, row, sport) : undefined;
              if (Number.isFinite(statGuess) && statGuess > 0) {
                this.dataSource = "sportsdata";
                return this._featuresFromPoint(statGuess);
              }
            }

            this._usedEndpoints.push(`MLB:player-stats-by-date:${dStr}`);
            list = await this.apiClient.getMLBPlayerStats(dStr);
            if (Array.isArray(list)) {
              row = list.find(s => match(s?.Name));
              statGuess = row ? this.pickStatFromProp(input.prop, row, sport) : undefined;
              if (Number.isFinite(statGuess) && statGuess > 0) {
                this.dataSource = "sportsdata";
                return this._featuresFromPoint(statGuess);
              }
            }
          }

          else if (sport === "NBA") {
            this._usedEndpoints.push(`NBA:player-projections-by-date:${dStr}`);
            let list = await this.apiClient.getNBAPlayerProjections(dStr);
            if (Array.isArray(list)) {
              row = list.find(s => match(s?.Name));
              statGuess = row ? this.pickStatFromProp(input.prop, row, sport) : undefined;
              if (Number.isFinite(statGuess)) {
                this.dataSource = "sportsdata";
                return this._featuresFromPoint(statGuess);
              }
            }

            this._usedEndpoints.push(`NBA:player-stats-by-date:${dStr}`);
            list = await this.apiClient.getNBAPlayerStats(dStr);
            if (Array.isArray(list)) {
              row = list.find(s => match(s?.Name));
              statGuess = row ? this.pickStatFromProp(input.prop, row, sport) : undefined;
              if (Number.isFinite(statGuess)) {
                this.dataSource = "sportsdata";
                return this._featuresFromPoint(statGuess);
              }
            }
          }

          else if (sport === "WNBA") {
            this._usedEndpoints.push(`WNBA:player-season-stats`);
            const list = await this.apiClient.getWNBAPlayerStats();
            if (Array.isArray(list)) {
              row = list.find(s => match(s?.Name));
              statGuess = row ? this.pickStatFromProp(input.prop, row, sport) : undefined;
              if (Number.isFinite(statGuess)) {
                this.dataSource = "sportsdata";
                return this._featuresFromPoint(statGuess);
              }
            }
          }
        }

        // Season fallback (MLB/NBA) — compute per-game from totals, ignore zeros
        if (!Number.isFinite(statGuess) || !(statGuess > 0)) {
          if (sport === "MLB") {
            const season = new Date(dateStr).getFullYear();
            this._usedEndpoints.push(`MLB:player-season-stats:${season}`);
            const list = await this.apiClient.getMLBPlayerSeasonStats(season);
            if (Array.isArray(list)) {
              const r = list.find(s => match(s?.Name));
              if (r) {
                const total = this.pickStatFromProp(input.prop, r, sport); // will ignore zero
                const apps = Number(r?.GamesStarted || r?.Games || r?.Appearances || 0);
                if (Number.isFinite(total) && total > 0 && apps > 0) {
                  const per = total / apps;
                  this.dataSource = "sportsdata";
                  return this._featuresFromPoint(per);
                }
              }
            }
          } else if (sport === "NBA") {
            const season = new Date(dateStr).getFullYear();
            this._usedEndpoints.push(`NBA:player-season-stats:${season}`);
            const list = await this.apiClient.getNBAPlayerSeasonStats(season);
            if (Array.isArray(list)) {
              const r = list.find(s => match(s?.Name));
              if (r) {
                const total = this.pickStatFromProp(input.prop, r, sport);
                const g = Number(r?.Games || r?.GamesPlayed || 0);
                if (Number.isFinite(total) && g > 0) {
                  const per = (Number(total) || 0) / g;
                  this.dataSource = "sportsdata";
                  return this._featuresFromPoint(per);
                }
              }
            }
          }
        }
      }

      // Fallback synthetic features
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
      // absolute safety valve
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

  _featuresFromPoint(statGuess) {
    const variance = Math.max(0.5, Math.abs(statGuess - statGuess * 0.9));
    return {
      last60Avg: statGuess,
      last30Avg: statGuess,
      last7Avg:  statGuess,
      variance,
      stdDev: Math.sqrt(variance),
      matchupFactor: 1.0,
      minutesFactor: 1.0,
      specific: { adjustment: 0 }
    };
  }

  // ---------- Modeling ----------
  calculateStatisticalProbability(features, input) {
    const line = this.extractLineFromProp(input.prop);
    let mu =
      (Number(features.last30Avg) || 0) *
      (Number(features.matchupFactor) || 1) *
      (Number(features.minutesFactor) || 1);
    if (features?.specific?.adjustment) mu += Number(features.specific.adjustment) || 0;

    const sigma = Math.max(0.8, Number(features.stdDev) || 1.0);
    const propText = String(input.prop || "").toLowerCase();

    let p;
    if (String(input.sport || "").toUpperCase() === "MLB" && propText.includes("strikeout")) {
      p = StatisticalModels.calculatePoissonProbability(mu, line);
    } else {
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
  workloadGuardrail(input, features) {
    if (!SMART) return 0;
    const w = String(input?.workload || "").toLowerCase();
    if (!w || w.includes("low") || w.includes("?")) return -0.03;
    if ((features?.stdDev || 0) > 4) return -0.02;
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
  steamDetectionNudge() { if (!SMART) return 0; return 0; }

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
    if ((features?.stdDev || 0) > 4) {
      adjustedProb -= this.thresholds.VARIANCE_PENALTY;
      flags.push("HIGH_VARIANCE");
    }
    return { adjustedProb: clamp01(adjustedProb), flags };
  }

  // ---------- Calibration + Fusion ----------
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

    let features;
    try {
      features = await this.generateFeatures(input);
    } catch {
      features = {
        last60Avg: 0, last30Avg: 0, last7Avg: 0,
        variance: 1, stdDev: 1, matchupFactor: 1, minutesFactor: 1,
        specific: { adjustment: 0 },
      };
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
      stat.probability, market.marketProbability, 0, nudgesTotal
    );

    const finalConfidence = Math.round(fused * 1000) / 10;

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
        usedEndpoints: Array.isArray(this._usedEndpoints) ? this._usedEndpoints : [],
        matchedName: this._matchedName || "",
        zeroFiltered: this._zeroFiltered || 0
      }
    };
  }
}

// ---------- helpers ----------
function clamp01(x) { return Math.max(0, Math.min(1, Number.isFinite(x) ? x : 0)); }
function round2(x) { return Math.round((Number(x) || 0) * 100) / 100; }
function round3(x) { return Math.round((Number(x) || 0) * 1000) / 1000; }
