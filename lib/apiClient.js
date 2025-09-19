// lib/apiClient.js
export class APIClient {
  constructor(apiKey) {
    this.apiKey = apiKey || "";
    this.baseURL = "https://api.sportsdata.io";
    this.rateLimitDelay = 1000; // ms between calls (simple client-side pacing)
    this.lastRequestTime = 0;
  }

  // -------- core requester (with pacing, timeout, 429 backoff, redacted logs) --------
  async makeRequest(endpoint, params = {}) {
    // Soft-fail so engines can fallback without crashing
    if (!this.apiKey) return {};

    // Simple pacing
    const now = Date.now();
    const elapsed = now - this.lastRequestTime;
    if (elapsed < this.rateLimitDelay) {
      await new Promise(r => setTimeout(r, this.rateLimitDelay - elapsed));
    }

    // Build URL
    const url = new URL(this.baseURL + endpoint);
    url.searchParams.set("key", this.apiKey);
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, v);
    }
    this.lastRequestTime = Date.now();

    // Redact the key for logs
    const redacted = url.toString().replace(this.apiKey, "****");

    // Timeout via AbortController
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 3500);

    try {
      console.log("[SportsDataIO] GET", redacted);
      const resp = await fetch(url.toString(), {
        headers: { Accept: "application/json" },
        signal: controller.signal
      });
      console.log("[SportsDataIO] STATUS", resp.status);

      // Handle 429 with one quick backoff retry
      if (resp.status === 429) {
        await new Promise(r => setTimeout(r, 750));
        const resp2 = await fetch(url.toString(), { headers: { Accept: "application/json" } });
        console.log("[SportsDataIO] RETRY STATUS", resp2.status);
        clearTimeout(timeoutId);
        if (!resp2.ok) return {};
        const ct = (resp2.headers.get("content-type") || "").toLowerCase();
        if (!ct.includes("application/json")) return {};
        return await resp2.json();
      }

      clearTimeout(timeoutId);
      if (!resp.ok) return {};
      const ct = (resp.headers.get("content-type") || "").toLowerCase();
      if (!ct.includes("application/json")) return {};
      return await resp.json();
    } catch (err) {
      clearTimeout(timeoutId);
      console.log("[SportsDataIO] ERROR", String(err?.message || err || "unknown"));
      return {};
    }
  }

  // =========================
  // MLB
  // =========================

  // Player props / odds / lines (by game or by date)
  async getMLBPlayerProps(gameId) {
    return this.makeRequest(`/v3/mlb/odds/json/BettingPlayerPropsByGame/${gameId}`);
  }
  async getMLBGameOdds(date) {
    // By-date odds for pregame/period lines (path used in your code)
    return this.makeRequest(`/v3/mlb/odds/json/GameOdds/${date}`);
  }

  // Player stats (by date)
  async getMLBPlayerStats(date) {
    return this.makeRequest(`/v3/mlb/stats/json/PlayerGameStatsByDate/${date}`);
  }

  // Projections / lineups (if plan supports projections)
  async getMLBProjectedPlayerGameStatsByDate(date) {
    return this.makeRequest(`/v3/mlb/projections/json/PlayerGameProjectionStatsByDate/${date}`);
  }
  async getMLBStartingLineups(date) {
    return this.makeRequest(`/v3/mlb/projections/json/StartingLineupsByDate/${date}`);
  }

  // Season stats (per-season, used to compute per-game averages)
  async getMLBPlayerSeasonStats(season) {
    return this.makeRequest(`/v3/mlb/stats/json/PlayerSeasonStats/${season}`);
  }

  // =========================
  // NBA
  // =========================

  // Player props / odds / lines
  async getNBAPlayerProps(gameId) {
    return this.makeRequest(`/v3/nba/odds/json/BettingPlayerPropsByGame/${gameId}`);
  }
  async getNBAGameOdds(date) {
    return this.makeRequest(`/v3/nba/odds/json/GameOdds/${date}`);
  }

  // Player stats (by date)
  async getNBAPlayerStats(date) {
    return this.makeRequest(`/v3/nba/stats/json/PlayerGameStatsByDate/${date}`);
  }

  // Season stats
  async getNBAPlayerSeasonStats(season) {
    return this.makeRequest(`/v3/nba/stats/json/PlayerSeasonStats/${season}`);
  }

  // =========================
  // WNBA
  // =========================

  // Player props / odds / lines
  async getWNBAPlayerProps(gameId) {
    return this.makeRequest(`/v3/wnba/odds/json/BettingPlayerPropsByGame/${gameId}`);
  }
  async getWNBAGameOdds(date) {
    return this.makeRequest(`/v3/wnba/odds/json/GameOdds/${date}`);
  }

  // Player stats
  // Some plans expose by-date; keep both helpers and the engine will try what's available.
  async getWNBAPlayerStatsByDate(date) {
    return this.makeRequest(`/v3/wnba/stats/json/PlayerGameStatsByDate/${date}`);
  }
  async getWNBAPlayerStats() {
    // Season-level fallback (your previous implementation)
    return this.makeRequest(`/v3/wnba/stats/json/PlayerSeasonStats/`);
  }

  // Season stats
  async getWNBAPlayerSeasonStats(season) {
    return this.makeRequest(`/v3/wnba/stats/json/PlayerSeasonStats/${season}`);
  }

  // =========================
  // NFL
  // =========================

  // Player props / odds / lines (NFL odds are by week)
  async getNFLPlayerProps(gameId) {
    return this.makeRequest(`/v3/nfl/odds/json/BettingPlayerPropsByGame/${gameId}`);
  }
  async getNFLGameOdds(week) {
    // Back-compat with your earlier method signature
    return this.makeRequest(`/v3/nfl/odds/json/GameOdds/${week}`);
  }
  async getNFLGameOddsByWeek(season, week) {
    return this.makeRequest(`/v3/nfl/odds/json/GameOddsByWeek/${season}/${week}`);
  }

  // Player stats — by week (preferred) + a back-compat method
  async getNFLPlayerStatsByWeek(season, week) {
    return this.makeRequest(`/v3/nfl/stats/json/PlayerGameStatsByWeek/${season}/${week}`);
  }
  async getNFLPlayerStats(week) {
    // Your older signature; some environments infer current season
    return this.makeRequest(`/v3/nfl/stats/json/PlayerGameStatsByWeek/${week}`);
  }

  // Season stats
  async getNFLPlayerSeasonStats(season) {
    return this.makeRequest(`/v3/nfl/stats/json/PlayerSeasonStats/${season}`);
  }
}
