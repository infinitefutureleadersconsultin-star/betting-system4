// lib/engines/playerPropsEngine.js
import { StatisticalModels } from "../statisticalModels.js";

const SMART = String(process.env.SMART_OVERLAYS || "").toUpperCase() === "ON";

// ---------- tiny helpers ----------
function clamp01(x) { return Math.max(0, Math.min(1, Number.isFinite(x) ? x : 0)); }
function round2(x) { return Math.round((Number(x) || 0) * 100) / 100; }
function round3(x) { return Math.round((Number(x) || 0) * 1000) / 1000; }

// format local date (avoid UTC day-shift that breaks *ByDate endpoints)
function fmtLocalDate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export class PlayerPropsEngine {
  constructor(apiClient) {
    this.apiClient = apiClient || null;       // may be null; we fallback gracefully
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

    // numeric factor name must NOT collide with any method name
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

  // -------- Stat picker per sport/prop (single source of truth) --------
  _pickValueFromRow(sport, prop, row) {
    const p = String(prop || "").toLowerCase();
    const s = String(sport || "").toUpperCase();

    if (s === "MLB") {
      // For pitcher K props we must read PITCHING Ks, not batter strikeouts.
      // SportsDataIO field for pitcher Ks is usually "PitcherStrikeouts".
      if (p.includes("strikeout")) {
        const k = Number(row.PitcherStrikeouts);
        if (Number.isFinite(k)) return k;
        // Rare alt naming seen in some feeds:
        const alt = Number(row.StrikeoutsPitched);
        if (Number.isFinite(alt)) return alt;
        // Avoid batter strikeouts (row.Strikeouts) — that is hitter K'd.
        return NaN;
      }
      return NaN;
    }

    if (s === "NBA" || s === "WNBA") {
      if (p.includes("assist"))   return Number(row.Assists);
      if (p.includes("rebound"))  return Number(row.Rebounds);
      return NaN;
    }

    if (s === "NFL") {
      if (p.includes("passing") && p.includes("yard")) {
        return Number(row.PassingYards);
      }
      return NaN;
    }

    return NaN;
  }

  // -------- season per-game value (uses *PerGame if present; else totals/Games) --------
  _pickSeasonPerGame(sport, prop, row) {
    const s = String(sport || "").toUpperCase();
    const p = String(prop || "").toLowerCase();

    if (s === "MLB" && p.includes("strikeout")) {
      const tot = Number(row.PitcherStrikeouts);
      const starts = Number(row.GamesStarted || row.Games || 0);
      if (Number.isFinite(tot) && starts > 0) return tot / starts;
      return NaN;
    }

    if ((s === "NBA" || s === "WNBA") && (p.includes("assist") || p.includes("rebound"))) {
      const keyPG = p.includes("assist") ? "AssistsPerGame" : "ReboundsPerGame";
      const keyTot = p.includes("assist") ? "Assists" : "Rebounds";
      const per = Number(row[keyPG]);
      if (Number.isFinite(per)) return per;
      const tot = Number(row[keyTot]);
      const g = Number(row.Games || row.GamesPlayed || 0);
      if (Number.isFinite(tot) && g > 0) return tot / g;
      return NaN;
    }

    if (s === "NFL" && p.includes("passing") && p.includes("yard")) {
      const per = Number(row.PassingYardsPerGame);
      if (Number.isFinite(per)) return per;
      const tot = Number(row.PassingYards);
      const g = Number(row.Games || row.GamesPlayed || 0);
      if (Number.isFinite(tot) && g > 0) return tot / g;
      return NaN;
    }

    return NaN;
  }

  // -------- collect recent by-date/period values (pitcher-only for MLB) --------
  async _collectRecentGamesForRollingMean(input, sport, dateStr, windowDays = 30, maxGames = 10) {
    const s = String(sport || "").toUpperCase();
    const nameTokens = String(input.player || "").toLowerCase().split(/\s+/).filter(Boolean);
    const nameMatches = (candidate) => {
      const cand = String(candidate || "").toLowerCase();
      return nameTokens.some(tok => cand.includes(tok));
    };

    const vals = [];
    this.zeroFiltered = 0;

    // Iterate back in time across days (MLB/NBA/WNBA) — NFL uses weekly; see below
    if (s === "MLB" || s === "NBA" || s === "WNBA") {
      let base = new Date(dateStr);
      for (let i = 0; i < windowDays && vals.length < maxGames; i++) {
        const d = new Date(base);
        d.setDate(d.getDate() - i);
        const dStr = fmtLocalDate(d);

        let stats = null;
        if (s === "MLB" && this.apiClient?.getMLBPlayerStats) {
          stats = await this.apiClient.getMLBPlayerStats(dStr);
          this.usedEndpoints.push(`MLB:player-stats-by-date:${dStr}`);
        } else if (s === "NBA" && this.apiClient?.getNBAPlayerStats) {
          stats = await this.apiClient.getNBAPlayerStats(dStr);
          this.usedEndpoints.push(`NBA:player-stats-by-date:${dStr}`);
        } else if (s === "WNBA" && this.apiClient?.getWNBAPlayerStatsByDate) {
          stats = await this.apiClient.getWNBAPlayerStatsByDate(dStr);
          this.usedEndpoints.push(`WNBA:player-stats-by-date:${dStr}`);
        }

        if (Array.isArray(stats) && stats.length) {
          // pick the row by name, then stat by prop
          let row = stats.find(r => nameMatches(r?.Name));
          if (!row) continue;

          // MLB: insist on pitcher rows (avoid hitter stat rows)
          if (s === "MLB") {
            const pos = String(row.Position || row.PositionCategory || "").toUpperCase();
            const isPitcherLike = pos.includes("P"); // SP/RP/P
            if (!isPitcherLike) continue;
          }

          const v = this._pickValueFromRow(s, input.prop, row);
          if (!Number.isFinite(v)) continue;

          // Optional filter zeros? (we count them separately for your meta)
          if (v === 0) {
            this.zeroFiltered += 1;
            // keep zeros anyway to reflect real volatility:
            vals.push(0);
          } else {
            vals.push(v);
          }
        }
      }
      return vals;
    }

    // NFL recent — requires by-week pulls; if not configured, fallback to empty
    if (s === "NFL") {
      // If you wire in season/week here, you can loop weeks and push values similar to above.
      // For now (graceful), we return [] and rely more on season per-game for NFL.
      return vals;
    }

    return vals;
  }

  // ---------- Feature builder (tries SportsDataIO, falls back safely) ----------
  async generateFeatures(input) {
    const sport = String(input?.sport || "").toUpperCase();
    const features = {};
    this.dataSource = "fallback";
    this.usedEndpoints = [];
    this.matchedName = "";
    this.zeroFiltered = 0;
    this.recentValsCount = 0;
    this.recentSample = [];

    // Robust local-date parsing (never throws)
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
        // ---------- Season per-game ----------
        let seasonPerGame = NaN;
        const seasonYear = new Date().getFullYear(); // basic guess; SDIO has helpers to query current
        if (sport === "MLB" && this.apiClient.getMLBPlayerSeasonStats) {
          const season = await this.apiClient.getMLBPlayerSeasonStats(seasonYear);
          this.usedEndpoints.push(`MLB:player-season-stats:${seasonYear}`);
          if (Array.isArray(season)) {
            const row = season.find(r => String(r?.Name || "").toLowerCase().includes(String(input.player || "").split(" ")[0].toLowerCase()));
            if (row) {
              this.matchedName = String(row.Name || "");
              seasonPerGame = this._pickSeasonPerGame(sport, input.prop, row);
            }
          }
        } else if (sport === "NBA" && this.apiClient.getNBAPlayerSeasonStats) {
          const season = await this.apiClient.getNBAPlayerSeasonStats(seasonYear);
          this.usedEndpoints.push(`NBA:player-season-stats:${seasonYear}`);
          if (Array.isArray(season)) {
            const row = season.find(r => String(r?.Name || "").toLowerCase().includes(String(input.player || "").split(" ")[0].toLowerCase()));
            if (row) {
              this.matchedName = String(row.Name || "");
              seasonPerGame = this._pickSeasonPerGame(sport, input.prop, row);
            }
          }
        } else if (sport === "WNBA" && this.apiClient.getWNBAPlayerSeasonStats) {
          const season = await this.apiClient.getWNBAPlayerSeasonStats(seasonYear);
          this.usedEndpoints.push(`WNBA:player-season-stats:${seasonYear}`);
          if (Array.isArray(season)) {
            const row = season.find(r => String(r?.Name || "").toLowerCase().includes(String(input.player || "").split(" ")[0].toLowerCase()));
            if (row) {
              this.matchedName = String(row.Name || "");
              seasonPerGame = this._pickSeasonPerGame(sport, input.prop, row);
            }
          }
        } else if (sport === "NFL" && this.apiClient.getNFLPlayerSeasonStats) {
          const season = await this.apiClient.getNFLPlayerSeasonStats(seasonYear);
          this.usedEndpoints.push(`NFL:player-season-stats:${seasonYear}`);
          if (Array.isArray(season)) {
            const row = season.find(r => String(r?.Name || "").toLowerCase().includes(String(input.player || "").split(" ")[0].toLowerCase()));
            if (row) {
              this.matchedName = String(row.Name || "");
              seasonPerGame = this._pickSeasonPerGame(sport, input.prop, row);
            }
          }
        }

        // ---------- Recent by-date sample ----------
        const recentVals = await this._collectRecentGamesForRollingMean(input, sport, dateStr, 31, 10);
        this.recentValsCount = recentVals.length;
        this.recentSample = Array.isArray(recentVals) ? recentVals.slice(0, 10) : [];

        // ---------- Blend ----------
        const haveRecent = recentVals.length > 0;
        const recentMean = haveRecent
          ? recentVals.reduce((a, b) => a + b, 0) / recentVals.length
          : (Number.isFinite(seasonPerGame) ? seasonPerGame : NaN);

        // If we have neither, drop to fallback below
        if (Number.isFinite(recentMean) || Number.isFinite(seasonPerGame)) {
          const baseMu = Number.isFinite(recentMean) ? (0.6 * recentMean + 0.4 * (Number.isFinite(seasonPerGame) ? seasonPerGame : recentMean)) : seasonPerGame;

          // Variance: use sample if we have 3+; otherwise a conservative floor
          let variance = (recentVals.length >= 3)
            ? this.calculateVariance(recentVals)
            : Math.max(1.4, Math.abs(baseMu - baseMu * 0.9)); // ≥ ~1.4 as a safety floor

          // MLB K: sigma bounds to avoid overconfidence/insanity
          let sigma = Math.sqrt(variance);
          if (sport === "MLB" && String(input.prop || "").toLowerCase().includes("strikeout")) {
            sigma = Math.max(1.2, Math.min(sigma, 3.5));
            variance = sigma * sigma;
          }

          this.dataSource = "sportsdata";
          return {
            last60Avg: baseMu,
            last30Avg: baseMu,
            last7Avg:  haveRecent ? this.calculateExponentialAverage(recentVals.slice(0, 7), 0.85) : baseMu,
            variance,
            stdDev: Math.sqrt(variance),
            matchupFactor: 1.0,
            minutesFactor: 1.0,
            specific: { adjustment: 0 },
          };
        }
      }

      // ---------- Fallback synthetic features ----------
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

    // Base sigma from features
    let sigma = Math.max(0.8, Number(features.stdDev) || 1.0);

    // MLB strikeouts → Poisson; keep sigma constraints already applied in feature gen
    const propText = String(input.prop || "").toLowerCase();
    const sport = String(input.sport || "").toUpperCase();
    let probability;

    if (sport === "MLB" && propText.includes("strikeout")) {
      probability = StatisticalModels.calculatePoissonProbability(mu, line);
    } else {
      // NBA/WNBA rebounds/assists, NFL passing yards → Normal with continuity correction
      // Add gentle caps to sigma to avoid razor-thin tails
      if (sport === "NFL" && propText.includes("passing") && propText.includes("yard")) {
        sigma = Math.max(15, Math.min(sigma, 90)); // NFL passing yard volatility bounds (rough)
      }
      probability = StatisticalModels.calculateNormalProbability(mu, sigma, line);
    }

    return { probability: clamp01(probability), expectedValue: mu, stdDev: sigma, line };
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
      startTime: inputRaw?.startTime || fmtLocalDate(new Date()),
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
