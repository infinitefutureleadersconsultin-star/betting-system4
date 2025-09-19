// lib/apiClient.js
export class APIClient {
  constructor(apiKey) {
    this.apiKey = apiKey || "";
    this.baseURL = "https://api.sportsdata.io";
    this.rateLimitDelay = 1000; // ms
    this.lastRequestTime = 0;
  }

  // === Safe fetch with timeout + gentle 429 backoff ===
  async makeRequest(endpoint, params = {}) {
    if (!this.apiKey) return {}; // soft-fail so engines can fallback

    // Simple pacing
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

    // 3.5s hard timeout + single retry on 429
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3500);

    try {
      const resp = await fetch(url.toString(), {
        headers: { Accept: "application/json" },
        signal: controller.signal
      });

      if (resp.status === 429) {
        // gentle backoff once
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

  // MLB
  async getMLBPlayerProps(gameId){ return this.makeRequest(`/v3/mlb/odds/json/BettingPlayerPropsByGame/${gameId}`); }
  async getMLBGameOdds(date){ return this.makeRequest(`/v3/mlb/odds/json/GameOdds/${date}`); }
  async getMLBPlayerStats(date){ return this.makeRequest(`/v3/mlb/stats/json/PlayerGameStatsByDate/${date}`); }
  async getMLBStartingLineups(date){ return this.makeRequest(`/v3/mlb/projections/json/StartingLineupsByDate/${date}`); }

  // NBA
  async getNBAPlayerProps(gameId){ return this.makeRequest(`/v3/nba/odds/json/BettingPlayerPropsByGame/${gameId}`); }
  async getNBAGameOdds(date){ return this.makeRequest(`/v3/nba/odds/json/GameOdds/${date}`); }
  async getNBAPlayerStats(date){ return this.makeRequest(`/v3/nba/stats/json/PlayerGameStatsByDate/${date}`); }

  // WNBA
  async getWNBAPlayerProps(gameId){ return this.makeRequest(`/v3/wnba/odds/json/BettingPlayerPropsByGame/${gameId}`); }
  async getWNBAPlayerStats(date){ return this.makeRequest(`/v3/wnba/stats/json/PlayerGameStatsByDate/${date}`); }

  // NFL
  async getNFLPlayerProps(gameId){ return this.makeRequest(`/v3/nfl/odds/json/BettingPlayerPropsByGame/${gameId}`); }
  async getNFLGameOdds(week){ return this.makeRequest(`/v3/nfl/odds/json/GameOdds/${week}`); }
  async getNFLPlayerStats(week){ return this.makeRequest(`/v3/nfl/stats/json/PlayerGameStatsByWeek/${week}`); }
}
