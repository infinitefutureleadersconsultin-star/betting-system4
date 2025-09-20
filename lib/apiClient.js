// lib/apiClient.js
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

    // lightweight telemetry for diagnostics
    this._lastMeta = null;
  }

  setApiKey(key) { this.apiKey = key || ""; }
  setBaseURL(url) { if (url) this.baseURL = url.replace(/\/+$/, ""); }
  getLastResponseMeta() { return this._lastMeta; }

  async makeRequest(endpoint, params = {}) {
    const expectArray = !!params.expectArray;
    if (!this.apiKey) {
      this._lastMeta = { url: this.baseURL + endpoint, status: 0, ok: false, bytes: 0, reason: "NO_API_KEY" };
      return expectArray ? [] : {};
    }

    // pacing
    const now = Date.now();
    const elapsed = now - this.lastRequestTime;
    if (elapsed < this.rateLimitDelay) {
      await new Promise(r => setTimeout(r, this.rateLimitDelay - elapsed));
    }

    const url = new URL(this.baseURL + endpoint);
    url.searchParams.set("key", this.apiKey);
    for (const [k, v] of Object.entries(params)) {
      if (k === "expectArray") continue;
      if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, v);
    }
    this.lastRequestTime = Date.now();

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 4000);

    try {
      console.log("[SportsDataIO] GET", url.toString());
      const resp = await fetch(url.toString(), {
        headers: { Accept: "application/json" },
        signal: controller.signal
      });
      const status = resp.status;
      console.log("[SportsDataIO] STATUS", status);

      let body, bytes = 0;
      if (status === 429) {
        await new Promise(r => setTimeout(r, 800));
        const resp2 = await fetch(url.toString(), { headers: { Accept: "application/json" } });
        clearTimeout(timeout);
        if (!resp2.ok) {
          this._lastMeta = { url: url.toString(), status: resp2.status, ok: false, bytes: 0, reason: "RATE_LIMIT_SECOND_FAIL" };
          return expectArray ? [] : {};
        }
        const text = await resp2.text();
        bytes = text.length;
        try { body = JSON.parse(text); } catch { body = expectArray ? [] : {}; }
        this._lastMeta = { url: url.toString(), status: resp2.status, ok: true, bytes };
        return body;
      }

      clearTimeout(timeout);
      const text = await resp.text();
      bytes = text.length;
      const ok = resp.ok;
      this._lastMeta = { url: url.toString(), status, ok, bytes };
      if (!ok) return expectArray ? [] : {};
      try { return JSON.parse(text); } catch { return expectArray ? [] : {}; }

    } catch (e) {
      clearTimeout(timeout);
      this._lastMeta = { url: this.baseURL + endpoint, status: -1, ok: false, bytes: 0, reason: "NETWORK_ERROR" };
      return expectArray ? [] : {};
    }
  }

  // -------- Season stats
  async getMLBPlayerSeasonStats(season){ return this.makeRequest(`/v3/mlb/stats/json/PlayerSeasonStats/${season}`, { expectArray: true }); }
  async getNBAPlayerSeasonStats(season){ return this.makeRequest(`/v3/nba/stats/json/PlayerSeasonStats/${season}`, { expectArray: true }); }
  async getWNBAPlayerSeasonStats(season){ return this.makeRequest(`/v3/wnba/stats/json/PlayerSeasonStats/${season}`, { expectArray: true }); }
  async getNFLPlayerSeasonStats(season){ return this.makeRequest(`/v3/nfl/stats/json/PlayerSeasonStats/${season}`, { expectArray: true }); }

  // -------- By-date (per-game) stats
  async getMLBPlayerStatsByDate(date){ return this.makeRequest(`/v3/mlb/stats/json/PlayerGameStatsByDate/${date}`, { expectArray: true }); }
  async getNBAPlayerStatsByDate(date){ return this.makeRequest(`/v3/nba/stats/json/PlayerGameStatsByDate/${date}`, { expectArray: true }); }
  async getWNBAPlayerStatsByDate(date){ return this.makeRequest(`/v3/wnba/stats/json/PlayerGameStatsByDate/${date}`, { expectArray: true }); }

  // -------- Optional projections
  async getMLBPlayerProjectionsByDate(date){ return this.makeRequest(`/v3/mlb/projections/json/PlayerGameProjectionStatsByDate/${date}`, { expectArray: true }); }
  async getNBAPlayerProjectionsByDate(date){ return this.makeRequest(`/v3/nba/projections/json/PlayerGameProjectionStatsByDate/${date}`, { expectArray: true }); }
  async getWNBAPlayerProjectionsByDate(date){ return this.makeRequest(`/v3/wnba/projections/json/PlayerGameProjectionStatsByDate/${date}`, { expectArray: true }); }

  // -------- NFL by-week helpers
  async getNFLSeasonCurrent(){ return this.makeRequest(`/v3/nfl/scores/json/CurrentSeason`); }
  async getNFLWeekCurrent(){ return this.makeRequest(`/v3/nfl/scores/json/CurrentWeek`); }
  async getNFLPlayerGameStatsByWeek(season, week){ return this.makeRequest(`/v3/nfl/stats/json/PlayerGameStatsByWeek/${season}/${week}`, { expectArray: true }); }

  // -------- Odds (Game Lines)
  async getMLBGameOdds(date){ return this.makeRequest(`/v3/mlb/odds/json/GameOddsByDate/${date}`, { expectArray: true }); }
  async getNBAGameOdds(date){ return this.makeRequest(`/v3/nba/odds/json/GameOddsByDate/${date}`, { expectArray: true }); }
  async getWNBAGameOdds(date){ return this.makeRequest(`/v3/wnba/odds/json/GameOddsByDate/${date}`, { expectArray: true }); }
  async getNFLGameOddsByWeek(season, week){ return this.makeRequest(`/v3/nfl/odds/json/GameOddsByWeek/${season}/${week}`, { expectArray: true }); }
}

const singleton = new SportsDataIOClient();
export { singleton as apiClient };
export { SportsDataIOClient as APIClient }; // import { APIClient } from '...'
export default singleton;
