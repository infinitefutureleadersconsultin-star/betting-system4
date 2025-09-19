// lib/apiClient.js
export class APIClient {
  constructor(apiKey) {
    this.apiKey = apiKey || "";
    this.baseURL = "https://api.sportsdata.io";
    this.rateLimitDelay = 1000; // ms between requests
    this.lastRequestTime = 0;
  }

  async makeRequest(endpoint, params = {}) {
    if (!this.apiKey) return {}; // soft-fail so engines can fallback

    // simple client-side pacing
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

    // 3.5s timeout + one 429 retry
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3500);

    try {
      const resp = await fetch(url.toString(), {
        headers: { Accept: "application/json" },
        signal: controller.signal
      });

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

  // ------------- MLB -------------
  async getMLBPlayerProps(gameId){ return this.makeRequest(`/v3/mlb/odds/json/BettingPlayerPropsByGame/${gameId}`); }
  async getMLBGameOdds(date){ return this.makeRequest(`/v3/mlb/odds/json/GameOdds/${date}`); }
  async getMLBGamesByDate(date){ return this.makeRequest(`/v3/mlb/scores/json/GamesByDate/${date}`); }

  // Same-day final box scores (usually post-game; not ideal pregame, but a fallback seed)
  async getMLBPlayerStats(date){ return this.makeRequest(`/v3/mlb/stats/json/PlayerGameStatsByDate/${date}`); }

  // Pregame projections + lineups
  async getMLBPlayerProjectionsByDate(date){ return this.makeRequest(`/v3/mlb/projections/json/PlayerGameProjectionStatsByDate/${date}`); }
  async getMLBStartingLineups(date){ return this.makeRequest(`/v3/mlb/projections/json/StartingLineupsByDate/${date}`); }

  // ------------- NBA -------------
  async getNBAGameOdds(date){ return this.makeRequest(`/v3/nba/odds/json/GameOdds/${date}`); }
  async getNBAGamesByDate(date){ return this.makeRequest(`/v3/nba/scores/json/GamesByDate/${date}`); }

  // Stats & projections
  async getNBAPlayerStats(date){ return this.makeRequest(`/v3/nba/stats/json/PlayerGameStatsByDate/${date}`); }
  async getNBAPlayerProjectionsByDate(date){ return this.makeRequest(`/v3/nba/projections/json/PlayerGameProjectionStatsByDate/${date}`); }
  async getNBAPlayerProps(gameId){ return this.makeRequest(`/v3/nba/odds/json/BettingPlayerPropsByGame/${gameId}`); }

  // ------------- WNBA -------------
  async getWNBAPlayerStats(date){ return this.makeRequest(`/v3/wnba/stats/json/PlayerGameStatsByDate/${date}`); }
  async getWNBAPlayerProps(gameId){ return this.makeRequest(`/v3/wnba/odds/json/BettingPlayerPropsByGame/${gameId}`); }
  async getWNBAGamesByDate(date){ return this.makeRequest(`/v3/wnba/scores/json/GamesByDate/${date}`); }

  // ------------- NFL -------------
  async getNFLGameOdds(week){ return this.makeRequest(`/v3/nfl/odds/json/GameOdds/${week}`); }
  async getNFLPlayerStats(week){ return this.makeRequest(`/v3/nfl/stats/json/PlayerGameStatsByWeek/${week}`); }
  async getNFLPlayerProps(gameId){ return this.makeRequest(`/v3/nfl/odds/json/BettingPlayerPropsByGame/${gameId}`); }
}
