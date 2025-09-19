// lib/engines/playerPropsEngine.js
import { StatisticalModels } from "../statisticalModels.js";

const SMART = String(process.env.SMART_OVERLAYS || "").toUpperCase() === "ON";

export class PlayerPropsEngine {
  constructor(apiClient) {
    this.apiClient = apiClient || null; // may be null; we fallback gracefully

    // telemetry
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

    // numeric factor must NOT collide with method name
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

  fmtLocalDate(d) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
  }

  // ---------- Stat key mapper ----------
  pickStatFromProp(prop, row, { sport = "", hint = "" } = {}) {
    const p = String(prop || "").toLowerCase();
    const sp = String(sport || "").toUpperCase();

    // MLB: strikeouts
    if (sp === "MLB" && p.includes("strikeout")) {
      if (hint.includes("season")) {
        return Number(row?.Strikeouts) || 0;
      }
      return (
        Number(row?.StrikeoutsPitched) ||
        Number(row?.PitchingStrikeouts) ||
        Number(row?.Strikeouts) ||
        0
      );
    }

    // NBA/ WNBA: rebounds / assists
    if ((sp === "NBA" || sp === "WNBA")) {
      if (p.includes("rebound")) return Number(row?.Rebounds) || 0;
      if (p.includes("assist"))  return Number(row?.Assists) || 0;
    }

    // NFL: passing yards
    if (sp === "NFL" && p.includes("passing")) {
      // season: PassingYards (aggregate)
      if (hint.includes("season")) return Number(row?.PassingYards) || 0;
      // per-game rows
      return Number(row?.PassingYards) || 0;
    }

    // generic fallbacks:
    if (p.includes("assist"))  return Number(row?.Assists) || 0;
    if (p.includes("rebound")) return Number(row?.Rebounds) || 0;
    if (p.includes("point"))   return Number(row?.Points) || 0;
    if (p.includes("yard"))    return Number(row?.PassingYards) || 0;

    return 0;
  }

  // ---------- Feature builder (SportsDataIO first; fallback if needed) ----------
  async generateFeatures(input) {
    this.usedEndpoints = [];
    this.matchedName = "";
    this.zeroFiltered = 0;
    this.recentValsCount = 0;
    this.recentSample = [];

    const sport = String(input?.sport || "").toUpperCase();
    const features = {};
    this.dataSource = "fallback";

    // robust local date parsing
    let dateStr;
    try {
      const d = input?.startTime ? new Date(input.startTime) : new Date();
      const t = d.getTime();
      if (!Number.isFinite(t)) throw new Error("invalid date");
      dateStr = this.fmtLocalDate(d);
    } catch {
      dateStr = this.fmtLocalDate(new Date());
    }

    if (this.apiClient && this.apiClient.apiKey) {
      try {
        if (sport === "MLB") {
          return await this._featuresMLB(input, dateStr);
        }
        if (sport === "NBA" || sport === "WNBA") {
          return await this._featuresNBA_WNBA(input, dateStr, sport);
        }
        if (sport === "NFL") {
          return await this._featuresNFL(input, dateStr);
        }
      } catch {
        // swallow and continue to fallback
      }
    }

    // ===== Fallback synthetic (keeps engine alive) =====
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
  }

  // ======== SPORT-SPECIFIC FEATURE BUILDERS ========

  // ---------- MLB (strikeouts) ----------
  async _featuresMLB(input, dateStr) {
    const nameTokens = String(input.player || "").toLowerCase().split(/\s+/).filter(Boolean);
    const nameMatches = (candidate) => String(candidate || "").toLowerCase()
      .split(/\s+/).some(tok => nameTokens.includes(tok));

    // Projections (may fail on free plan)
    for (const off of [0, -1]) {
      const d = new Date(dateStr); d.setDate(d.getDate() + off);
      const dStr = this.fmtLocalDate(d);
      const proj = await this.apiClient.getMLBPlayerProjectionsByDate(dStr);
      this.usedEndpoints.push(`MLB:player-projections-by-date:${dStr}`);
      if (Array.isArray(proj) && proj.length) {
        const hit = proj.find(r => nameMatches(r?.Name));
        if (hit && !this.matchedName) this.matchedName = String(hit.Name || "");
      }
    }

    // Recent by-date (pitching-only), last 30d up to 10 games
    const recentVals = await this._collectRecentMLB(input, dateStr, 30, 10);
    this.recentValsCount = recentVals.length;
    this.recentSample = recentVals.slice(0, 10);

    // Season per-start avg
    const season = dateStr.slice(0, 4);
    const seasonRows = await this.apiClient.getMLBPlayerSeasonStats(season);
    this.usedEndpoints.push(`MLB:player-season-stats:${season}`);
    let seasonAvg = null;
    if (Array.isArray(seasonRows) && seasonRows.length) {
      const row = seasonRows.find(r => {
        const full = String(r?.Name || "").toLowerCase();
        const want = String(input.player || "").toLowerCase();
        return full === want || nameMatches(r?.Name);
      });
      if (row) {
        this.matchedName = this.matchedName || String(row.Name || "");
        const totalKs = Number(row?.Strikeouts) || 0;
        const gs = Number(row?.GamesStarted) || 0;
        const g = Number(row?.Games) || 0;
        const denom = gs > 0 ? gs : (g > 0 ? g : 1);
        seasonAvg = totalKs / denom;
      }
    }

    return this._blendFeatures(input, "MLB", recentVals, seasonAvg);
  }

  async _collectRecentMLB(input, anchorDateStr, daysBack = 30, maxGames = 10) {
    const out = [];
    const anchor = new Date(anchorDateStr);
    const nameTokens = String(input.player || "").toLowerCase().split(/\s+/).filter(Boolean);
    const nameMatches = (candidate) => String(candidate || "").toLowerCase()
      .split(/\s+/).some(tok => nameTokens.includes(tok));

    for (let i = 0; i < daysBack && out.length < maxGames; i++) {
      const d = new Date(anchor);
      d.setDate(d.getDate() - i);
      const dStr = this.fmtLocalDate(d);
      const rows = await this.apiClient.getMLBPlayerStats(dStr);
      this.usedEndpoints.push(`MLB:player-stats-by-date:${dStr}`);
      if (!Array.isArray(rows) || rows.length === 0) continue;

      const row = rows.find(r => nameMatches(r?.Name));
      if (!row) continue;

      // Only games actually pitched
      const ip = Number(row?.InningsPitched) || 0;
      if (ip <= 0) { this.zeroFiltered++; continue; }

      const val = this.pickStatFromProp(input.prop, row, { sport: "MLB" });
      if (Number.isFinite(val)) out.push(val);
    }
    return out;
  }

  // ---------- NBA / WNBA (rebounds / assists) ----------
  async _featuresNBA_WNBA(input, dateStr, sport) {
    const nameTokens = String(input.player || "").toLowerCase().split(/\s+/).filter(Boolean);
    const nameMatches = (candidate) => String(candidate || "").toLowerCase()
      .split(/\s+/).some(tok => nameTokens.includes(tok));

    // collect recent N=8 games from by-date (past 14 days is usually enough)
    const recentVals = [];
    const anchor = new Date(dateStr);
    for (let i = 0; i < 14 && recentVals.length < 8; i++) {
      const d = new Date(anchor);
      d.setDate(d.getDate() - i);
      const dStr = this.fmtLocalDate(d);
      const rows = sport === "NBA"
        ? await this.apiClient.getNBAPlayerStats(dStr)
        : await this.apiClient.getWNBAPlayerStats(dStr);
      this.usedEndpoints.push(`${sport}:player-stats-by-date:${dStr}`);
      if (!Array.isArray(rows) || rows.length === 0) continue;

      const row = rows.find(r => nameMatches(r?.Name));
      if (!row) continue;

      const val = this.pickStatFromProp(input.prop, row, { sport });
      if (Number.isFinite(val)) recentVals.push(val);
      if (!this.matchedName && row?.Name) this.matchedName = String(row.Name);
    }
    this.recentValsCount = recentVals.length;
    this.recentSample = recentVals.slice(0, 8);

    // season stats → per-game
    const season = dateStr.slice(0, 4);
    const seasonRows = (sport === "NBA")
      ? await this.apiClient.getNBAPlayerSeasonStats(season)
      : await this.apiClient.getWNBAPlayerSeasonStats(season);
    this.usedEndpoints.push(`${sport}:player-season-stats:${season}`);

    let seasonAvg = null;
    if (Array.isArray(seasonRows) && seasonRows.length) {
      const row = seasonRows.find(r => {
        const full = String(r?.Name || "").toLowerCase();
        const want = String(input.player || "").toLowerCase();
        return full === want || full.includes(want.split(" ")[0]);
      });
      if (row) {
        if (!this.matchedName && row?.Name) this.matchedName = String(row.Name);

        // stat extract from season row
        seasonAvg = this.pickStatFromProp(input.prop, row, { sport, hint: "season" });
        // if seasonAvg still 0 and stat names differ, try common alternates
        if (!Number.isFinite(seasonAvg) || seasonAvg === 0) {
          if (String(input.prop).toLowerCase().includes("rebound"))
            seasonAvg = Number(row?.Rebounds) || Number(row?.ReboundsPerGame) || 0;
          if (String(input.prop).toLowerCase().includes("assist"))
            seasonAvg = Number(row?.Assists) || Number(row?.AssistsPerGame) || 0;
        }
      }
    }

    return this._blendFeatures(input, sport, recentVals, seasonAvg, { nbaLike: true });
  }

  // ---------- NFL (passing yards) ----------
  async _featuresNFL(input, dateStr) {
    const nameLC = String(input.player || "").toLowerCase();

    // Try to learn current season & week for recents
    let seasonKey = null; // e.g., "2025REG"
    let currentSeason = await this.apiClient.getNFLCurrentSeason();
    if (typeof currentSeason === "number") {
      seasonKey = `${currentSeason}REG`;
      this.usedEndpoints.push(`NFL:current-season:${currentSeason}`);
    }
    let week = await this.apiClient.getNFLCurrentWeek();
    if (typeof week === "number") {
      this.usedEndpoints.push(`NFL:current-week:${week}`);
    }

    // Season stats first (free plans often allow this)
    let seasonAvg = null;
    if (seasonKey) {
      const seasonRows = await this.apiClient.getNFLPlayerSeasonStats(seasonKey);
      this.usedEndpoints.push(`NFL:player-season-stats:${seasonKey}`);
      if (Array.isArray(seasonRows) && seasonRows.length) {
        const row = seasonRows.find(r => {
          const full = String(r?.Name || "").toLowerCase();
          return full === nameLC || full.includes(nameLC.split(" ")[0]);
        });
        if (row) {
          if (!this.matchedName && row?.Name) this.matchedName = String(row.Name);
          const py = this.pickStatFromProp(input.prop, row, { sport: "NFL", hint: "season" });
          const gs = Number(row?.Started) || Number(row?.GamesStarted) || 0;
          const g  = Number(row?.Games) || 0;
          const denom = gs > 0 ? gs : (g > 0 ? g : 1);
          seasonAvg = (Number(py) || 0) / denom;
        }
      }
    }

    // Recent weeks (attempt last up to 4 weeks)
    const recentVals = [];
    if (seasonKey && typeof week === "number") {
      for (let w = week; w >= Math.max(1, week - 4); w--) {
        const rows = await this.apiClient.getNFLPlayerStatsByWeek(seasonKey, w);
        this.usedEndpoints.push(`NFL:player-stats-by-week:${seasonKey}-${w}`);
        if (!Array.isArray(rows) || rows.length === 0) continue;
        const row = rows.find(r => {
          const full = String(r?.Name || "").toLowerCase();
          return full === nameLC || full.includes(nameLC.split(" ")[0]);
        });
        if (!row) continue;

        // QBs typically have attempts/position; if present, filter to QB or attempts > 0
        const pos = String(row?.Position || "").toUpperCase();
        const att = Number(row?.PassingAttempts) || 0;
        if (pos && pos !== "QB" && att === 0) continue;

        const val = this.pickStatFromProp(input.prop, row, { sport: "NFL" });
        if (Number.isFinite(val)) recentVals.push(val);
        if (!this.matchedName && row?.Name) this.matchedName = String(row.Name);
      }
    }

    this.recentValsCount = recentVals.length;
    this.recentSample = recentVals.slice(0, 4);
    return this._blendFeatures(input, "NFL", recentVals, seasonAvg, { nflLike: true });
  }

  // ---------- Common blender ----------
  _blendFeatures(input, sport, recentVals, seasonAvg, opts = {}) {
    const hasRecent = Array.isArray(recentVals) && recentVals.length > 0;
    const muRecent = hasRecent
      ? recentVals.reduce((a, b) => a + b, 0) / recentVals.length
      : (Number(seasonAvg) || 0);

    const blendedMu = (hasRecent && (seasonAvg != null))
      ? (0.6 * muRecent + 0.4 * seasonAvg)
      : (hasRecent ? muRecent : (Number(seasonAvg) || 0));

    // variance: from sample when >=3, else sport-specific floor
    let variance;
    if (hasRecent && recentVals.length >= 3) {
      variance = this.calculateVariance(recentVals);
    } else {
      // conservative floors per sport / stat family
      if (sport === "MLB") variance = Math.max(1.4, Math.abs(blendedMu - blendedMu * 0.9));
      else if (sport === "NFL") variance = Math.max(80, Math.abs(blendedMu - blendedMu * 0.8)); // yards
      else variance = Math.max(1.0, Math.abs(blendedMu - blendedMu * 0.85)); // NBA/WNBA rebs/asts
    }

    this.dataSource = "sportsdata";
    return {
      last60Avg: blendedMu,
      last30Avg: blendedMu,
      last7Avg: hasRecent ? this.calculateExponentialAverage(recentVals.slice(0, 7), 0.85) : blendedMu,
      variance,
      stdDev: Math.sqrt(variance),
      matchupFactor: 1.0,
      minutesFactor: 1.0,
      specific: { adjustment: 0 },
    };
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

    // σ guards + sport/prop clamps
    let sigma = Math.max(1.0, Number(features.stdDev) || 1.2);

    const sp = String(input.sport || "").toUpperCase();
    const propText = String(input.prop || "").toLowerCase();

    if (sp === "MLB" && propText.includes("strikeout")) {
      sigma = Math.max(1.2, Math.min(sigma, 3.5));
    }
    if ((sp === "NBA" || sp === "WNBA") && (propText.includes("rebound") || propText.includes("assist"))) {
      sigma = Math.max(1.0, Math.min(sigma, 4.5));
    }
    if (sp === "NFL" && propText.includes("passing")) {
      sigma = Math.max(40, Math.min(sigma, 120)); // yards
    }

    let p;
    if (sp === "MLB" && propText.includes("strikeout")) {
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
      return 0.03 * direction; // ±3% toward model
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

  steamDetectionNudge() {
    if (!SMART) return 0;
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
    if ((features?.stdDev || 0) > 4 && (String(input.sport || "").toUpperCase() !== "NFL")) {
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

    // robust: even if feature gen throws, continue with safe defaults
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

    // small bounded nudges
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

  // ======= Fallback synthetic =======
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
