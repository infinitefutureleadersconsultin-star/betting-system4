// lib/engines/gameLinesEngine.js
// Moneyline engine using SportsDataIO pregame odds.
// HouseFirst + Fusion: market-heavy, with strict safety gates.

export class GameLinesEngine {
  constructor(apiClient) {
    this.apiClient = apiClient || null;
    this.usedEndpoints = [];
    this.dataSource = "fallback";
    this.matchInfo = null;
    this.lastHttp = null;

    this.thresholds = {
      LOCK_CONFIDENCE: 0.70,
      STRONG_LEAN: 0.675,
      LEAN: 0.65,
    };
    this.calibrationFactor = 1.0;
  }

  fmtLocalDate(d){
    const y=d.getFullYear(); const m=String(d.getMonth()+1).padStart(2,'0'); const day=String(d.getDate()).padStart(2,'0');
    return `${y}-${m}-${day}`;
  }
  _tokens(s){ return String(s||"").toLowerCase().split(/\s+/).filter(Boolean); }
  _teamMatches(tokens, name){ const s=String(name||"").toLowerCase(); return tokens.some(t=>s.includes(t)); }
  _pushUsed(tag){ try{ this.usedEndpoints.push(tag);}catch{} }
  _captureLastHttp(){ if (this.apiClient && this.apiClient.lastHttp) this.lastHttp = this.apiClient.lastHttp; }

  _impliedProbFromMoneyline(ml){
    const n=Number(ml); if (!Number.isFinite(n)||n===0) return null;
    if (n>0) return 100/(n+100);
    return Math.abs(n)/(Math.abs(n)+100);
  }

  async _fetchOddsBySport(sport, dateStrOrWeek){
    try {
      if (!this.apiClient) return [];
      if (sport==="MLB" && this.apiClient.getMLBGameOdds){
        this._pushUsed(`MLB:game-odds:${dateStrOrWeek}`);
        const r = await this.apiClient.getMLBGameOdds(dateStrOrWeek); this._captureLastHttp(); return Array.isArray(r)?r:[];
      }
      if (sport==="NBA" && this.apiClient.getNBAGameOdds){
        this._pushUsed(`NBA:game-odds:${dateStrOrWeek}`);
        const r = await this.apiClient.getNBAGameOdds(dateStrOrWeek); this._captureLastHttp(); return Array.isArray(r)?r:[];
      }
      if (sport==="WNBA" && this.apiClient.getWNBAGameOdds){
        this._pushUsed(`WNBA:game-odds:${dateStrOrWeek}`);
        const r = await this.apiClient.getWNBAGameOdds(dateStrOrWeek); this._captureLastHttp(); return Array.isArray(r)?r:[];
      }
      if (sport==="NFL" && this.apiClient.getNFLGameOdds){
        this._pushUsed(`NFL:game-odds:W${dateStrOrWeek}`);
        const r = await this.apiClient.getNFLGameOdds(dateStrOrWeek); this._captureLastHttp(); return Array.isArray(r)?r:[];
      }
      return [];
    } catch { return []; }
  }

  _inferNFLSeasonWeek(dateStr){
    const d = new Date(dateStr);
    let season = d.getFullYear();
    const month = d.getMonth()+1;
    if (month<3) season-=1;
    const sep1 = new Date(season,8,1);
    const firstThu = new Date(sep1);
    while (firstThu.getDay()!==4) firstThu.setDate(firstThu.getDate()+1);
    const diffDays = Math.floor((d-firstThu)/86400000);
    let week = Math.max(1, Math.min(22, Math.floor(diffDays/7)+1));
    return {season, week};
  }

  _fuse(modelProb, marketProb, sharp, nudge){
    const base = 0.25*modelProb + 0.65*marketProb + 0.10*(0.5+(Number(sharp)||0));
    const fused = Math.max(0, Math.min(1, base + (nudge||0)));
    return fused * this.calibrationFactor;
  }

  async evaluateGame(inputRaw){
    const input = {
      sport: String(inputRaw?.sport||"").toUpperCase(),
      team: inputRaw?.team || "",
      opponent: inputRaw?.opponent || "",
      startTime: inputRaw?.startTime || new Date().toISOString(),
    };

    let dateStr;
    try {
      const d = input?.startTime ? new Date(input.startTime) : new Date();
      if (!Number.isFinite(d.getTime())) throw new Error();
      dateStr = this.fmtLocalDate(d);
    } catch { dateStr = this.fmtLocalDate(new Date()); }

    let oddsList = [];
    if (input.sport==="NFL") {
      const { week } = this._inferNFLSeasonWeek(dateStr);
      oddsList = await this._fetchOddsBySport("NFL", week);
      if (!oddsList.length) {
        for (let wOff=-1; wOff>=-3 && !oddsList.length; wOff--){
          const tryW = Math.max(1, week+wOff);
          const tmp = await this._fetchOddsBySport("NFL", tryW);
          if (tmp.length) oddsList = tmp;
        }
      }
    } else {
      const base = new Date(dateStr);
      const choices = [0,-1,1].map(off => { const d=new Date(base); d.setDate(d.getDate()+off); return this.fmtLocalDate(d); });
      for (const ds of choices) {
        const tmp = await this._fetchOddsBySport(input.sport, ds);
        if (tmp.length){ oddsList = tmp; break; }
      }
    }

    const tTokens = this._tokens(input.team);
    const oTokens = this._tokens(input.opponent);
    let matched = null;

    for (const g of oddsList) {
      const home = g?.HomeTeam ?? g?.HomeTeamName ?? g?.HomeTeamKey ?? g?.HomeTeamShort ?? "";
      const away = g?.AwayTeam ?? g?.AwayTeamName ?? g?.AwayTeamKey ?? g?.AwayTeamShort ?? "";
      const homeMatch = this._teamMatches(tTokens, home) || this._teamMatches(oTokens, home);
      const awayMatch = this._teamMatches(tTokens, away) || this._teamMatches(oTokens, away);
      if (homeMatch && awayMatch){ matched = g; break; }
    }

    if (!matched) {
      this.dataSource = this.usedEndpoints.length ? "sportsdata" : "fallback";
      this.matchInfo = null;
      return {
        side: input.team,
        suggestion: "MONEYLINE",
        decision: "PASS",
        finalConfidence: 50.0,
        rawNumbers: { marketProbability:0.5, modelProbability:0.5, fusedProbability:0.5 },
        meta: { dataSource: this.dataSource, usedEndpoints: this.usedEndpoints, matchInfo: this.matchInfo, debug: { lastHttp: this.apiClient?.lastHttp || null } }
      };
    }

    // extract ML from pregame odds block
    let mlHome=null, mlAway=null, book="unknown";
    const books = Array.isArray(matched?.PregameOdds) ? matched.PregameOdds : (Array.isArray(matched?.Odds) ? matched.Odds : null);
    if (Array.isArray(books)) {
      for (const b of books) {
        const h = Number(b?.HomeMoneyLine), a = Number(b?.AwayMoneyLine);
        if (Number.isFinite(h) && Number.isFinite(a)){ mlHome=h; mlAway=a; book=b?.Sportsbook ?? b?.SportsbookDisplayName ?? "book"; break; }
      }
    } else {
      mlHome = Number(matched?.HomeMoneyLine); mlAway = Number(matched?.AwayMoneyLine);
    }

    if (!Number.isFinite(mlHome)||!Number.isFinite(mlAway)) {
      this.dataSource = "sportsdata";
      this.matchInfo = { home: matched?.HomeTeam??"", away: matched?.AwayTeam??"", book };
      return {
        side: input.team,
        suggestion: "MONEYLINE",
        decision: "PASS",
        finalConfidence: 50.0,
        rawNumbers: { marketProbability:0.5, modelProbability:0.5, fusedProbability:0.5 },
        meta: { dataSource: this.dataSource, usedEndpoints: this.usedEndpoints, matchInfo: this.matchInfo, debug: { lastHttp: this.apiClient?.lastHttp || null } }
      };
    }

    const pHome = this._impliedProbFromMoneyline(mlHome) ?? 0.5;
    const pAway = this._impliedProbFromMoneyline(mlAway) ?? 0.5;
    const norm  = pHome + pAway;
    const mHome = norm>0 ? pHome/norm : 0.5;
    const mAway = norm>0 ? pAway/norm : 0.5;

    const userWantsHome = this._teamMatches(tTokens, matched?.HomeTeam ?? matched?.HomeTeamName ?? "");
    const marketProb = userWantsHome ? mHome : mAway;

    const modelProb = 0.5; // placeholder
    const fused = this._fuse(modelProb, marketProb, 0, 0);
    const finalConfidence = Math.round(fused*1000)/10;

    const LOCK = this.thresholds.LOCK_CONFIDENCE*100;
    const SLEAN= this.thresholds.STRONG_LEAN*100;
    const LEAN = this.thresholds.LEAN*100;
    const decision = finalConfidence>=LOCK ? "LOCK" : finalConfidence>=SLEAN ? "STRONG_LEAN" : finalConfidence>=LEAN ? "LEAN" : "PASS";

    this.dataSource = "sportsdata";
    this.matchInfo = { home: matched?.HomeTeam??matched?.HomeTeamName??"", away: matched?.AwayTeam??matched?.AwayTeamName??"", book, mlHome, mlAway, marketHome:mHome, marketAway:mAway };

    return {
      side: input.team,
      suggestion: "MONEYLINE",
      decision,
      finalConfidence,
      rawNumbers: { marketProbability: Number(marketProb.toFixed(3)), modelProbability: Number(modelProb.toFixed(3)), fusedProbability: Number(fused.toFixed(3)) },
      meta: { dataSource: this.dataSource, usedEndpoints: this.usedEndpoints, matchInfo: this.matchInfo, debug: { lastHttp: this.apiClient?.lastHttp || null } }
    };
  }
}
