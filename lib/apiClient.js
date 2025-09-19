// lib/apiClient.js
export class APIClient {
  constructor(apiKey) {
    this.apiKey = apiKey || "";
    this.baseURL = "https://api.sportsdata.io";
    this.rateLimitDelay = 1000; // ms between calls
    this.lastRequestTime = 0;
  }

  async makeRequest(endpoint, params = {}) {
    if (!this.apiKey) return {}; // soft-fail so engines can fallback

    // naive pacing
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

      // Basic 429 retry once
      if (resp.status === 429) {
        await new Promise(r => setTimeout(r, 750));
        const resp2 = await fetch(url.toString(), { headers: { Accept: "application/json" } });
        clearTimeout(timeout);
        if (!resp2.ok) return {};
        return await resp2.json();
      }

      clearTimeout(timeout);
      if (!resp.ok) return {};
      return await resp.json();
    } catch {
      clearTimeout(timeout);
      return {};
    }
  }

  // ---------- MLB ----------
  async getMLBPlayerStats(date) { // PlayerGameStatsByDate
    return this.makeRequest(`/v3/mlb/stats/json/PlayerGameStatsByDate/${date}`);
  }
  async getMLBPlayerSeasonStats(season) {
    return this.makeRequest(`/v3/mlb/stats/json/PlayerSeasonStats/${season}`);
  }
  async getMLBGameOdds(date) {
    return this.makeRequest(`/v3/mlb/odds/json/GameOdds/${date}`);
  }

  // ---------- NBA ----------
  async getNBAPlayerStats(date) { // PlayerGameStatsByDate
    return this.makeRequest(`/v3/nba/stats/json/PlayerGameStatsByDate/${date}`);
  }
  async getNBAPlayerSeasonStats(season) {
    return this.makeRequest(`/v3/nba/stats/json/PlayerSeasonStats/${season}`);
  }
  async getNBAGameOdds(date) {
    return this.makeRequest(`/v3/nba/odds/json/GameOdds/${date}`);
  }

  // ---------- WNBA ----------
  async getWNBAPlayerStats(date) { // PlayerGameStatsByDate (live/final)
    return this.makeRequest(`/v3/wnba/stats/json/PlayerGameStatsByDate/${date}`);
  }
  async getWNBAPlayerSeasonStats(season) {
    return this.makeRequest(`/v3/wnba/stats/json/PlayerSeasonStats/${season}`);
  }
  async getWNBAGameOdds(date) {
    return this.makeRequest(`/v3/wnba/odds/json/GameOdds/${date}`);
  }

  // ---------- NFL ----------
  async getNFLPlayerStats(season, week) { // PlayerGameStatsByWeek
    return this.makeRequest(`/v3/nfl/stats/json/PlayerGameStatsByWeek/${season}/${week}`);
  }
  async getNFLPlayerSeasonStats(season) {
    return this.makeRequest(`/v3/nfl/stats/json/PlayerSeasonStats/${season}`);
  }
  async getNFLGameOdds(week) {
    return this.makeRequest(`/v3/nfl/odds/json/GameOdds/${week}`);
  }
}
