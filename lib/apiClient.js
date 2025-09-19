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

    // timeout + 429 backoff
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
        // brief backoff, one retry
        await new Promise(r => setTimeout(r, 750));
        const retry = await fetch(url.toString(), { headers: { Accept: "application/json" } });
        clearTimeout(timeout);
        if (!retry.ok) return {};
        return await retry.json();
      }

      clearTimeout(timeout);
      if (!resp.ok) return {};
      return await resp.json();
    } catch {
      clearTimeout(timeout);
      return {};
    }
  }

  // ===================== MLB =====================
  // Player stats/projections
  async getMLBPlayerStats(date) {
    return this.makeRequest(`/v3/mlb/stats/json/PlayerGameStatsByDate/${date}`);
  }
  async getMLBPlayerSeasonStats(season) {
    return this.makeRequest(`/v3/mlb/stats/json/PlayerSeasonStats/${season}`);
  }
  async getMLBPlayerProjectionsByDate(date) {
    return this.makeRequest(`/v3/mlb/projections/json/PlayerGameProjectionStatsByDate/${date}`);
  }
  async getMLBStartingLineups(date) {
    return this.makeRequest(`/v3/mlb/projections/json/StartingLineupsByDate/${date}`);
  }
  // Game odds by date
  async getMLBGameOdds(date) {
    return this.makeRequest(`/v3/mlb/odds/json/GameOdds/${date}`);
  }

  // ===================== NBA =====================
  // Player stats / season
  async getNBAPlayerStats(date) {
    return this.makeRequest(`/v3/nba/stats/json/PlayerGameStatsByDate/${date}`);
  }
  async getNBAPlayerSeasonStats(season) {
    return this.makeRequest(`/v3/nba/stats/json/PlayerSeasonStats/${season}`);
  }
  // Odds by date
  async getNBAGameOdds(date) {
    return this.makeRequest(`/v3/nba/odds/json/GameOdds/${date}`);
  }

  // ===================== WNBA =====================
  async getWNBAPlayerStats(date) {
    return this.makeRequest(`/v3/wnba/stats/json/PlayerGameStatsByDate/${date}`);
  }
  async getWNBAPlayerSeasonStats(season) {
    return this.makeRequest(`/v3/wnba/stats/json/PlayerSeasonStats/${season}`);
  }
  async getWNBAGameOdds(date) {
    return this.makeRequest(`/v3/wnba/odds/json/GameOdds/${date}`);
  }

  // ===================== NFL =====================
  // Season + by-week (note: many free plans allow season, but may restrict week endpoints)
  async getNFLPlayerSeasonStats(seasonKey /* e.g., "2025REG" */) {
    return this.makeRequest(`/v3/nfl/stats/json/PlayerSeasonStats/${seasonKey}`);
  }
  async getNFLPlayerStatsByWeek(seasonKey /* e.g., 2025REG */, week /* int */) {
    return this.makeRequest(`/v3/nfl/stats/json/PlayerGameStatsByWeek/${seasonKey}/${week}`);
  }
  async getNFLCurrentWeek() {
    return this.makeRequest(`/v3/nfl/scores/json/CurrentWeek`);
  }
  async getNFLCurrentSeason() {
    return this.makeRequest(`/v3/nfl/scores/json/CurrentSeason`);
  }
  // Game odds by NFL week
  async getNFLGameOdds(week /* int or "2025REG-3"? */) {
    // SportsDataIO uses /{week} with implicit current season on some plans.
    // For wider compatibility, you can also pass "2025REG-3" on some endpoints.
    return this.makeRequest(`/v3/nfl/odds/json/GameOdds/${week}`);
  }
}
