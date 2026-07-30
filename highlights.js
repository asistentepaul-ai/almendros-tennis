const crypto = require('crypto');

const HIGHLIGHTS_VERSION = 5; // bump: frases exactas por enumeración, sin IA en el tablón
const MAX_WIN_PTS = 9;
const TENNIS_SCORES = [[6,0],[6,1],[6,2],[6,3],[6,4],[7,5],[7,6]];
const MAX_REMAINING_TO_ENUMERATE = 5; // 14^5 ≈ 540k escenarios, <2s

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


function scoreLabel(s) { return `${s[0]}-${s[1]}`; }

function listToText(arr) {
  return arr.length === 1 ? arr[0] : arr.slice(0, -1).join(', ') + ' o ' + arr[arr.length - 1];
}

// Convierte un conjunto de marcadores ganadores en una frase exacta.
// Solo usa "por X-Y o más" cuando el conjunto coincide EXACTAMENTE con
// {marcadores con margen >= m}; si no, enumera los marcadores válidos.
function phraseWinningScores(qualifying) {
  if (qualifying.length === 0) return null;
  if (qualifying.length === TENNIS_SCORES.length) return { any: true };
  const minMargin = Math.min(...qualifying.map(s => s[0] - s[1]));
  const marginSet = TENNIS_SCORES.filter(s => s[0] - s[1] >= minMargin);
  const sameSet = marginSet.length === qualifying.length &&
    marginSet.every(s => qualifying.some(q => q[0] === s[0] && q[1] === s[1]));
  if (sameSet) {
    const rep = qualifying.filter(s => s[0] - s[1] === minMargin).sort((a, b) => a[0] - b[0])[0];
    return { any: false, marginRule: true, rep };
  }
  return { any: false, marginRule: false, list: qualifying.map(scoreLabel) };
}

function winCondText(qual, oppName) {
  const ph = phraseWinningScores(qual);
  if (!ph) return null;
  if (ph.any) return `gana a ${oppName}, con cualquier marcador`;
  if (qual.length === 1) return `gana a ${oppName} exactamente ${scoreLabel(qual[0])}`;
  if (qual.length === TENNIS_SCORES.length - 1) {
    const falta = TENNIS_SCORES.find(s => !qual.some(q => q[0] === s[0] && q[1] === s[1]));
    return `gana a ${oppName} con cualquier marcador salvo ${scoreLabel(falta)}`;
  }
  if (ph.marginRule) return `gana a ${oppName} por ${scoreLabel(ph.rep)} o más`;
  return `gana a ${oppName} ${ph.list.length === 1 ? 'exactamente ' : ''}${listToText(ph.list)}`;
}

function analyze1MatchPredictions(standings, pair, finals, outcomes) {
  const n = standings.length;
  const [pA, pB] = pair;
  const insights = [];
  const first = standings[0], second = standings[1], last = standings[n - 1];

  // Marcadores con los que `playerId` gana y se cumple `pred` sobre la clasificación final
  const qualScores = (playerId, pred) => {
    const qual = [];
    for (let i = 0; i < outcomes.length; i++) {
      const o = outcomes[i][0];
      if (o.winnerId === playerId && pred(finals[i])) qual.push([o.wGames, o.lGames]);
    }
    return qual;
  };

  // --- ÚLTIMO: ¿puede escapar el actual último? ---
  if (pA.id === last.id || pB.id === last.id) {
    const opp = pA.id === last.id ? pB : pA;
    const qual = qualScores(last.id, f => f[n - 1].id !== last.id);
    if (qual.length > 0) {
      insights.push({
        type: 'conditional_safe', player: last.name,
        text: `${last.name} se salva del último puesto si ${winCondText(qual, opp.name)}.`,
      });
    }
  }

  // --- PRIMERO: ¿puede el segundo arrebatar el primer puesto? ---
  if (pA.id === second.id || pB.id === second.id) {
    const opp = pA.id === second.id ? pB : pA;
    const qual = qualScores(second.id, f => f[0].id === second.id);
    if (qual.length > 0) {
      insights.push({
        type: 'conditional_first', player: first.name,
        text: `${first.name} pierde el primer puesto si ${second.name} ${winCondText(qual, opp.name)}.`,
      });
    }
  }

  return insights;
}

function analyzeMultiMatchPredictions(standings, remainingPairs, allOutcomes, finals, firstCount, lastCount, total) {
  const n = standings.length;
  const leader = standings[0];
  const last = standings[n - 1];
  const insights = [];

  // --- AMENAZA AL PRIMER PUESTO ---
  let topChallenger = null, topCount = 0;
  for (const p of standings.slice(1)) {
    if (firstCount[p.id] > topCount) { topCount = firstCount[p.id]; topChallenger = p; }
  }

  if (topChallenger && topCount > 0) {
    const cPairs = remainingPairs.filter(([p1, p2]) => p1.id === topChallenger.id || p2.id === topChallenger.id);
    const vsLeaderPair = cPairs.find(([p1, p2]) => p1.id === leader.id || p2.id === leader.id);

    // Analizar la rama "gana todos sus partidos" — cubre el escenario dominante
    let winsAllCount = 0, winsAllTakes1st = 0;
    for (let i = 0; i < allOutcomes.length; i++) {
      const winsAll = cPairs.every(([p1, p2]) => {
        const oc = allOutcomes[i].find(x =>
          (x.winnerId === p1.id && x.loserId === p2.id) ||
          (x.winnerId === p2.id && x.loserId === p1.id)
        );
        return oc && oc.winnerId === topChallenger.id;
      });
      if (!winsAll) continue;
      winsAllCount++;
      if (finals[i][0].id === topChallenger.id) winsAllTakes1st++;
    }

    if (winsAllTakes1st > 0 && vsLeaderPair) {
      if (winsAllTakes1st === winsAllCount) {
        // Ganar todos SIEMPRE lleva al 1º → condición limpia sin umbral de margen
        const oppNames = cPairs.map(([p1, p2]) => (p1.id === topChallenger.id ? p2 : p1).name).join(' y ');
        insights.push({
          type: 'conditional_first', player: leader.name,
          text: `${leader.name} pierde el primer puesto si ${topChallenger.name} gana sus ${cPairs.length} partidos (${oppNames}).`,
        });
      } else {
        // Ganar todos no siempre basta: el marcador contra el líder decide.
        // Para cada marcador h2h, ¿ganar todos GARANTIZA el 1º (en todos los sub-escenarios)?
        const perScore = new Map();
        for (let i = 0; i < allOutcomes.length; i++) {
          const winsAll = cPairs.every(([p1, p2]) => {
            const oc = allOutcomes[i].find(x =>
              (x.winnerId === p1.id && x.loserId === p2.id) ||
              (x.winnerId === p2.id && x.loserId === p1.id)
            );
            return oc && oc.winnerId === topChallenger.id;
          });
          if (!winsAll) continue;
          const h2h = allOutcomes[i].find(x =>
            (x.winnerId === topChallenger.id && x.loserId === leader.id) ||
            (x.winnerId === leader.id && x.loserId === topChallenger.id)
          );
          if (!h2h) continue;
          const key = `${h2h.wGames}-${h2h.lGames}`;
          const e = perScore.get(key) || { tot: 0, first: 0 };
          e.tot++;
          if (finals[i][0].id === topChallenger.id) e.first++;
          perScore.set(key, e);
        }
        const alwaysSet = TENNIS_SCORES.filter(s => {
          const e = perScore.get(scoreLabel(s));
          return e && e.first === e.tot;
        });
        const otherOpps = cPairs
          .filter(([p1, p2]) => p1.id !== leader.id && p2.id !== leader.id)
          .map(([p1, p2]) => (p1.id === topChallenger.id ? p2 : p1).name);
        const extra = otherOpps.length > 0 ? ` y además gana a ${otherOpps.join(' y ')}` : '';
        if (alwaysSet.length > 0) {
          insights.push({
            type: 'conditional_first', player: leader.name,
            text: `${leader.name} pierde el primer puesto si ${topChallenger.name} le ${winCondText(alwaysSet, leader.name).replace(`gana a ${leader.name}`, 'gana')}${extra}.`,
          });
        } else {
          insights.push({
            type: 'conditional_first', player: leader.name,
            text: `${leader.name} podría perder el primer puesto si ${topChallenger.name} gana sus ${cPairs.length} partidos, según los demás resultados.`,
          });
        }
      }
    } else if (topCount > 0) {
      // Sin partido directo contra el líder, o casos sin "gana todos" suficiente → mensaje genérico
      const oppNames = cPairs.map(([p1, p2]) => (p1.id === topChallenger.id ? p2 : p1).name).join(' y ');
      insights.push({
        type: 'conditional_first', player: leader.name,
        text: `${leader.name} podría perder el primer puesto: ${topChallenger.name} tiene opciones ganando a ${oppNames}.`,
      });
    }
  }

  // --- ESCAPE DEL ÚLTIMO PUESTO ---
  if (lastCount[last.id] < total) {
    const lastPairs = remainingPairs.filter(([p1, p2]) => p1.id === last.id || p2.id === last.id);
    if (lastPairs.length > 0) {
      // ¿Hay algún escenario en que el último gana un partido pero sigue siendo último?
      let winsButStillLast = false;
      for (let i = 0; i < allOutcomes.length; i++) {
        if (finals[i][n - 1].id !== last.id) continue;
        const winsAny = lastPairs.some(([p1, p2]) => {
          const oc = allOutcomes[i].find(x =>
            (x.winnerId === p1.id && x.loserId === p2.id) ||
            (x.winnerId === p2.id && x.loserId === p1.id)
          );
          return oc && oc.winnerId === last.id;
        });
        if (winsAny) { winsButStillLast = true; break; }
      }
      const oppNames = lastPairs.map(([p1, p2]) => (p1.id === last.id ? p2 : p1).name).join(' o ');
      insights.push({
        type: 'conditional_safe', player: last.name,
        text: winsButStillLast
          ? `${last.name} tiene opciones de escapar del último ganando con suficiente margen a ${oppNames}.`
          : `${last.name} se salva del último si gana a ${oppNames}.`,
      });
    }
  }

  return insights;
}

function computeHighlights(allStandings, allMatches, cached) {
  const currentHash = standingsHash(allStandings);
  if (cached?.hash === currentHash && cached?.version === HIGHLIGHTS_VERSION) return cached;

  const highlights = {};

  for (const [groupNum, standings] of Object.entries(allStandings)) {
    const n = standings.length;
    if (n < 2) { highlights[groupNum] = { confirmed: [], predictions: [] }; continue; }

    const groupIds = new Set(standings.map(p => p.id));
    const groupMatches = allMatches.filter(m => groupIds.has(m.player1_id) && groupIds.has(m.player2_id));
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

    // Salvado matemático: solo tiene sentido si quedan partidos
    if (n >= 3 && remainingPairs.length > 0) {
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
      } else {
        // 2-4 partidos: análisis determinista siempre; IA solo como fallback si no hay nada
        const firstCount = {}, lastCount = {};
        for (const p of standings) { firstCount[p.id] = 0; lastCount[p.id] = 0; }
        for (const f of finals) { firstCount[f[0].id]++; lastCount[f[n - 1].id]++; }

        predictions.push(...analyzeMultiMatchPredictions(
          standings, remainingPairs, allOutcomes, finals, firstCount, lastCount, total
        ));

      }
    }

    highlights[groupNum] = { confirmed, predictions };
  }

  return { highlights, hash: currentHash, version: HIGHLIGHTS_VERSION };
}

module.exports = { computeHighlights, standingsHash };
