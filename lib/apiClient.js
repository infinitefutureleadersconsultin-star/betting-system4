// lib/apiClient.js
// SportsDataIO client with pacing, timeout, diagnostics, and convenience methods.
// Exports:
//   default: singleton client
//   named:   apiClient (same singleton)
//   named:   SportsDataIOClient (class)
//   named:   APIClient (alias of class)

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

    // debug state for last HTTP attempt
    this._lastHttp = null;
  }

  get lastHttp() { return this._lastHttp; }
  setApiKey(key) { this.apiKey = key || ""; }
  setBaseURL(url) { if (url) this.baseURL = url.replace(/\/+$/, ""); }

  async makeRequest(endpoint, params = {}) {
    // Diagnostics object for this request
    const diag = { endpoint, params, url: null, ok: false, status: null, error: null };
    try {
      if (!this.apiKey) {
        diag.error = "NO_API_KEY";
        this._lastHttp = diag;
        return {};
      }

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
      diag.url = url.toString();

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 6000);

      const resp = await fetch(diag.url, { headers: { Accept: "application/json" }, signal: controller.signal });
      clearTimeout(timeout);
      diag.status = resp.status;

      if (resp.status === 429) {
        await new Promise(r => setTimeout(r, 900));
        const resp2 = await fetch(diag.url, { headers: { Accept: "application/json" } });
        diag.status = resp2.status;
        if (!resp2.ok) {
          diag.error = `RETRY_FAILED_${resp2.status}`;
          this._lastHttp = diag;
          return {};
        }
        diag.ok = true;
        try { const j2 = await resp2.json(); this._lastHttp = diag; return j2; }
        catch { this._lastHttp = diag; return {}; }
      }

      if (!resp.ok) {
        diag.error = `HTTP_${resp.status}`;
        this._lastHttp = diag;
        return {};
      }

      diag.ok = true;
      try { const j = await resp.json(); this._lastHttp = diag; return j; }
      catch { this._lastHttp = { ...diag, error: "JSON_PARSE" }; return {}; }

    } catch (e) {
      this._lastHttp = { ...diag, error: e?.message || "FETCH_ERROR" };
      return {};
    }
  }

  // -------------------- Convenience Methods (your plan supports these sports) --------------------

  // Teams/Players/Rosters, Schedules, Stats-by-date, Season stats (final only or live/final)
  // MLB
  async getMLBPlayerSeasonStats(season){
    return this.makeRequest(`/v3/mlb/stats/json/PlayerSeasonStats/${season}`);
  }
  async getMLBPlayerStatsByDate(date){
    return this.makeRequest(`/v3/mlb/stats/json/PlayerGameStatsByDate/${date}`);
  }

  // NBA
  async getNBAPlayerSeasonStats(season){
    return this.makeRequest(`/v3/nba/stats/json/PlayerSeasonStats/${season}`);
  }
  async getNBAPlayerStatsByDate(date){
    return this.makeRequest(`/v3/nba/stats/json/PlayerGameStatsByDate/${date}`);
  }

  // WNBA
  async getWNBAPlayerSeasonStats(season){
    return this.makeRequest(`/v3/wnba/stats/json/PlayerSeasonStats/${season}`);
  }
  async getWNBAPlayerStatsByDate(date){
    return this.makeRequest(`/v3/wnba/stats/json/PlayerGameStatsByDate/${date}`);
  }

  // NFL (passing yards via by-week)
  async getNFLPlayerSeasonStats(season){
    return this.makeRequest(`/v3/nfl/stats/json/PlayerSeasonStats/${season}`);
  }
  async getNFLSeasonCurrent(){
    return this.makeRequest(`/v3/nfl/scores/json/CurrentSeason`);
  }
  async getNFLWeekCurrent(){
    return this.makeRequest(`/v3/nfl/scores/json/CurrentWeek`);
  }
  async getNFLPlayerGameStatsByWeek(season, week){
    return this.makeRequest(`/v3/nfl/stats/json/PlayerGameStatsByWeek/${season}/${week}`);
  }

  // Depth charts / injuries (optional but within your access)
  async getMLBInjuries(date){ return this.makeRequest(`/v3/mlb/scores/json/Injuries/${date}`); }
  async getNBAInjuries(date){ return this.makeRequest(`/v3/nba/scores/json/Injuries/${date}`); }
  async getWNBAInjuries(date){ return this.makeRequest(`/v3/wnba/scores/json/Injuries/${date}`); }
  async getNFLInjuries(week){ return this.makeRequest(`/v3/nfl/scores/json/Injuries/${week}`); }

  // Betting – pregame moneylines (game lines) – endpoint shape differs by sport, we wrap common names:
  async getMLBGameOdds(date){ return this.makeRequest(`/v3/mlb/odds/json/GameOddsByDate/${date}`); }
  async getNBAGameOdds(date){ return this.makeRequest(`/v3/nba/odds/json/GameOddsByDate/${date}`); }
  async getWNBAGameOdds(date){ return this.makeRequest(`/v3/wnba/odds/json/GameOddsByDate/${date}`); }
  async getNFLGameOdds(week){ return this.makeRequest(`/v3/nfl/odds/json/LiveGameOddsByWeek/${week}`); } // some plans: PregameOddsByWeek — swap if needed
}

// Singleton & exports
const singleton = new SportsDataIOClient();
export { singleton as apiClient };
export { SportsDataIOClient as APIClient };
export default singleton;
