const crypto = require('crypto');

const MAX_WIN_PTS = 9;
const TENNIS_SCORES = [[6,0],[6,1],[6,2],[6,3],[6,4],[7,5],[7,6]];
const MAX_REMAINING_TO_ENUMERATE = 4;

function standingsHash(standings) {
  const str = Object.values(standings)
    .flat()
    .map(p => `${p.id}:${p.points}:${p.matchesPlayed}`)
    .join('|');
  return crypto.createHash('md5').update(str).digest('hex').slice(0, 8);
}

function getRemainingCount(players, groupMatches) {
  const groupSize = players.length;
  const result = {};
  for (const p of players) {
    const played = groupMatches.filter(m => m.player1_id === p.id || m.player2_id === p.id).length;
    result[p.id] = Math.max(0, (groupSize - 1) - played);
  }
  return result;
}

function getRemainingPairs(players, groupMatches) {
  const pairs = [];
  for (let i = 0; i < players.length; i++) {
    for (let j = i + 1; j < players.length; j++) {
      const p1 = players[i];
      const p2 = players[j];
      const played = groupMatches.find(m =>
        (m.player1_id === p1.id && m.player2_id === p2.id) ||
        (m.player1_id === p2.id && m.player2_id === p1.id)
      );
      if (!played) pairs.push([p1, p2]);
    }
  }
  return pairs;
}

function simulateFinalStandings(currentStandings, matchOutcomes) {
  const final = currentStandings.map(p => ({
    id: p.id, name: p.name,
    points: p.points, wins: p.wins, losses: p.losses,
    gamesWon: p.gamesWon, gamesLost: p.gamesLost,
  }));
  const map = Object.fromEntries(final.map(p => [p.id, p]));

  for (const o of matchOutcomes) {
    const w = map[o.winnerId];
    const l = map[o.loserId];
    w.points += o.wGames + 2; w.gamesWon += o.wGames; w.gamesLost += o.lGames; w.wins++;
    l.points += o.lGames;     l.gamesWon += o.lGames; l.gamesLost += o.wGames; l.losses++;
  }

  final.sort((a, b) =>
    b.points - a.points ||
    (b.gamesWon - b.gamesLost) - (a.gamesWon - a.gamesLost) ||
    b.gamesWon - a.gamesWon
  );
  return final;
}

function enumerateAllOutcomes(remainingPairs) {
  let outcomes = [[]];
  for (const [p1, p2] of remainingPairs) {
    const expanded = [];
    for (const existing of outcomes) {
      for (const [w, l] of TENNIS_SCORES) {
        expanded.push([...existing, { winnerId: p1.id, loserId: p2.id, wGames: w, lGames: l }]);
        expanded.push([...existing, { winnerId: p2.id, loserId: p1.id, wGames: w, lGames: l }]);
      }
    }
    outcomes = expanded;
  }
  return outcomes;
}

function analyze1MatchPredictions(standings, pair, finals, outcomes) {
  const n = standings.length;
  const [pA, pB] = pair;
  const insights = [];

  const currentFirst = standings[0];
  const currentSecond = standings[1];
  const currentLast = standings[n - 1];

  // --- ÚLTIMO: ¿puede escapar el actual último? ---
  const lastInMatch = pA.id === currentLast.id || pB.id === currentLast.id;

  if (lastInMatch) {
    const opponent = pA.id === currentLast.id ? pB : pA;
    const escapesWhenWins = [];

    for (let i = 0; i < outcomes.length; i++) {
      const o = outcomes[i][0];
      if (o.winnerId === currentLast.id && finals[i][n - 1].id !== currentLast.id) {
        escapesWhenWins.push(o);
      }
    }

    if (escapesWhenWins.length > 0 && escapesWhenWins.length < TENNIS_SCORES.length) {
      const minDiff = Math.min(...escapesWhenWins.map(o => o.wGames - o.lGames));
      const threshold = escapesWhenWins.find(o => o.wGames - o.lGames === minDiff);
      insights.push({
        type: 'conditional_safe', player: currentLast.name,
        text: `${currentLast.name} termina último salvo que gane a ${opponent.name} por ${threshold.wGames}-${threshold.lGames} o más.`,
      });
    } else if (escapesWhenWins.length === TENNIS_SCORES.length) {
      insights.push({
        type: 'conditional_safe', player: currentLast.name,
        text: `${currentLast.name} se salva si gana a ${opponent.name}, con cualquier marcador.`,
      });
    }
  }

  // --- PRIMERO: ¿puede el segundo alcanzar al primero? ---
  const secondInMatch = pA.id === currentSecond.id || pB.id === currentSecond.id;
  if (!secondInMatch) return insights;

  const opponent2 = pA.id === currentSecond.id ? pB : pA;
  const secondTakesFirst = [];

  for (let i = 0; i < outcomes.length; i++) {
    const o = outcomes[i][0];
    if (o.winnerId === currentSecond.id && finals[i][0].id === currentSecond.id) {
      secondTakesFirst.push(o);
    }
  }

  if (secondTakesFirst.length > 0 && secondTakesFirst.length < TENNIS_SCORES.length) {
    const minDiff = Math.min(...secondTakesFirst.map(o => o.wGames - o.lGames));
    const threshold = secondTakesFirst.find(o => o.wGames - o.lGames === minDiff);
    insights.push({
      type: 'conditional_first', player: currentFirst.name,
      text: `${currentFirst.name} pierde el primer puesto si ${currentSecond.name} gana a ${opponent2.name} por ${threshold.wGames}-${threshold.lGames} o más.`,
    });
  } else if (secondTakesFirst.length === TENNIS_SCORES.length) {
    insights.push({
      type: 'conditional_first', player: currentFirst.name,
      text: `${currentFirst.name} pierde el primer puesto si ${currentSecond.name} gana a ${opponent2.name}.`,
    });
  }

  return insights;
}

async function getAIMultiMatchPredictions(groupNum, standings, firstCount, lastCount, total, remainingPairs, apiKey) {
  const n = standings.length;

  // Only call AI if the situation is genuinely competitive (leader/last could change)
  const leader = standings[0];
  const last = standings[n - 1];
  const leaderDominates = firstCount[leader.id] / total > 0.95;
  const lastDominates = lastCount[last.id] / total > 0.95;
  if (leaderDominates && lastDominates) return [];

  const standingsText = standings.map((p, i) =>
    `${i+1}. ${p.name}: ${p.points} pts (${p.wins}V ${p.losses}D, dif. juegos: ${p.gamesDiff >= 0 ? '+' : ''}${p.gamesDiff})`
  ).join('\n');
  const matchesText = remainingPairs.map(([p1, p2]) => `${p1.name} vs ${p2.name}`).join(', ');

  const prompt = `Genera máximo 2 frases cortas y asépticas en español para un tablón de torneo de tenis.
Sistema de puntos: juegos ganados + 2 bonus por victoria. Desempate: diferencia de juegos, luego juegos ganados.

Grupo ${groupNum}. Clasificación actual:
${standingsText}
Partidos pendientes: ${matchesText}

Genera frases que hagan referencia a resultados concretos de partidos, no a porcentajes ni probabilidades.
Ejemplo válido: "X pierde el primero si Y gana a Z y además lo hace por más de 6-3."
Ejemplo válido: "A se salva si gana a B o si C pierde su partido."
Una frase sobre el primero (si la situación es ajustada), una sobre el último (si aplica). Tono neutro.
Formato: {"highlights": [{"type": "conditional_first"|"conditional_safe", "player": "nombre", "text": "frase"}]}`;

  try {
    const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: process.env.OPENROUTER_MODEL || 'anthropic/claude-haiku-4-5-20251001',
        messages: [{ role: 'user', content: prompt }],
        response_format: { type: 'json_object' },
        max_tokens: 200,
      }),
    });
    const data = await res.json();
    const content = data.choices?.[0]?.message?.content;
    if (!content) return [];
    const parsed = JSON.parse(content);
    return Array.isArray(parsed) ? parsed : (parsed.highlights || []);
  } catch (e) {
    console.error(`AI predictions error (group ${groupNum}):`, e.message);
    return [];
  }
}

async function computeHighlights(allStandings, allMatches, cached) {
  const currentHash = standingsHash(allStandings);
  if (cached?.hash === currentHash) return cached;

  const apiKey = process.env.OPENROUTER_API_KEY;
  const highlights = {};

  for (const [groupNum, standings] of Object.entries(allStandings)) {
    const n = standings.length;
    if (n < 2) { highlights[groupNum] = { confirmed: [], predictions: [] }; continue; }

    const groupIds = new Set(standings.map(p => p.id));
    const groupMatches = allMatches.filter(m => groupIds.has(m.player1_id));
    const groupPlayers = standings.map(p => ({ id: p.id, name: p.name }));
    const remaining = getRemainingCount(groupPlayers, groupMatches);
    const remainingPairs = getRemainingPairs(groupPlayers, groupMatches);

    const leader = standings[0];
    const last = standings[n - 1];
    const secondToLast = standings[n - 2];

    const confirmed = [];

    // Primero matemático
    const maxChallenger = Math.max(...standings.slice(1).map(p =>
      p.points + remaining[p.id] * MAX_WIN_PTS
    ));
    const confirmedFirst = leader.points > maxChallenger;
    if (confirmedFirst) {
      confirmed.push({
        type: 'confirmed_first', player: leader.name,
        text: `${leader.name} está matemáticamente clasificado como primero de grupo.`,
      });
    }

    // Último matemático
    const lastMax = last.points + remaining[last.id] * MAX_WIN_PTS;
    const confirmedLast = secondToLast.points > lastMax;
    if (confirmedLast) {
      confirmed.push({
        type: 'confirmed_last', player: last.name,
        text: `${last.name} no puede evitar terminar último de grupo.`,
      });
    }

    // Salvado matemático
    if (n >= 3) {
      const thirdToLast = standings[n - 3];
      if (thirdToLast && thirdToLast.points > lastMax) {
        confirmed.push({
          type: 'safe', player: thirdToLast.name,
          text: `${thirdToLast.name} ya no puede terminar último de grupo.`,
        });
      }
    }

    // Predicciones por enumeración de escenarios
    const predictions = [];
    const canEnumerate = remainingPairs.length > 0 && remainingPairs.length <= MAX_REMAINING_TO_ENUMERATE;
    const hasOpenQuestions = !confirmedFirst || !confirmedLast;

    if (canEnumerate && hasOpenQuestions) {
      const allOutcomes = enumerateAllOutcomes(remainingPairs);
      const finals = allOutcomes.map(o => simulateFinalStandings(standings, o));
      const total = allOutcomes.length;

      if (remainingPairs.length === 1) {
        // Umbral exacto, sin IA
        predictions.push(...analyze1MatchPredictions(standings, remainingPairs[0], finals, allOutcomes));
      } else if (apiKey) {
        // 2-4 partidos: probabilidades + IA para la frase
        const firstCount = {}, lastCount = {};
        for (const p of standings) { firstCount[p.id] = 0; lastCount[p.id] = 0; }
        for (const f of finals) {
          firstCount[f[0].id]++;
          lastCount[f[n - 1].id]++;
        }
        const aiItems = await getAIMultiMatchPredictions(
          groupNum, standings, firstCount, lastCount, total, remainingPairs, apiKey
        );
        predictions.push(...aiItems);
      }
    }

    highlights[groupNum] = { confirmed, predictions };
  }

  return { highlights, hash: currentHash };
}

module.exports = { computeHighlights, standingsHash };
