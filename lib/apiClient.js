// Node 18+ has global fetch. This client:
// - Uses SportsDataIO if key exists (not required)
// - Uses free NBA data (balldontlie) for minutes & simple projection overlay
// - Optional The Odds API for steam detection (if THE_ODDS_API_KEY set)
// - Falls back safely (heuristics) if no data

export class APIClient {
  constructor() {
    this.sportsDataKey = process.env.SPORTSDATA_API_KEY || null;
    this.oddsKey = process.env.THE_ODDS_API_KEY || null;
    this.baseSDIO = 'https://api.sportsdata.io';
  }

  async _json(url, headers = {}) {
    const res = await fetch(url, { headers: { Accept: 'application/json', ...headers } });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText} for ${url}`);
    return res.json();
  }

  // ===== Market implied from UI odds =====
  async getMarketImplied(overOdds, underOdds) {
    const impliedOver = 1 / overOdds;
    const impliedUnder = 1 / underOdds;
    const pMarket = impliedOver / (impliedOver + impliedUnder);
    const vig = (impliedOver + impliedUnder) - 1;
    return { pMarket, vig };
  }

  // ===== Free NBA (balldontlie) =====
  async nbaPlayerSearch(name) {
    const q = encodeURIComponent(name);
    const search = await this._json(`https://www.balldontlie.io/api/v1/players?search=${q}`);
    return search.data?.[0] || null;
  }
  async nbaLastNStats(playerId, n = 10) {
    const stats = await this._json(`https://www.balldontlie.io/api/v1/stats?per_page=${n}&player_ids[]=${playerId}`);
    return stats?.data || [];
  }

  // Minimal projection overlay for NBA rebounds/assists using last-10
  async getNBAOverlayAndWorkload(playerName, statKind /* 'rebounds'|'assists' */) {
    try {
      const p = await this.nbaPlayerSearch(playerName);
      if (!p) return null;
      const rows = await this.nbaLastNStats(p.id, 10);
      if (!rows.length) return null;

      const mins = rows.map(r => parseFloat(r.min || 0) || 0).filter(x => x >= 0);
      const statArr = rows.map(r => statKind === 'rebounds' ? (r.reb ?? 0) : (r.ast ?? 0));

      const meanMin = mins.length ? (mins.reduce((a,b)=>a+b,0)/mins.length) : 28;
      const sdMin = mins.length ? Math.sqrt(mins.reduce((a,b)=>a+(b-meanMin)**2,0)/mins.length) : 6;

      const meanStat = statArr.reduce((a,b)=>a+b,0)/statArr.length;
      const varStat = statArr.reduce((a,b)=>a+(b-meanStat)**2,0)/Math.max(1, statArr.length);
      const sdStat = Math.max(0.8, Math.sqrt(varStat));

      return {
        workload: { meanMin, sdMin },
        overlay: { meanStat, sdStat }
      };
    } catch {
      return null;
    }
  }

  // ===== Optional: Steam detection (graceful if no key) =====
  async getSteamDelta(/* sport, player, propText */) {
    if (!this.oddsKey) return null;
    // NOTE: Implement with your Odds API plan/endpoint that supports props.
    // Return { against: true|false, magnitude: number } or null.
    return null; // graceful noop for now
  }

  // Public adapters
  async getProjectionOverlay({ sport, player, prop, line }) {
    sport = String(sport).toUpperCase();
    if (sport === 'NBA' || sport === 'WNBA') {
      if (/rebound/i.test(prop)) {
        return await this.getNBAOverlayAndWorkload(player, 'rebounds');
      }
      if (/assist/i.test(prop)) {
        return await this.getNBAOverlayAndWorkload(player, 'assists');
      }
    }
    return null;
  }
}
