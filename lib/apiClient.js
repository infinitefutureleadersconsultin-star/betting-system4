// lib/apiClient.js
// SportsDataIO client with pacing, timeout, and clean exports.
// Exposes exactly the helpers your engines call.

export class SportsDataIOClient {
  constructor(opts = {}) {
    this.apiKey =
      opts.apiKey ||
      process.env.SPORTS_DATA_IO_KEY ||
      process.env.SPORTS_DATA_IO_API_KEY ||
      process.env.SPORTSDATAIO_KEY ||
      process.env.SDIO_KEY ||
      "";

    this.baseURL = (
      opts.baseURL ||
      process.env.SPORTS_DATA_IO_BASEURL ||
      "https://api.sportsdata.io"
    ).replace(/\/+$/, "");

    this.rateLimitDelay = Number(
      opts.rateLimitDelay ?? process.env.SPORTS_DATA_IO_RATE_DELAY ?? 250
    );
    this.lastRequestTime = 0;
  }

  setApiKey(key) { this.apiKey = key || ""; }
  setBaseURL(url) { if (url) this.baseURL = url.replace(/\/+$/, ""); }

  async makeRequest(endpoint, params = {}) {
    if (!this.apiKey) return [];

    // simple pacing
    const now = Date.now();
    const elapsed = now - this.lastRequestTime;
    if (elapsed < this.rateLimitDelay) {
      await new Promise(r => setTimeout(r, this.rateLimitDelay - elapsed));
    }

    const url = new URL(this.baseURL + endpoint);
    url.searchParams.set("key", this.apiKey);
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, v);
    }
    this.lastRequestTime = Date.now();

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);

    try {
      const resp = await fetch(url.toString(), {
        headers: { Accept: "application/json" },
        signal: controller.signal,
      });

      if (resp.status === 429) {
        // brief backoff + one retry
        await new Promise(r => setTimeout(r, 750));
        const resp2 = await fetch(url.toString(), { headers: { Accept: "application/json" } });
        clearTimeout(timeout);
        if (!resp2.ok) return [];
        try { return await resp2.json(); } catch { return []; }
      }

      clearTimeout(timeout);
      if (!resp.ok) return [];
      try { return await resp.json(); } catch { return []; }
    } catch {
      clearTimeout(timeout);
      return [];
    }
  }

  // ---------- Season stats ----------
  async getMLBPlayerSeasonStats(season){
    return this.makeRequest(`/v3/mlb/stats/json/PlayerSeasonStats/${season}`);
  }
  async getNBAPlayerSeasonStats(season){
    return this.makeRequest(`/v3/nba/stats/json/PlayerSeasonStats/${season}`);
  }
  async getWNBAPlayerSeasonStats(season){
    return this.makeRequest(`/v3/wnba/stats/json/PlayerSeasonStats/${season}`);
  }
  async getNFLPlayerSeasonStats(season){
    return this.makeRequest(`/v3/nfl/stats/json/PlayerSeasonStats/${season}`);
  }

  // ---------- By-date player game stats ----------
  async getMLBPlayerStatsByDate(date){
    return this.makeRequest(`/v3/mlb/stats/json/PlayerGameStatsByDate/${date}`);
  }
  async getNBAPlayerStatsByDate(date){
    return this.makeRequest(`/v3/nba/stats/json/PlayerGameStatsByDate/${date}`);
  }
  async getWNBAPlayerStatsByDate(date){
    return this.makeRequest(`/v3/wnba/stats/json/PlayerGameStatsByDate/${date}`);
  }

  // ---------- NFL by-week helpers ----------
  async getNFLSeasonCurrent(){
    // Some plans return a plain number; others a JSON value.
    return this.makeRequest(`/v3/nfl/scores/json/CurrentSeason`);
  }
  async getNFLWeekCurrent(){
    return this.makeRequest(`/v3/nfl/scores/json/CurrentWeek`);
  }
  async getNFLPlayerGameStatsByWeek(season, week){
    return this.makeRequest(`/v3/nfl/stats/json/PlayerGameStatsByWeek/${season}/${week}`);
  }

  // ---------- Betting: Pre-game odds (for GameLinesEngine) ----------
  async getMLBGameOdds(date){
    return this.makeRequest(`/v3/mlb/odds/json/GameOddsByDate/${date}`);
  }
  async getNBAGameOdds(date){
    return this.makeRequest(`/v3/nba/odds/json/GameOddsByDate/${date}`);
  }
  async getWNBAGameOdds(date){
    return this.makeRequest(`/v3/wnba/odds/json/GameOddsByDate/${date}`);
  }
  async getNFLGameOdds(week){
    return this.makeRequest(`/v3/nfl/odds/json/GameOddsByWeek/${week}`);
  }
}

// Ready-to-use singleton
const singleton = new SportsDataIOClient();

// Named exports for compatibility
export { singleton as apiClient };
export { SportsDataIOClient as APIClient }; // alias (if older imports use APIClient)

// Default export (same singleton)
export default singleton;
