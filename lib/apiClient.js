// lib/apiClient.js
export class APIClient {
  constructor(apiKey) {
    this.apiKey = apiKey;
    this.baseURL = 'https://api.sportsdata.io';
    this.rateLimitDelay = 1000; // 1 second between requests
    this.lastRequestTime = 0;
  }

  async makeRequest(endpoint, params = {}) {
    // Simple rate limit
    const now = Date.now();
    const dt = now - this.lastRequestTime;
    if (dt < this.rateLimitDelay) {
      await new Promise(r => setTimeout(r, this.rateLimitDelay - dt));
    }

    try {
      const url = new URL(`${this.baseURL}${endpoint}`);
      url.searchParams.append('key', this.apiKey);
      Object.entries(params).forEach(([k, v]) => {
        if (v !== null && v !== undefined) url.searchParams.append(k, v);
      });

      this.lastRequestTime = Date.now();

      const resp = await fetch(url.toString(), {
        headers: {
          Accept: 'application/json',
          'User-Agent': 'MasterBettingSystem/1.0'
        }
      });

      if (!resp.ok) {
        throw new Error(`API Error: ${resp.status} - ${resp.statusText}`);
      }
      return await resp.json();
    } catch (err) {
      console.error('API Request failed:', err);
      throw err;
    }
  }

  // ---------- MLB ----------
  async getMLBPlayerProps(gameId) {
    return this.makeRequest(`/v3/mlb/odds/json/BettingPlayerPropsByGame/${gameId}`);
  }
  async getMLBGameOdds(date) {
    return this.makeRequest(`/v3/mlb/odds/json/GameOdds/${date}`);
  }
  async getMLBPlayerStats(date) {
    return this.makeRequest(`/v3/mlb/stats/json/PlayerGameStatsByDate/${date}`);
  }
  async getMLBStartingLineups(date) {
    return this.makeRequest(`/v3/mlb/projections/json/StartingLineupsByDate/${date}`);
  }

  // ---------- NBA ----------
  async getNBAPlayerProps(gameId) {
    return this.makeRequest(`/v3/nba/odds/json/BettingPlayerPropsByGame/${gameId}`);
  }
  async getNBAGameOdds(date) {
    return this.makeRequest(`/v3/nba/odds/json/GameOdds/${date}`);
  }
  async getNBAPlayerStats(date) {
    return this.makeRequest(`/v3/nba/stats/json/PlayerGameStatsByDate/${date}`);
  }

  // ---------- WNBA ----------
  async getWNBAPlayerProps(gameId) {
    return this.makeRequest(`/v3/wnba/odds/json/BettingPlayerPropsByGame/${gameId}`);
  }
  async getWNBAPlayerStats() {
    return this.makeRequest(`/v3/wnba/stats/json/PlayerSeasonStats/`);
  }

  // ---------- NFL ----------
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
