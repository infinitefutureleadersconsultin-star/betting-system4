// lib/engines/playerPropsEngine.js
import { StatisticalModels } from "../statisticalModels.js";

const SMART = String(process.env.SMART_OVERLAYS || "").toUpperCase() === "ON";

export class PlayerPropsEngine {
  constructor(apiClient) {
    this.apiClient = apiClient || null;

    // diagnostics & meta
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

  // ---------- Local date helper (avoid UTC day-shift) ----------
  fmtLocalDate(d) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }

  // ---------- Name matching ----------
  _nameTokens(name) {
    return String(name || "").toLowerCase().split(/\s+/).filter(Boolean);
  }
  _candidateMatches(tokens, candidate) {
    const cand = String(candidate || "").toLowerCase();
    return tokens.some(t => cand.includes(t));
  }

  // ---------- MLB helpers: identify pitching rows & extract Ks ----------
  _isPitchingRowMLB(row) {
    if (!row || typeof row !== "object") return false;
    if (String(row.PositionCategory || row.Position || "").toUpperCase().startsWith("P")) return true;
    if (Number(row.InningsPitchedDecimal) > 0) return true;
    if ("StrikeoutsPitched" in row) return true;
    if ("PitchingStrikeouts" in row) return true;
    if ("PitcherStrikeouts" in row) return true;
    return false;
  }
  _pitcherKsFromRow(row) {
    const candidates = [
      row?.StrikeoutsPitched,
      row?.PitchingStrikeouts,
      row?.PitcherStrikeouts,
    ];
    for (const v of candidates) {
      const n = Number(v);
      if (Number.isFinite(n)) return n;
    }
    return null;
  }

  // ---------- NBA/WNBA helpers ----------
  _extractNBAWNBAStat(row, statKind) {
    // try common names + alternates
    if (statKind === "rebounds") {
      const candidates = [row?.Rebounds, row?.TotalRebounds, row?.ReboundsTotal];
      for (const v of candidates) { const n = Number(v); if (Number.isFinite(n)) return n; }
    }
    if (statKind === "assists") {
      const candidates = [row?.Assists, row?.AssistsTotal];
      for (const v of candidates) { const n = Number(v); if (Number.isFinite(n)) return n; }
    }
    return null;
  }

  // ---------- NFL helpers ----------
  _isQBRowNFL(row) {
    const pos = String(row?.Position || row?.PositionCategory || "").toUpperCase();
    return pos.includes("QB") || "PassingYards" in (row || {});
  }
  _qbPassingYardsFromRow(row) {
    const candidates = [row?.PassingYards, row?.PassingYardsGross, row?.PassingYardsNet];
    for (const v of candidates) { const n = Number(v); if (Number.isFinite(n)) return n; }
    return null;
  }
  _inferNFLSeasonWeek(dateStr) {
    // Approximate NFL season + week from date (good enough for recent weeks)
    const d = new Date(dateStr);
    let season = d.getFullYear();
    const month = d.getMonth() + 1;
    if (month < 3) season = season - 1; // Jan/Feb belong to previous season
    // Week 1 ~ first Thursday after Sep 1
    const sep1 = new Date(season, 8, 1);
    // find first Thursday >= Sep 1
    const firstThu = new Date(sep1);
    while (firstThu.getDay() !== 4) firstThu.setDate(firstThu.getDate() + 1);
    const diffDays = Math.floor((d - firstThu) / 86400000);
    let week = Math.max(1, Math.min(22, Math.floor(diffDays / 7) + 1));
    return { season, week };
  }

  // ---------- collectors ----------
  async _collectRecentPitchingKsByDateMLB(dateStr, playerTokens, dayWindow = 45, maxGames = 10) {
    const out = [];
    try {
      const base = new Date(dateStr);
      for (let i = 0; i < dayWindow && out.length < maxGames; i++) {
        const d = new Date(base);
        d.setDate(d.getDate() - i);
        const dStr = this.fmtLocalDate(d);

        if (this.apiClient && typeof this.apiClient.getMLBPlayerStats === "function") {
          const stats = await this.apiClient.getMLBPlayerStats(dStr);
          this.usedEndpoints.push(`MLB:player-stats-by-date:${dStr}`);

          if (Array.isArray(stats) && stats.length) {
            const rows = stats.filter(r => this._candidateMatches(playerTokens, r?.Name));
            for (const r of rows) {
              if (!this._isPitchingRowMLB(r)) continue;
              const k = this._pitcherKsFromRow(r);
              if (k == null) continue;
              out.push(Number(k));
              if (!this.matchedName) this.matchedName = String(r.Name || "");
              break;
            }
          }
        }
      }
    } catch {}
    return out;
  }

  async _collectRecentByDateNBAWNBA(dateStr, sport, playerTokens, statKind, dayWindow = 30, maxGames = 10) {
    const out = [];
    try {
      const base = new Date(dateStr);
      for (let i = 0; i < dayWindow && out.length < maxGames; i++) {
        const d = new Date(base);
        d.setDate(d.getDate() - i);
        const dStr = this.fmtLocalDate(d);

        let stats = null;
        if (sport === "NBA" && this.apiClient?.getNBAPlayerStats) {
          stats = await this.apiClient.getNBAPlayerStats(dStr);
          this.usedEndpoints.push(`NBA:player-stats-by-date:${dStr}`);
        } else if (sport === "WNBA" && this.apiClient?.getWNBAPlayerStats) {
          stats = await this.apiClient.getWNBAPlayerStats(dStr);
          this.usedEndpoints.push(`WNBA:player-stats-by-date:${dStr}`);
        }

        if (Array.isArray(stats) && stats.length) {
          const row = stats.find(r => this._candidateMatches(playerTokens, r?.Name));
          if (!row) continue;
          const v = this._extractNBAWNBAStat(row, statKind);
          if (v == null) continue;
          out.push(Number(v));
          if (!this.matchedName) this.matchedName = String(row.Name || "");
        }
      }
    } catch {}
    return out;
  }

  async _collectRecentPassingYdsNFL(dateStr, playerTokens, maxGames = 8) {
    const out = [];
    try {
      const { season, week } = this._inferNFLSeasonWeek(dateStr);

      const tryWeeks = [];
      for (let i = 0; i < 6; i++) {
        const w = week - i;
        if (w >= 1) tryWeeks.push({ season, week: w });
      }

      for (const { season: s, week: w } of tryWeeks) {
        if (!this.apiClient?.getNFLPlayerStats) break;
        const stats = await this.apiClient.getNFLPlayerStats(s, w);
        this.usedEndpoints.push(`NFL:player-stats-by-week:${s}-${w}`);
        if (Array.isArray(stats) && stats.length) {
          const rows = stats.filter(r => this._candidateMatches(playerTokens, r?.Name));
          for (const r of rows) {
            if (!this._isQBRowNFL(r)) continue;
            const y = this._qbPassingYardsFromRow(r);
            if (y == null) continue;
            out.push(Number(y));
            if (!this.matchedName) this.matchedName = String(r.Name || "");
            if (out.length >= maxGames) break;
          }
        }
        if (out.length >= maxGames) break;
      }
    } catch {}
    return out;
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

    // Robust local date parsing
    let dateStr;
    try {
      const d = input?.startTime ? new Date(input.startTime) : new Date();
      const t = d.getTime();
      if (!Number.isFinite(t)) throw new Error("invalid date");
      dateStr = this.fmtLocalDate(d);
    } catch {
      dateStr = this.fmtLocalDate(new Date());
    }

    const propText = String(input?.prop || "").toLowerCase();
    const tokens = this._nameTokens(input.player);
    const seasonStr = dateStr.slice(0, 4);

    // ---------- MLB: Strikeouts ----------
    if (sport === "MLB" && propText.includes("strikeout")) {
      try {
        const recentVals = await this._collectRecentPitchingKsByDateMLB(dateStr, tokens, 45, 10);
        this.recentValsCount = recentVals.length;
        this.recentSample = recentVals.slice(0, 10);

        let seasonAvg = null;
        if (this.apiClient?.getMLBPlayerSeasonStats) {
          const seasonData = await this.apiClient.getMLBPlayerSeasonStats(seasonStr);
          this.usedEndpoints.push(`MLB:player-season-stats:${seasonStr}`);
          if (Array.isArray(seasonData) && seasonData.length) {
            const row = seasonData.find(r => this._candidateMatches(tokens, r?.Name) && this._isPitchingRowMLB(r));
            if (row) {
              const ks = Number(row.PitchingStrikeouts ?? row.PitcherStrikeouts ?? row.StrikeoutsPitched ?? row.Strikeouts);
              const starts = Number(row.GamesStarted ?? row.GamesPitched ?? row.Games ?? 0);
              if (Number.isFinite(ks) && starts > 0) {
                seasonAvg = ks / starts;
                if (!this.matchedName) this.matchedName = String(row.Name || "");
              }
            }
          }
        }

        const baseline = 4.0;
        const recentMean = recentVals.length > 0
          ? recentVals.reduce((a, b) => a + b, 0) / recentVals.length
          : (seasonAvg ?? baseline);
        const blendedMu =
          (seasonAvg != null) ? 0.6 * recentMean + 0.4 * seasonAvg : recentMean;

        const variance =
          (recentVals.length >= 3) ? this.calculateVariance(recentVals)
                                   : Math.max(1.4, Math.abs(blendedMu - blendedMu * 0.9));

        this.dataSource = "sportsdata";
        return {
          last60Avg: blendedMu,
          last30Avg: blendedMu,
          last7Avg: recentVals.length > 0 ? this.calculateExponentialAverage(recentVals.slice(0, 7), 0.85) : blendedMu,
          variance,
          stdDev: Math.sqrt(variance),
          matchupFactor: 1.0,
          minutesFactor: 1.0,
          specific: { adjustment: 0 },
        };
      } catch {
        // fall back
      }
    }

    // ---------- NBA & WNBA: Rebounds / Assists ----------
    if ((sport === "NBA" || sport === "WNBA") && (propText.includes("rebound") || propText.includes("assist"))) {
      try {
        const statKind = propText.includes("rebound") ? "rebounds" : "assists";
        const recentVals = await this._collectRecentByDateNBAWNBA(dateStr, sport, tokens, statKind, 30, 10);
        this.recentValsCount = recentVals.length;
        this.recentSample = recentVals.slice(0, 10);

        let seasonAvg = null;
        const getSeason = sport === "NBA" ? this.apiClient?.getNBAPlayerSeasonStats : this.apiClient?.getWNBAPlayerSeasonStats;
        if (getSeason) {
          const seasonData = await getSeason.call(this.apiClient, seasonStr);
          this.usedEndpoints.push(`${sport}:player-season-stats:${seasonStr}`);
          if (Array.isArray(seasonData) && seasonData.length) {
            const row = seasonData.find(r => this._candidateMatches(tokens, r?.Name));
            if (row) {
              const totalGames = Number(row?.Games ?? row?.GamesPlayed ?? 0);
              let total = null;
              if (statKind === "rebounds") {
                total = Number(row?.Rebounds ?? row?.TotalRebounds ?? row?.ReboundsTotal);
              } else {
                total = Number(row?.Assists ?? row?.AssistsTotal);
              }
              if (Number.isFinite(total) && totalGames > 0) {
                seasonAvg = total / totalGames;
                if (!this.matchedName) this.matchedName = String(row.Name || "");
              }
            }
          }
        }

        const baseline = statKind === "rebounds" ? 6.0 : 4.0;
        const recentMean = recentVals.length > 0
          ? recentVals.reduce((a, b) => a + b, 0) / recentVals.length
          : (seasonAvg ?? baseline);
        const blendedMu =
          (seasonAvg != null) ? 0.6 * recentMean + 0.4 * seasonAvg : recentMean;

        // σ ranges for NBA/WNBA counting stats
        let variance = (recentVals.length >= 3) ? this.calculateVariance(recentVals)
                                               : Math.max(1.2, Math.abs(blendedMu - blendedMu * 0.85));
        let sigma = Math.sqrt(variance);
        // keep σ within sane limits
        if (statKind === "rebounds") sigma = Math.max(1.5, Math.min(sigma, 6.0));
        if (statKind === "assists")  sigma = Math.max(1.2, Math.min(sigma, 5.0));

        this.dataSource = "sportsdata";
        return {
          last60Avg: blendedMu,
          last30Avg: blendedMu,
          last7Avg: recentVals.length > 0 ? this.calculateExponentialAverage(recentVals.slice(0, 7), 0.85) : blendedMu,
          variance: sigma * sigma,
          stdDev: sigma,
          matchupFactor: 1.0,
          minutesFactor: 1.0,
          specific: { adjustment: 0 },
        };
      } catch {
        // fall back
      }
    }

    // ---------- NFL: Passing Yards ----------
    if (sport === "NFL" && (propText.includes("pass") || propText.includes("passing"))) {
      try {
        const recentVals = await this._collectRecentPassingYdsNFL(dateStr, tokens, 8);
        this.recentValsCount = recentVals.length;
        this.recentSample = recentVals.slice(0, 8);

        let seasonAvg = null;
        if (this.apiClient?.getNFLPlayerSeasonStats) {
          const { season } = this._inferNFLSeasonWeek(dateStr);
          const seasonData = await this.apiClient.getNFLPlayerSeasonStats(season);
          this.usedEndpoints.push(`NFL:player-season-stats:${season}`);
          if (Array.isArray(seasonData) && seasonData.length) {
            const row = seasonData.find(r => this._candidateMatches(tokens, r?.Name) && this._isQBRowNFL(r));
            if (row) {
              const yds = Number(row?.PassingYards ?? row?.PassingYardsGross ?? row?.PassingYardsNet);
              const games = Number(row?.Games ?? row?.GamesPlayed ?? row?.Played ?? 0);
              if (Number.isFinite(yds) && games > 0) {
                seasonAvg = yds / games;
                if (!this.matchedName) this.matchedName = String(row.Name || "");
              }
            }
          }
        }

        const baseline = 225;
        const recentMean = recentVals.length > 0
          ? recentVals.reduce((a, b) => a + b, 0) / recentVals.length
          : (seasonAvg ?? baseline);
        const blendedMu =
          (seasonAvg != null) ? 0.6 * recentMean + 0.4 * seasonAvg : recentMean;

        let variance = (recentVals.length >= 3) ? this.calculateVariance(recentVals)
                                               : Math.max(400, Math.abs(blendedMu - blendedMu * 0.8) ** 2);
        let sigma = Math.sqrt(variance);
        sigma = Math.max(15, Math.min(sigma, 120)); // NFL passing yards sanity

        this.dataSource = "sportsdata";
        return {
          last60Avg: blendedMu,
          last30Avg: blendedMu,
          last7Avg: recentVals.length > 0 ? this.calculateExponentialAverage(recentVals.slice(0, 7), 0.85) : blendedMu,
          variance: sigma * sigma,
          stdDev: sigma,
          matchupFactor: 1.0,
          minutesFactor: 1.0,
          specific: { adjustment: 0 },
        };
      } catch {
        // fall back
      }
    }

    // ---------- Generic fallback ----------
    try {
      const playerStats = await this.getPlayerHistoricalStats(input.player, sport);
      const opponentStats = await this.getOpponentDefensiveStats(input.opponent, sport);
      const last60Avg = this.calculateExponentialAverage(playerStats.last60, 0.95);
      const last30Avg = this.calculateExponentialAverage(playerStats.last30, 0.90);
      const last7Avg  = this.calculateExponentialAverage(playerStats.last7, 0.85);
      const variance  = this.calculateVariance(playerStats.recent);
      return {
        last60Avg,
        last30Avg,
        last7Avg,
        variance,
        stdDev: Math.sqrt(variance),
        matchupFactor: this.calculateMatchupFactor(opponentStats, sport, input.prop),
        minutesFactor: this.calculateMinutesFactor(input.workload, sport),
        specific: { adjustment: 0 },
      };
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
        specific: { adjustment: 0 },
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

    // σ baseline
    let sigma = Math.max(1.0, Number(features.stdDev) || 1.2);

    // MLB Ks tuning
    const propText = String(input.prop || "").toLowerCase();
    if (String(input.sport || "").toUpperCase() === "MLB" && propText.includes("strikeout")) {
      sigma = Math.max(1.2, Math.min(sigma, 3.5));
    }

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

    const finalConfidence = Math.round(fused * 1000) / 10; // 0.1%

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

  // ---------- dummy fallbacks ----------
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
}

// ---------- helpers ----------
function clamp01(x) { return Math.max(0, Math.min(1, Number.isFinite(x) ? x : 0)); }
function round2(x) { return Math.round((Number(x) || 0) * 100) / 100; }
function round3(x) { return Math.round((Number(x) || 0) * 1000) / 1000; }
