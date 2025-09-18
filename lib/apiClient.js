// lib/apiClient.js
export class APIClient {
  constructor(apiKey) {
    this.apiKey = apiKey || "";
    this.baseURL = "https://api.sportsdata.io";
    this.rateLimitDelay = 1000; // ms
    this.lastRequestTime = 0;
  }

  async makeRequest(endpoint, params = {}) {
    // If no API key set in Vercel, don't crash—return empty so engines can fall back.
    if (!this.apiKey) return {};

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
    const resp = await fetch(url.toString(), { headers: { Accept: "application/json" } });
    if (!resp.ok) {
      // Don’t throw—return empty so your engines can use defaults.
      return {};
    }
    return await resp.json();
  }

  // MLB
  async getMLBPlayerProps(gameId) { return this.makeRequest(`/v3/mlb/odds/json/BettingPlayerPropsByGame/${gameId}`); }
  async getMLBGameOdds(date)    { return this.makeRequest(`/v3/mlb/odds/json/GameOdds/${date}`); }
  async getMLBPlayerStats(date) { return this.makeRequest(`/v3/mlb/stats/json/PlayerGameStatsByDate/${date}`); }
  async getMLBStartingLineups(date) { return this.makeRequest(`/v3/mlb/projections/json/StartingLineupsByDate/${date}`); }

  // NBA
  async getNBAPlayerProps(gameId) { return this.makeRequest(`/v3/nba/odds/json/BettingPlayerPropsByGame/${gameId}`); }
  async getNBAGameOdds(date)      { return this.makeRequest(`/v3/nba/odds/json/GameOdds/${date}`); }
  async getNBAPlayerStats(date)   { return this.makeRequest(`/v3/nba/stats/json/PlayerGameStatsByDate/${date}`); }

  // WNBA
  async getWNBAPlayerProps(gameId) { return this.makeRequest(`/v3/wnba/odds/json/BettingPlayerPropsByGame/${gameId}`); }
  async getWNBAPlayerStats()       { return this.makeRequest(`/v3/wnba/stats/json/PlayerSeasonStats/`); }

  // NFL
  async getNFLPlayerProps(gameId) { return this.makeRequest(`/v3/nfl/odds/json/BettingPlayerPropsByGame/${gameId}`); }
  async getNFLGameOdds(week)      { return this.makeRequest(`/v3/nfl/odds/json/GameOdds/${week}`); }
  async getNFLPlayerStats(week)   { return this.makeRequest(`/v3/nfl/stats/json/PlayerGameStatsByWeek/${week}`); }
}
