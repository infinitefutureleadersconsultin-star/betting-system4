// lib/engines/playerPropsEngine.js
import { StatisticalModels } from "../statisticalModels.js";

const SMART = String(process.env.SMART_OVERLAYS || "").toUpperCase() === "ON";

// ---------- tiny helpers ----------
const clamp01 = (x) => Math.max(0, Math.min(1, Number.isFinite(+x) ? +x : 0));
const round2 = (x) => Math.round((Number(x) || 0) * 100) / 100;
const round3 = (x) => Math.round((Number(x) || 0) * 1000) / 1000;

function fmtLocalDate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
function _uniqPush(arr, v) { if (!arr.includes(v)) arr.push(v); }

// Name matcher: require all tokens (order-agnostic)
function nameMatcherFactory(targetName) {
  const tokens = String(targetName || "")
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
  return (candidate) => {
    const c = String(candidate || "").toLowerCase();
    return tokens.length > 0 && tokens.every((t) => c.includes(t));
  };
}

// STRICT: per-game pitcher strikeouts; avoid batting/rate bleed
function _mlbStrikeoutsFromRow(row) {
  const fields = ["PitchingStrikeouts", "PitcherStrikeouts", "StrikeoutsPitched"];
  for (const k of fields) {
    const v = Number(row?.[k]);
    if (Number.isFinite(v)) return v;
  }
  // Derive from K/9 only if IP present
  const k9 =
    Number.isFinite(Number(row?.PitchingStrikeoutsPerNine))
      ? Number(row?.PitchingStrikeoutsPerNine)
      : Number(row?.StrikeoutsPerNine);
  const ip =
    Number(row?.PitchingInningsPitchedDecimal) ??
    Number(row?.InningsPitchedDecimal) ??
    Number(row?.InningsPitched);
  if (Number.isFinite(k9) && Number.isFinite(ip) && ip > 0) {
    const k = (k9 * ip) / 9;
    if (Number.isFinite(k)) return k;
  }
  return NaN; // never use batting "Strikeouts"
}

// Conservative variance helper
function safeVariance(arr, floor = 1.4) {
  if (!Array.isArray(arr) || arr.length === 0) return floor;
  const xs = arr.map((x) => Number(x) || 0);
  const mu = xs.reduce((a, b) => a + b, 0) / xs.length;
  const v = xs.reduce((a, x) => a + (x - mu) ** 2, 0) / xs.length;
  return Math.max(floor, v);
}

export class PlayerPropsEngine {
  constructor(apiClient) {
    this.apiClient = apiClient || null;

    // meta / diagnostics
    this.dataSource = "fallback";
    this.usedEndpoints = [];
    this.matchedName = "";
    this.zeroFiltered = 0;
    this.recentValsCount = 0;
    this.recentSample = [];
    this.debug = { fallbackReason: null, lastHttp: null };

    this.thresholds = {
      LOCK_CONFIDENCE: 0.70,
      STRONG_LEAN: 0.675,
      LEAN: 0.65,
      HOOK_BUFFER: 0.05,
      VARIANCE_PENALTY: 0.05,
      NAME_INFLATION: 0.03,
      PROJECTION_GAP_TRIGGER: 0.15,  // 15%
      MIN_RECENT_GAMES: 3,
    };

    this.calibrationFactor = 1.0;
  }

  // ---------- utilities ----------
  validateInput(input) {
    // non-fatal; we continue with defaults
    return !!input;
  }

  extractLineFromProp(prop) {
    const m = String(prop || "").match(/(-?\d+(\.\d+)?)/);
    return m ? parseFloat(m[1]) : 0;
  }

  calculateExponentialAverage(arr, decay) {
    if (!Array.isArray(arr) || arr.length === 0) return 0;
    let wsum = 0, wtot = 0;
    for (let i = 0; i < arr.length; i++) {
      const w = Math.pow(decay, i);
      wsum += (Number(arr[i]) || 0) * w;
      wtot += w;
    }
    return wtot > 0 ? wsum / wtot : 0;
  }

  calculateVariance(arr) { return safeVariance(arr, 1.4); }
  calculateMatchupFactor() { return 1.0; }
  calculateMinutesFactor() { return 1.0; }

  // ---------- stat selection per sport/prop ----------
  pickValueFromRow(sport, prop, row) {
    const s = String(sport || "").toUpperCase();
    const p = String(prop || "").toLowerCase();

    if (s === "MLB") {
      if (p.includes("strikeout")) return _mlbStrikeoutsFromRow(row);
      return NaN;
    }
    if (s === "NBA" || s === "WNBA") {
      if (p.includes("rebound")) return Number(row?.Rebounds) ?? Number(row?.ReboundsTotal) ?? NaN;
      if (p.includes("assist"))  return Number(row?.Assists) ?? NaN;
      if (p.includes("point"))   return Number(row?.Points) ?? NaN;
      return NaN;
    }
    if (s === "NFL") {
      if (p.includes("passing")) return Number(row?.PassingYards) ?? NaN;
      return NaN;
    }
    return NaN;
  }

  // season per-game from a season row
  seasonPerGameFromRow(sport, prop, row) {
    if (!row) return NaN;
    const s = String(sport || "").toUpperCase();
    const p = String(prop || "").toLowerCase();

    if (s === "MLB" && p.includes("strikeout")) {
      const totalKs = Number(row?.PitchingStrikeouts ?? row?.StrikeoutsPitched ?? row?.PitcherStrikeouts ?? NaN);
      const gs = Number(row?.GamesStarted);
      const gp = Number(row?.Games ?? row?.GamesPitched);
      const denom = Number.isFinite(gs) && gs > 0 ? gs : (Number.isFinite(gp) && gp > 0 ? gp : NaN);
      if (Number.isFinite(totalKs) && Number.isFinite(denom) && denom > 0) return totalKs / denom;
      return NaN;
    }
    if ((s === "NBA" || s === "WNBA")) {
      const g = Number(row?.Games ?? row?.GamesPlayed);
      if (!Number.isFinite(g) || g <= 0) return NaN;
      if (p.includes("rebound")) {
        const tot = Number(row?.Rebounds ?? row?.TotalRebounds);
        return Number.isFinite(tot) ? tot / g : NaN;
      }
      if (p.includes("assist")) {
        const tot = Number(row?.Assists);
        return Number.isFinite(tot) ? tot / g : NaN;
      }
      if (p.includes("point")) {
        const tot = Number(row?.Points);
        return Number.isFinite(tot) ? tot / g : NaN;
      }
      return NaN;
    }
    if (s === "NFL" && p.includes("passing")) {
      const g = Number(row?.Games ?? row?.GamesPlayed);
      const y = Number(row?.PassingYards);
      if (Number.isFinite(y) && Number.isFinite(g) && g > 0) return y / g;
      return NaN;
    }
    return NaN;
  }

  // ---------- SportsDataIO pulls ----------
  async byDateArray(sport, dateStr) {
    const c = this.apiClient;
    if (!c) return [];
    try {
      if (sport === "MLB" && typeof c.getMLBPlayerStatsByDate === "function") {
        const r = await c.getMLBPlayerStatsByDate(dateStr);
        _uniqPush(this.usedEndpoints, `MLB:player-stats-by-date:${dateStr}`);
        return Array.isArray(r) ? r : [];
      }
      if (sport === "NBA" && typeof c.getNBAPlayerStatsByDate === "function") {
        const r = await c.getNBAPlayerStatsByDate(dateStr);
        _uniqPush(this.usedEndpoints, `NBA:player-stats-by-date:${dateStr}`);
        return Array.isArray(r) ? r : [];
      }
      if (sport === "WNBA" && typeof c.getWNBAPlayerStatsByDate === "function") {
        const r = await c.getWNBAPlayerStatsByDate(dateStr);
        _uniqPush(this.usedEndpoints, `WNBA:player-stats-by-date:${dateStr}`);
        return Array.isArray(r) ? r : [];
      }
    } catch {}
    return [];
  }

  async seasonArray(sport, seasonYear) {
    const c = this.apiClient;
    if (!c) return [];
    try {
      if (sport === "MLB" && typeof c.getMLBPlayerSeasonStats === "function") {
        const r = await c.getMLBPlayerSeasonStats(seasonYear);
        _uniqPush(this.usedEndpoints, `MLB:player-season-stats:${seasonYear}`);
        return Array.isArray(r) ? r : [];
      }
      if (sport === "NBA" && typeof c.getNBAPlayerSeasonStats === "function") {
        const r = await c.getNBAPlayerSeasonStats(seasonYear);
        _uniqPush(this.usedEndpoints, `NBA:player-season-stats:${seasonYear}`);
        return Array.isArray(r) ? r : [];
      }
      if (sport === "WNBA" && typeof c.getWNBAPlayerSeasonStats === "function") {
        const r = await c.getWNBAPlayerSeasonStats(seasonYear);
        _uniqPush(this.usedEndpoints, `WNBA:player-season-stats:${seasonYear}`);
        return Array.isArray(r) ? r : [];
      }
      if (sport === "NFL" && typeof c.getNFLPlayerSeasonStats === "function") {
        const r = await c.getNFLPlayerSeasonStats(seasonYear);
        _uniqPush(this.usedEndpoints, `NFL:player-season-stats:${seasonYear}`);
        return Array.isArray(r) ? r : [];
      }
    } catch {}
    return [];
  }

  async nflWeekArray(season, week) {
    const c = this.apiClient;
    if (!c || typeof c.getNFLPlayerGameStatsByWeek !== "function") return [];
    try {
      const r = await c.getNFLPlayerGameStatsByWeek(season, week);
      _uniqPush(this.usedEndpoints, `NFL:player-stats-by-week:${season}-W${week}`);
      return Array.isArray(r) ? r : [];
    } catch { return []; }
  }

  // recent collection by *date* (MLB/NBA/WNBA)
  async collectRecentsByDate(input, sport, dateStr, lookbackDays, maxGames) {
    const values = [];
    const matchesName = nameMatcherFactory(input.player);
    let date = new Date(dateStr);

    for (let d = 0; d < lookbackDays && values.length < maxGames; d++) {
      const ds = fmtLocalDate(date);
      const arr = await this.byDateArray(sport, ds);
      if (Array.isArray(arr) && arr.length) {
        const row = arr.find((r) => matchesName(r?.Name));
        if (row) {
          // MLB: require IP > 0 to ensure pitched appearance
          if (sport === "MLB") {
            const ip =
              Number(row?.PitchingInningsPitchedDecimal) ??
              Number(row?.InningsPitchedDecimal) ??
              Number(row?.InningsPitched);
            if (!(Number.isFinite(ip) && ip > 0)) {
              this.zeroFiltered += 1;
              date.setDate(date.getDate() - 1);
              continue;
            }
          }
          const v = this.pickValueFromRow(sport, input.prop, row);
          if (Number.isFinite(v)) {
            values.push(v);
            this.matchedName = String(row?.Name || this.matchedName);
          } else {
            this.zeroFiltered += 1;
          }
        }
      }
      date.setDate(date.getDate() - 1);
    }
    return values;
  }

  // NFL recents by week
  async collectNFLRecents(input, season, currentWeek, maxWeeks) {
    const values = [];
    const matchesName = nameMatcherFactory(input.player);
    for (let w = currentWeek; w >= 1 && values.length < maxWeeks; w--) {
      const arr = await this.nflWeekArray(season, w);
      if (!arr.length) continue;
      const row = arr.find((r) => matchesName(r?.Name));
      if (row) {
        const v = this.pickValueFromRow("NFL", input.prop, row);
        if (Number.isFinite(v)) {
          values.push(v);
          this.matchedName = String(row?.Name || this.matchedName);
        } else {
          this.zeroFiltered += 1;
        }
      }
    }
    return values;
  }

  // ---------- safe synthetic fallback ----------
  async getPlayerHistoricalStats() {
    return {
      last60: Array.from({ length: 60 }, () => 5 + Math.random() * 6),
      last30: Array.from({ length: 30 }, () => 5 + Math.random() * 6),
      last7: Array.from({ length: 7 }, () => 5 + Math.random() * 6),
      recent: Array.from({ length: 15 }, () => 5 + Math.random() * 6),
    };
  }
  async getOpponentDefensiveStats() { return { factor: 1.0 }; }

  // ---------- feature generation (SDIO-first) ----------
  async generateFeatures(input) {
    const sport = String(input?.sport || "").toUpperCase();

    // reset meta
    this.dataSource = "fallback";
    this.usedEndpoints = [];
    this.matchedName = "";
    this.zeroFiltered = 0;
    this.recentValsCount = 0;
    this.recentSample = [];
    this.debug = { fallbackReason: null, lastHttp: null };

    // local date from startTime
    let dateStr;
    try {
      const d = input?.startTime ? new Date(input.startTime) : new Date();
      if (!Number.isFinite(d.getTime())) throw new Error("bad date");
      dateStr = fmtLocalDate(d);
    } catch {
      dateStr = fmtLocalDate(new Date());
    }
    const seasonYear = new Date(dateStr).getFullYear();

    try {
      const c = this.apiClient;
      if (!c || !c.apiKey) {
        this.debug.fallbackReason = "NO_API_KEY";
        throw new Error("NO_API_KEY");
      }

      const nameMatch = nameMatcherFactory(input.player);

      // Season pull
      const seasonArr = await this.seasonArray(sport, seasonYear);
      let seasonAvg = NaN;
      if (Array.isArray(seasonArr) && seasonArr.length) {
        const sRow = seasonArr.find((r) => nameMatch(r?.Name));
        if (sRow) {
          this.matchedName = String(sRow?.Name || this.matchedName);
          seasonAvg = this.seasonPerGameFromRow(sport, input.prop, sRow);
        }
      }

      // Recents
      let recentVals = [];
      if (sport === "NFL") {
        let season = seasonYear;
        if (typeof c.getNFLSeasonCurrent === "function") {
          const cur = await c.getNFLSeasonCurrent();
          const n = Number(cur?.Season ?? cur);
          if (Number.isFinite(n)) season = n;
        }
        let curWeek = 18;
        if (typeof c.getNFLWeekCurrent === "function") {
          const wk = await c.getNFLWeekCurrent();
          const n = Number(wk?.Week ?? wk);
          if (Number.isFinite(n)) curWeek = n;
        }
        recentVals = await this.collectNFLRecents(input, season, curWeek, 8);
      } else {
        recentVals = await this.collectRecentsByDate(input, sport, dateStr, sport === "MLB" ? 90 : 45, 10);
      }

      // Save samples
      this.recentValsCount = recentVals.length;
      this.recentSample = recentVals.slice(0, 10);

      // Build blended μ (70% recent + 30% season)
      const haveRecent = recentVals.length > 0;
      const recentMean = haveRecent
        ? recentVals.reduce((a, b) => a + b, 0) / recentVals.length
        : (Number.isFinite(seasonAvg) ? seasonAvg : NaN);

      let blendedMu = null;
      if (Number.isFinite(recentMean) && Number.isFinite(seasonAvg)) blendedMu = 0.7 * recentMean + 0.3 * seasonAvg;
      else if (Number.isFinite(recentMean)) blendedMu = recentMean;
      else if (Number.isFinite(seasonAvg)) blendedMu = seasonAvg;

      if (this.usedEndpoints.length > 0) this.dataSource = "sportsdata";

      if (Number.isFinite(blendedMu)) {
        // Variance: sample if ≥3; else sport-aware floor
        let variance;
        if (recentVals.length >= 3) variance = this.calculateVariance(recentVals);
        else {
          if (sport === "MLB" && String(input.prop).toLowerCase().includes("strikeout")) variance = Math.max(1.44, Math.abs(blendedMu - blendedMu * 0.9));
          else if (sport === "NFL" && String(input.prop).toLowerCase().includes("passing")) variance = Math.max(625, Math.abs(blendedMu - blendedMu * 0.8)); // σ ≥ 25
          else variance = Math.max(1.0, Math.abs(blendedMu - blendedMu * 0.85));
        }

        return {
          last60Avg: blendedMu,
          last30Avg: blendedMu,
          last7Avg: haveRecent ? this.calculateExponentialAverage(recentVals.slice(0, 7), 0.85) : blendedMu,
          variance,
          stdDev: Math.sqrt(variance),
          matchupFactor: 1.0,
          minutesFactor: 1.0,
          specific: { adjustment: 0 },
        };
      }

      // If SDIO pulled but no numeric μ → fallback reason
      this.debug.fallbackReason = "NO_USABLE_NUMERIC_AFTER_SDIO";
      throw new Error("no usable numeric after SDIO");

    } catch (_e) {
      // safe synthetic fallback
      const ps = await this.getPlayerHistoricalStats(input.player, sport);
      const variance = this.calculateVariance(ps.recent);
      this.dataSource = "fallback";
      return {
        last60Avg: this.calculateExponentialAverage(ps.last60, 0.95),
        last30Avg: this.calculateExponentialAverage(ps.last30, 0.90),
        last7Avg: this.calculateExponentialAverage(ps.last7, 0.85),
        variance,
        stdDev: Math.sqrt(variance),
        matchupFactor: 1.0,
        minutesFactor: 1.0,
        specific: { adjustment: 0 },
      };
    }
  }

  // ---------- modeling ----------
  calculateStatisticalProbability(features, input) {
    const line = this.extractLineFromProp(input.prop);

    let mu =
      (Number(features.last30Avg) || 0) *
      (Number(features.matchupFactor) || 1) *
      (Number(features.minutesFactor) || 1);

    if (features?.specific?.adjustment) mu += Number(features.specific.adjustment) || 0;

    let sigma = Number(features.stdDev);
    if (!Number.isFinite(sigma) || sigma <= 0) sigma = 1.2;

    const sport = String(input.sport || "").toUpperCase();
    const ptxt = String(input.prop || "").toLowerCase();

    if (sport === "MLB" && ptxt.includes("strikeout")) {
      sigma = Math.max(1.2, Math.min(sigma, 3.5));
      const p = StatisticalModels.calculatePoissonProbability(mu, line);
      return { probability: clamp01(p), expectedValue: mu, stdDev: sigma, line };
    }
    if ((sport === "NBA" || sport === "WNBA") && (ptxt.includes("rebound") || ptxt.includes("assist"))) {
      sigma = Math.max(1.0, Math.min(sigma, 6.0));
    } else if (sport === "NFL" && ptxt.includes("passing")) {
      sigma = Math.max(25, Math.min(sigma, 150));
    }

    const p = StatisticalModels.calculateNormalProbability(mu, sigma, line);
    return { probability: clamp01(p), expectedValue: mu, stdDev: sigma, line };
  }

  calculateMarketProbability(odds) {
    const over = Number(odds?.over);
    const under = Number(odds?.under);
    if (!Number.isFinite(over) || !Number.isFinite(under) || over <= 0 || under <= 0) {
      return { marketProbability: 0.5, vig: 0 };
    }
    const impliedOver = 1 / over;
    const impliedUnder = 1 / under;
    const sum = impliedOver + impliedUnder;
    return { marketProbability: sum > 0 ? impliedOver / sum : 0.5, vig: Math.max(0, sum - 1) };
  }

  // ---------- SMART nudges ----------
  projectionGapNudge(modelProb, marketProb) {
    if (!SMART) return 0;
    const gap = Math.abs(modelProb - marketProb);
    if (gap >= this.thresholds.PROJECTION_GAP_TRIGGER) {
      const direction = Math.sign(modelProb - marketProb);
      return 0.03 * direction;
    }
    return 0;
  }
  workloadGuardrail() { return SMART ? 0 : 0; }
  microContextNudge(input) {
    if (!SMART) return 0;
    const t = `${input?.injuryNotes || ""} ${input?.opponent || ""}`.toLowerCase();
    let n = 0;
    if (t.includes("fast pace") || t.includes("coors")) n += 0.02;
    if (t.includes("back-to-back") || t.includes("fatigue")) n -= 0.02;
    return n;
  }
  steamDetectionNudge() { return SMART ? 0 : 0; }

  // ---------- house adjustments ----------
  applyHouseAdjustments(modelProb, input, features) {
    let adjusted = Number(modelProb);
    const flags = [];

    const line = this.extractLineFromProp(input.prop);
    const isHalf = Math.abs(line - Math.round(line)) > 1e-9;

    if (isHalf) {
      flags.push("HOOK");
      if (Math.abs((features?.last30Avg || 0) - line) < 0.3) {
        adjusted -= this.thresholds.HOOK_BUFFER;
        flags.push("HOOK_TRAP");
      }
    }

    if ((features?.stdDev || 0) > 4 && String(input?.sport || "").toUpperCase() !== "NFL") {
      adjusted -= this.thresholds.VARIANCE_PENALTY;
      flags.push("HIGH_VARIANCE");
    }

    const stars = ["Judge", "Ohtani", "Mahomes", "Brady", "Ionescu", "Wilson", "Cloud", "Curry", "LeBron", "Jokic"];
    if (stars.some((s) => String(input?.player || "").includes(s))) {
      adjusted -= this.thresholds.NAME_INFLATION;
      flags.push("NAME_INFLATION");
    }

    return { adjustedProb: clamp01(adjusted), flags };
  }

  // ---------- calibration & fusion ----------
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

  // ---------- main ----------
  async evaluateProp(inputRaw) {
    const input = {
      sport: inputRaw?.sport || "NBA",
      player: inputRaw?.player || "",
      opponent: inputRaw?.opponent || "",
      prop: inputRaw?.prop || "Points 10.5",
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
    try {
      features = await this.generateFeatures(input);
    } catch {
      const ps = await this.getPlayerHistoricalStats(input.player, input.sport);
      const variance = this.calculateVariance(ps.recent);
      features = {
        last60Avg: this.calculateExponentialAverage(ps.last60, 0.95),
        last30Avg: this.calculateExponentialAverage(ps.last30, 0.90),
        last7Avg: this.calculateExponentialAverage(ps.last7, 0.85),
        variance,
        stdDev: Math.sqrt(variance),
        matchupFactor: 1.0,
        minutesFactor: 1.0,
        specific: { adjustment: 0 },
      };
      this.dataSource = "fallback";
      this.debug.fallbackReason = this.debug.fallbackReason || "FEATURE_GEN_THROW";
    }

    const stat = this.calculateStatisticalProbability(features, input);
    const market = this.calculateMarketProbability(input.odds);

    const gapNudge = this.projectionGapNudge(stat.probability, market.marketProbability);
    const workNudge = this.workloadGuardrail(input, features);
    const microNudge = this.microContextNudge(input);
    const steamNudge = this.steamDetectionNudge();

    const { adjustedProb, flags: houseFlags } =
      this.applyHouseAdjustments(stat.probability, input, features);

    const nudgesTotal = gapNudge + workNudge + microNudge + steamNudge + (adjustedProb - stat.probability);

    // Fuse
    let fused = this.fuseProbabilities(stat.probability, market.marketProbability, 0 /*sharp*/, nudgesTotal);

    // ---------- Safety Gates ----------
    const hasSDIO = this.dataSource === "sportsdata" && this.usedEndpoints.length > 0;
    const hasEnoughSample = this.recentValsCount >= this.thresholds.MIN_RECENT_GAMES || !!this.matchedName;

    const safetyFlags = [];
    if (!hasSDIO) {
      safetyFlags.push("FALLBACK_DATA");
      if (this.debug?.fallbackReason) safetyFlags.push(`FALLBACK_REASON:${this.debug.fallbackReason}`);
      fused = Math.min(fused, 0.499);
    }
    if (!hasEnoughSample) {
      safetyFlags.push("INSUFFICIENT_SAMPLE");
      fused = Math.min(fused, 0.499);
    }

    const finalConfidence = Math.round(fused * 1000) / 10;
    const decision =
      finalConfidence >= this.thresholds.LOCK_CONFIDENCE * 100 ? "LOCK" :
      finalConfidence >= this.thresholds.STRONG_LEAN * 100 ? "STRONG_LEAN" :
      finalConfidence >= this.thresholds.LEAN * 100 ? "LEAN" : "PASS";

    const suggestion = stat.probability >= 0.5 ? "OVER" : "UNDER";

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
      flags: [...houseFlags, ...(SMART ? ["SMART_OVERLAYS"] : ["SMART_OFF"]), ...safetyFlags],
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
        debug: this.debug,
      },
    };
  }
}
