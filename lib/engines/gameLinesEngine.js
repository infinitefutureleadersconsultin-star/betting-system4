// lib/engines/gameLinesEngine.js
import { StatisticalModels } from "../statisticalModels.js";

export class GameLinesEngine {
  constructor(apiClient) {
    this.apiClient = apiClient || null;
  }

  async evaluateGameLine(inputRaw) {
    const input = {
      sport: inputRaw?.sport || "NBA",
      home: inputRaw?.home || "HOME",
      away: inputRaw?.away || "AWAY",
      line: inputRaw?.line || "-2.5",
      odds: {
        home: Number(inputRaw?.odds?.home) || 1.95,
        away: Number(inputRaw?.odds?.away) || 1.85,
      },
      startTime: inputRaw?.startTime || new Date(Date.now() + 6 * 3600e3).toISOString(),
      venue: inputRaw?.venue || "",
    };

    const impliedHome = 1 / input.odds.home;
    const impliedAway = 1 / input.odds.away;
    const sum = impliedHome + impliedAway;
    const marketHome = sum > 0 ? impliedHome / sum : 0.5;

    const modelHome = 0.5; // placeholder neutral
    const confidence = Math.abs(modelHome - marketHome);
    const percent = Math.round(confidence * 1000) / 10;
    const suggestion = modelHome >= 0.5 ? input.home : input.away;
    const recommendation = percent >= 60 ? "BET" : "PASS";

    return {
      game: `${input.home} vs ${input.away}`,
      line: input.line,
      suggestion,
      confidence: percent,
      recommendation
    };
  }
}
