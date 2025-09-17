export class GameLinesEngine {
  evaluateGameLine(input) {
    const impliedHome = 1 / Number(input?.odds?.home || 2)
    const impliedAway = 1 / Number(input?.odds?.away || 2)
    const pHome = impliedHome / (impliedHome + impliedAway)

    const suggestion = pHome >= 0.5 ? (input.home || 'HOME') : (input.away || 'AWAY')
    const confidence = Math.round(Math.abs(pHome - 0.5) * 2000) / 10 // 0..100

    return {
      game: `${input.home} vs ${input.away}`,
      line: input.line,
      suggestion,
      confidence,
      recommendation: confidence >= 60 ? 'BET' : 'PASS'
    }
  }
}
