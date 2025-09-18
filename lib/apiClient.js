// lib/apiClient.js
// Safe SportsDataIO client for Vercel (Node 18+)
// - Uses global fetch
// - Simple rate limit (1 req / sec)
// - Never throws (returns {} on error)
// - All endpoints use correct backticks and leading slashes

export class APIClient {
  constructor(apiKey) {
    this.apiKey = apiKey || "";
    this.baseURL = "https://api.sportsdata.io";
    this.rateLimitDelay = 1000; // ms between requests
    this.lastRequestTime = 0;
    this.enableLogs = !!process.env.LOG_SPORTSDATA; // optional debug
  }

  async makeRequest(endpoint, params = {}) {
    // Soft-fail if no key so engines can fall back gracefully
    if (!this.apiKey) return {};

    // Normalize endpoint
    const ep = endpoint.startsWith("/") ? endpoint : `/${endpoint}`;

    // Simple rate limiter
    const now = Date.now();
    const elapsed = now - this.lastRequestTime;
    if (elapsed < this.rateLimitDelay) {
      await new Promise((r) => setTimeout(r, this.rateLimitDelay - elapsed));
    }

    const url = new URL(this.baseURL + ep);
    url.searchParams.set("key", this.apiKey);
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, v);
    }

    this.lastRequestTime = Date.now();

    try {
      if (this.enableLogs) console.log("[SportsDataIO] GET", url.toString());
      const resp = await fetch(url.toString(), {
        headers: { Accept: "application/json" },
      });
      if (!resp.ok) return {};
      return await resp.json();
    } catch {
      return {};
    }
  }

  // ----------------------------
  // MLB
  // ----------------------------
  async getMLBPlayerProps(gameId) {
    return this.makeRequest(`/v3/mlb/odds/json/BettingPlayerPropsByGame/${gameId}`);
  }
  async getMLBGameOdds(date) {
    // date format typically YYYY-MM-DD
    return this.makeRequest(`/v3/mlb/odds/json/GameOdds/${date}`);
  }
  async getMLBPlayerStats(date) {
    return this.makeRequest(`/v3/mlb/stats/json/PlayerGameStatsByDate/${date}`);
  }
  async getMLBStartingLineups(date) {
    return this.makeRequest(`/v3/mlb/projections/json/StartingLineupsByDate/${date}`);
  }

  // ----------------------------
  // NBA
  // ----------------------------
  async getNBAPlayerProps(gameId) {
    return this.makeRequest(`/v3/nba/odds/json/BettingPlayerPropsByGame/${gameId}`);
  }
  async getNBAGameOdds(date) {
    return this.makeRequest(`/v3/nba/odds/json/GameOdds/${date}`);
  }
  async getNBAPlayerStats(date) {
    return this.makeRequest(`/v3/nba/stats/json/PlayerGameStatsByDate/${date}`);
  }

  // ----------------------------
  // WNBA
  // ----------------------------
  async getWNBAPlayerProps(gameId) {
    return this.makeRequest(`/v3/wnba/odds/json/BettingPlayerPropsByGame/${gameId}`);
  }
  // Season stats (no date param per your request)
  async getWNBAPlayerStats() {
    return this.makeRequest(`/v3/wnba/stats/json/PlayerSeasonStats/`);
  }

  // ----------------------------
  // NFL
  // ----------------------------
  async getNFLPlayerProps(gameId) {
    return this.makeRequest(`/v3/nfl/odds/json/BettingPlayerPropsByGame/${gameId}`);
  }
  async getNFLGameOdds(week) {
    return this.makeRequest(`/v3/nfl/odds/json/GameOdds/${week}`);
  }
  async getNFLPlayerStats(week) {
    return this.makeRequest(`/v3/nfl/stats/json/PlayerGameStatsByWeek/${week}`);
  }
}
