// lib/apiClient.js

// SportsDataIO client with pacing, timeout, and verbose logging.
// Exposes convenience methods used by the engines (season/by-date + NFL week helpers).
// Exports (backward-compatible):
//   - default:  apiClient (ready-to-use singleton)
//   - named:    apiClient (same singleton)
//   - named:    APIClient  (alias of SportsDataIOClient class)
//   - named:    SportsDataIOClient (class)

export class SportsDataIOClient {
  constructor(opts = {}) {
    this.apiKey =
      opts.apiKey ||
      process.env.SPORTS_DATA_IO_KEY ||
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
    if (!this.apiKey) return {};

    // Simple pacing to avoid hammering the API
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
    const timeout = setTimeout(() => controller.abort(), 3500);

    try {
      console.log("[SportsDataIO] GET", url.toString());
      const resp = await fetch(url.toString(), {
        headers: { Accept: "application/json" },
        signal: controller.signal
      });
      console.log("[SportsDataIO] STATUS", resp.status);

      if (resp.status === 429) {
        // brief backoff + one retry
        await new Promise(r => setTimeout(r, 750));
        const resp2 = await fetch(url.toString(), {
          headers: { Accept: "application/json" }
        });
        clearTimeout(timeout);
        if (!resp2.ok) return {};
        try { return await resp2.json(); } catch { return {}; }
      }

      clearTimeout(timeout);
      if (!resp.ok) return {};
      try { return await resp.json(); } catch { return {}; }
    } catch {
      clearTimeout(timeout);
      return {};
    }
  }

  // -------------------- Convenience Methods --------------------

  // Season stats
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

  // By-date (per-game) stats
  async getMLBPlayerStatsByDate(date){
    return this.makeRequest(`/v3/mlb/stats/json/PlayerGameStatsByDate/${date}`);
  }
  async getNBAPlayerStatsByDate(date){
    return this.makeRequest(`/v3/nba/stats/json/PlayerGameStatsByDate/${date}`);
  }
  async getWNBAPlayerStatsByDate(date){
    return this.makeRequest(`/v3/wnba/stats/json/PlayerGameStatsByDate/${date}`);
  }

  // (optional) Projections by date — only if your plan supports them
  async getMLBPlayerProjectionsByDate(date){
    return this.makeRequest(`/v3/mlb/projections/json/PlayerGameProjectionStatsByDate/${date}`);
  }
  async getNBAPlayerProjectionsByDate(date){
    return this.makeRequest(`/v3/nba/projections/json/PlayerGameProjectionStatsByDate/${date}`);
  }
  async getWNBAPlayerProjectionsByDate(date){
    return this.makeRequest(`/v3/wnba/projections/json/PlayerGameProjectionStatsByDate/${date}`);
  }

  // NFL week helpers (useful for recents)
  async getNFLSeasonCurrent(){
    return this.makeRequest(`/v3/nfl/scores/json/CurrentSeason`);
  }
  async getNFLWeekCurrent(){
    return this.makeRequest(`/v3/nfl/scores/json/CurrentWeek`);
  }
  async getNFLPlayerGameStatsByWeek(season, week){
    return this.makeRequest(`/v3/nfl/stats/json/PlayerGameStatsByWeek/${season}/${week}`);
  }
  // (optional) NFL projections by week
  async getNFLPlayerProjectionsByWeek(season, week){
    return this.makeRequest(`/v3/nfl/projections/json/PlayerGameProjectionStatsByWeek/${season}/${week}`);
  }
}

// Ready-to-use singleton
const singleton = new SportsDataIOClient();

// Named exports for compatibility
export { singleton as apiClient };
export { SportsDataIOClient as APIClient }; // import { APIClient } ... new APIClient()

// Default export (same singleton)
export default singleton;
