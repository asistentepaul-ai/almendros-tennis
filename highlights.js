// Tablón: hechos ciertos + hipótesis de escenarios.
// Arquitectura en dos capas:
//   1. MOTOR DETERMINISTA — enumera todos los desenlaces posibles de los
//      partidos pendientes y deriva hechos demostrables (nunca inventa).
//   2. REDACCIÓN — plantillas deterministas; opcionalmente la IA (Haiku vía
//      OpenRouter) re-redacta para sonar natural, con VALIDACIÓN estricta
//      (mismos jugadores, mismos marcadores) y fallback a la plantilla.
try { require('dotenv').config(); } catch (_) {}
const crypto = require('crypto');

const HIGHLIGHTS_VERSION = 8; // bump: desempate head-to-head (igual que la clasificación real)
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

// ─────────────────────────────────────────────────────────────────────────────
//  Utilidades de enumeración
// ─────────────────────────────────────────────────────────────────────────────

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

function simulateFinalStandings(currentStandings, matchOutcomes, baseH2H) {
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

  // Cara a cara: partidos jugados (baseH2H) + los simulados en este escenario
  const h2hWinner = (idA, idB) => {
    for (const o of matchOutcomes) {
      if ((o.winnerId === idA && o.loserId === idB) || (o.winnerId === idB && o.loserId === idA)) {
        return o.winnerId;
      }
    }
    return (baseH2H && baseH2H[`${Math.min(idA, idB)}_${Math.max(idA, idB)}`]) || null;
  };

  final.sort((a, b) => {
    const base = b.points - a.points ||
      (b.gamesWon - b.gamesLost) - (a.gamesWon - a.gamesLost) ||
      b.gamesWon - a.gamesWon;
    if (base !== 0) return base;
    const w = h2hWinner(a.id, b.id);
    if (w === a.id) return -1;
    if (w === b.id) return 1;
    return 0;
  });
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

// ─────────────────────────────────────────────────────────────────────────────
//  Redacción determinista de condiciones de marcador
// ─────────────────────────────────────────────────────────────────────────────

function scoreLabel(s) { return `${s[0]}-${s[1]}`; }

function listToText(arr) {
  return arr.length === 1 ? arr[0] : arr.slice(0, -1).join(', ') + ' o ' + arr[arr.length - 1];
}

// Convierte un conjunto de marcadores ganadores en una condición exacta.
// Solo usa "por X-Y o más" cuando el conjunto coincide EXACTAMENTE con
// {marcadores con margen >= m}; si no, enumera o usa "salvo X".
function condSuffix(qualifying) {
  if (qualifying.length === 0) return null;
  if (qualifying.length === TENNIS_SCORES.length) return '';        // cualquier marcador
  if (qualifying.length === 1) return ` exactamente ${scoreLabel(qualifying[0])}`;
  if (qualifying.length === TENNIS_SCORES.length - 1) {
    const falta = TENNIS_SCORES.find(s => !qualifying.some(q => q[0] === s[0] && q[1] === s[1]));
    return ` con cualquier marcador salvo ${scoreLabel(falta)}`;
  }
  const minMargin = Math.min(...qualifying.map(s => s[0] - s[1]));
  const marginSet = TENNIS_SCORES.filter(s => s[0] - s[1] >= minMargin);
  const sameSet = marginSet.length === qualifying.length &&
    marginSet.every(s => qualifying.some(q => q[0] === s[0] && q[1] === s[1]));
  if (sameSet) {
    const rep = qualifying.filter(s => s[0] - s[1] === minMargin).sort((a, b) => a[0] - b[0])[0];
    return ` por ${scoreLabel(rep)} o más`;
  }
  return ` ${listToText(qualifying.map(scoreLabel))}`;
}

// ─────────────────────────────────────────────────────────────────────────────
//  Análisis con 1 partido pendiente: hechos integrales por enumeración exacta
// ─────────────────────────────────────────────────────────────────────────────

function analyze1MatchPredictions(standings, pair, finals, outcomes) {
  const n = standings.length;
  const [pA, pB] = pair;
  const leader = standings[0];
  const last = standings[n - 1];
  const confirmed = [];
  const predictions = [];
  const TOTAL = outcomes.length; // 14 desenlaces posibles

  // Subconjunto de desenlaces (victorias de cualquiera de los dos) que cumplen `pred`
  const subset = pred => {
    const S = [];
    for (let i = 0; i < outcomes.length; i++) if (pred(finals[i])) S.push(outcomes[i][0]);
    return S;
  };
  const sideScores = (S, playerId) =>
    S.filter(o => o.winnerId === playerId).map(o => [o.wGames, o.lGames]);
  // Describe un subconjunto como condición legible, cubriendo ambos lados del partido
  const describe = S => {
    const a = sideScores(S, pA.id), b = sideScores(S, pB.id);
    const parts = [];
    if (a.length) parts.push(`${pA.name} gana a ${pB.name}${condSuffix(a)}`);
    if (b.length) parts.push(`${pB.name} gana a ${pA.name}${condSuffix(b)}`);
    return parts.join(' o si ');
  };
  const complement = S =>
    outcomes.map(o => o[0]).filter(o =>
      !S.some(s => s.winnerId === o.winnerId && s.wGames === o.wGames && s.lGames === o.lGames));

  // Certezas por enumeración (más finas que la cota de puntos)
  const firstCount = {}, lastCount = {};
  for (const p of standings) { firstCount[p.id] = 0; lastCount[p.id] = 0; }
  for (const f of finals) { firstCount[f[0].id]++; lastCount[f[n - 1].id]++; }

  if (firstCount[leader.id] === TOTAL) {
    confirmed.push({
      type: 'confirmed_first', player: leader.name,
      text: `${leader.name} terminará primero de grupo, pase lo que pase en el partido pendiente.`,
    });
  }
  if (lastCount[last.id] === TOTAL) {
    confirmed.push({
      type: 'confirmed_last', player: last.name,
      text: `${last.name} terminará último de grupo, pase lo que pase en el partido pendiente.`,
    });
  }

  // 1) ¿Quién puede GANAR EL GRUPO (aparte del líder actual)?
  for (const X of standings) {
    if (X.id === leader.id || firstCount[X.id] === 0) continue;
    const S = subset(f => f[0].id === X.id);
    const cond = describe(S).replace(new RegExp(`^${X.name} gana a `), 'gana a ');
    predictions.push({
      type: 'conditional_first', player: X.name,
      text: `${X.name} gana el grupo si ${cond}.`,
    });
  }

  // 2) El último actual: ¿cuándo se salva? (condición completa: victorias Y derrotas)
  if (lastCount[last.id] > 0 && lastCount[last.id] < TOTAL) {
    const S_last = subset(f => f[n - 1].id === last.id);
    if (S_last.length <= 3) {
      predictions.push({
        type: 'conditional_safe', player: last.name,
        text: `${last.name} solo acaba último si ${describe(S_last)}; con cualquier otro resultado se salva.`,
      });
    } else {
      predictions.push({
        type: 'conditional_safe', player: last.name,
        text: `${last.name} se salva del último puesto si ${describe(complement(S_last))}.`,
      });
    }
  }

  // 3) ¿Quién puede CAER al último puesto sin serlo ahora?
  for (const O of standings) {
    if (O.id === last.id || lastCount[O.id] === 0 || lastCount[O.id] === TOTAL) continue;
    const S_O = subset(f => f[n - 1].id === O.id);
    if (S_O.length >= TOTAL - 3) {
      const excep = describe(complement(S_O)).replace(/\bgana a\b/g, 'gane a').replace(/ o si /g, ' o que ');
      predictions.push({
        type: 'conditional_last', player: O.name,
        text: `${O.name} acabará último salvo que ${excep}.`,
      });
    } else {
      predictions.push({
        type: 'conditional_last', player: O.name,
        text: `${O.name} caería al último puesto si ${describe(S_O)}.`,
      });
    }
  }

  // 4) El líder actual, si juega: condición completa de retención
  if ((pA.id === leader.id || pB.id === leader.id) && firstCount[leader.id] < TOTAL) {
    const opp = pA.id === leader.id ? pB : pA;
    const S_keep = subset(f => f[0].id === leader.id);
    const winKeep = sideScores(S_keep, leader.id);
    const loseKeep = sideScores(S_keep, opp.id); // el rival gana pero el líder sigue 1º
    if (winKeep.length === TENNIS_SCORES.length && loseKeep.length > 0) {
      predictions.push({
        type: 'conditional_first', player: leader.name,
        text: `${leader.name} será primero si gana a ${opp.name} — e incluso si pierde${condSuffix(loseKeep).replace(' exactamente', '')}, seguiría primero.`,
      });
    } else if (winKeep.length === TENNIS_SCORES.length) {
      predictions.push({
        type: 'conditional_first', player: leader.name,
        text: `${leader.name} será primero si gana a ${opp.name}; si pierde, el primer puesto se decide por el marcador.`,
      });
    } else {
      predictions.push({
        type: 'conditional_first', player: leader.name,
        text: `${leader.name} conserva el primer puesto si ${describe(S_keep)}.`,
      });
    }
  }

  return { confirmed, predictions };
}

// ─────────────────────────────────────────────────────────────────────────────
//  Análisis con 2-5 partidos pendientes
// ─────────────────────────────────────────────────────────────────────────────

function analyzeMultiMatchPredictions(standings, remainingPairs, allOutcomes, finals, firstCount, lastCount, total) {
  const n = standings.length;
  const leader = standings[0];
  const last = standings[n - 1];
  const confirmed = [];
  const predictions = [];

  // Certezas por enumeración
  if (firstCount[leader.id] === total) {
    confirmed.push({
      type: 'confirmed_first', player: leader.name,
      text: `${leader.name} terminará primero de grupo, pase lo que pase en los partidos pendientes.`,
    });
  }
  if (lastCount[last.id] === total) {
    confirmed.push({
      type: 'confirmed_last', player: last.name,
      text: `${last.name} terminará último de grupo, pase lo que pase en los partidos pendientes.`,
    });
  }

  // El último, ¿sigue vivo incluso para ganar el grupo?
  if (firstCount[last.id] > 0) {
    predictions.push({
      type: 'conditional_first', player: last.name,
      text: `${last.name}, ahora último, sigue con opciones incluso de ganar el grupo.`,
    });
  }

  // --- AMENAZA AL PRIMER PUESTO ---
  let topChallenger = null, topCount = 0;
  for (const p of standings.slice(1)) {
    if (firstCount[p.id] > topCount) { topCount = firstCount[p.id]; topChallenger = p; }
  }

  if (topChallenger && topCount > 0 && firstCount[leader.id] < total) {
    const cPairs = remainingPairs.filter(([p1, p2]) => p1.id === topChallenger.id || p2.id === topChallenger.id);
    const vsLeaderPair = cPairs.find(([p1, p2]) => p1.id === leader.id || p2.id === leader.id);

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

    if (winsAllTakes1st > 0 && winsAllTakes1st === winsAllCount) {
      const oppNames = cPairs.map(([p1, p2]) => (p1.id === topChallenger.id ? p2 : p1).name).join(' y ');
      predictions.push({
        type: 'conditional_first', player: leader.name,
        text: `${leader.name} pierde el primer puesto si ${topChallenger.name} gana sus ${cPairs.length} partidos (${oppNames}).`,
      });
    } else if (winsAllTakes1st > 0 && vsLeaderPair) {
      // Para cada marcador del cara a cara, ¿ganar todos GARANTIZA el vuelco?
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
        predictions.push({
          type: 'conditional_first', player: leader.name,
          text: `${leader.name} pierde el primer puesto si ${topChallenger.name} le gana${condSuffix(alwaysSet)}${extra}.`,
        });
      } else {
        predictions.push({
          type: 'conditional_first', player: leader.name,
          text: `${leader.name} podría perder el primer puesto si ${topChallenger.name} gana sus ${cPairs.length} partidos, según los demás resultados.`,
        });
      }
    } else if (topCount > 0) {
      const oppNames = cPairs.map(([p1, p2]) => (p1.id === topChallenger.id ? p2 : p1).name).join(' y ');
      predictions.push({
        type: 'conditional_first', player: leader.name,
        text: `${leader.name} podría perder el primer puesto: ${topChallenger.name} tiene opciones ganando a ${oppNames}.`,
      });
    }
  }

  // --- ESCAPE DEL ÚLTIMO PUESTO ---
  if (lastCount[last.id] < total && firstCount[last.id] === 0) {
    const lastPairs = remainingPairs.filter(([p1, p2]) => p1.id === last.id || p2.id === last.id);
    if (lastPairs.length > 0) {
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
      predictions.push({
        type: 'conditional_safe', player: last.name,
        text: winsButStillLast
          ? `${last.name} tiene opciones de escapar del último puesto ganando con suficiente margen a ${oppNames}.`
          : `${last.name} se salva del último puesto si gana a ${oppNames}.`,
      });
    }
  }

  // --- RIESGO DE CAER AL ÚLTIMO (el peor clasificado no-último con riesgo real) ---
  for (const O of standings) {
    if (O.id === last.id || lastCount[O.id] === 0 || lastCount[O.id] === total) continue;
  }
  const enRiesgo = [...standings].reverse().find(O =>
    O.id !== last.id && lastCount[O.id] > 0 && lastCount[O.id] < total
  );
  if (enRiesgo) {
    predictions.push({
      type: 'conditional_last', player: enRiesgo.name,
      text: `${enRiesgo.name} todavía podría caer al último puesto, según los resultados pendientes.`,
    });
  }

  return { confirmed, predictions };
}

// ─────────────────────────────────────────────────────────────────────────────
//  Estilista IA (opcional): re-redacta las frases deterministas y se valida.
//  Si la validación falla o la API no responde, se publican las plantillas.
// ─────────────────────────────────────────────────────────────────────────────

function extractScores(text) {
  return (text.match(/\b\d-\d\b/g) || []).sort();
}

function mentionedPlayers(text, groupNames) {
  return groupNames.filter(nm => text.includes(nm)).sort();
}

function validateStyled(styled, source, groupNames) {
  if (typeof styled !== 'string' || styled.length < 10 || styled.length > 220) return false;
  if (/%|probab|quizá|seguramente|posiblemente/i.test(styled)) return false;
  // Fidelidad: mismos marcadores exactos y mismos jugadores mencionados
  if (JSON.stringify(extractScores(styled)) !== JSON.stringify(extractScores(source))) return false;
  if (JSON.stringify(mentionedPlayers(styled, groupNames)) !== JSON.stringify(mentionedPlayers(source, groupNames))) return false;
  return true;
}

// Frases con lógica de excepción/negación: la IA puede invertir el sentido
// (verificado en pruebas) y la validación léxica no lo detecta → no se estilizan.
function hasExceptionLogic(text) {
  return /salvo|excepto|solo |sólo |únicamente|cualquier otro| no /i.test(text);
}

async function styleWithAI(groupNum, items, groupNames) {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey || process.env.TABLON_AI === '0' || items.length === 0) return items;
  const eligible = items.map((it, idx) => ({ it, idx })).filter(x => !hasExceptionLogic(x.it.text));
  if (eligible.length === 0) return items;

  const model = process.env.OPENROUTER_MODEL || 'anthropic/claude-haiku-4.5';
  const prompt = `Reescribe estas frases de un tablón de torneo de tenis entre amigos para que las entienda cualquiera a la primera. Lenguaje llano y directo, estructura "si pasa X, entonces Y".
REGLAS ESTRICTAS: conserva exactamente los mismos jugadores, los mismos marcadores (ej. 6-0, 7-5) y las mismas condiciones lógicas COMPLETAS (si la original cubre victoria y derrota, la tuya también). Nada de probabilidades, números nuevos ni jugadores nuevos. Una frase por entrada, máximo 200 caracteres.

${eligible.map((x, i) => `${i}: ${x.it.text}`).join('\n')}

Responde SOLO con JSON: {"items":[{"i":0,"text":"..."}]}`;

  try {
    const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: prompt }],
        response_format: { type: 'json_object' },
        max_tokens: 500,
      }),
    });
    if (!res.ok) {
      console.error(`styleWithAI: OpenRouter HTTP ${res.status} (grupo ${groupNum}, modelo ${model})`);
      return items;
    }
    const data = await res.json();
    let content = data.choices?.[0]?.message?.content;
    if (!content) return items;
    content = content.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
    const parsed = JSON.parse(content);
    const styledMap = new Map((parsed.items || []).map(x => [x.i, x.text]));
    const out = [...items];
    eligible.forEach((x, i) => {
      const styled = styledMap.get(i);
      if (styled && !hasExceptionLogic(styled) === false) { /* styled puede introducir negaciones: revalidar abajo */ }
      if (styled && validateStyled(styled, x.it.text, groupNames)) {
        out[x.idx] = { ...x.it, text: styled, styled: true };
      }
    });
    return out;
  } catch (e) {
    console.error(`styleWithAI error (grupo ${groupNum}):`, e.message);
    return items;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  Orquestación
// ─────────────────────────────────────────────────────────────────────────────

const PRED_ORDER = { conditional_first: 0, conditional_safe: 1, conditional_last: 2 };
const MAX_PREDICTIONS_PER_GROUP = 4;

function dedupe(items) {
  const seen = new Set();
  return items.filter(it => {
    const k = `${it.type}|${it.player}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

async function computeHighlights(allStandings, allMatches, cached) {
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

    let confirmed = [];
    let predictions = [];

    // Certezas por cota de puntos (válidas aunque no se pueda enumerar)
    const maxChallenger = Math.max(...standings.slice(1).map(p =>
      p.points + remaining[p.id] * MAX_WIN_PTS
    ));
    if (leader.points > maxChallenger) {
      confirmed.push({
        type: 'confirmed_first', player: leader.name,
        text: `${leader.name} está matemáticamente clasificado como primero de grupo.`,
      });
    }
    const lastMax = last.points + remaining[last.id] * MAX_WIN_PTS;
    if (secondToLast.points > lastMax) {
      confirmed.push({
        type: 'confirmed_last', player: last.name,
        text: `${last.name} no puede evitar terminar último de grupo.`,
      });
    }
    if (n >= 3 && remainingPairs.length > 0) {
      const thirdToLast = standings[n - 3];
      if (thirdToLast && thirdToLast.points > lastMax) {
        confirmed.push({
          type: 'safe', player: thirdToLast.name,
          text: `${thirdToLast.name} ya no puede terminar último de grupo.`,
        });
      }
    }

    // Hipótesis por enumeración exhaustiva
    if (remainingPairs.length > 0 && remainingPairs.length <= MAX_REMAINING_TO_ENUMERATE) {
      const allOutcomes = enumerateAllOutcomes(remainingPairs);
      const baseH2H = {};
      for (const m of groupMatches) {
        baseH2H[`${Math.min(m.player1_id, m.player2_id)}_${Math.max(m.player1_id, m.player2_id)}`] = m.winner_id;
      }
      const finals = allOutcomes.map(o => simulateFinalStandings(standings, o, baseH2H));
      const total = allOutcomes.length;

      let result;
      if (remainingPairs.length === 1) {
        result = analyze1MatchPredictions(standings, remainingPairs[0], finals, allOutcomes);
      } else {
        const firstCount = {}, lastCount = {};
        for (const p of standings) { firstCount[p.id] = 0; lastCount[p.id] = 0; }
        for (const f of finals) { firstCount[f[0].id]++; lastCount[f[n - 1].id]++; }
        result = analyzeMultiMatchPredictions(
          standings, remainingPairs, allOutcomes, finals, firstCount, lastCount, total
        );
      }
      confirmed.push(...result.confirmed);
      predictions.push(...result.predictions);
    }

    confirmed = dedupe(confirmed);
    predictions = dedupe(predictions)
      .sort((a, b) => (PRED_ORDER[a.type] ?? 9) - (PRED_ORDER[b.type] ?? 9))
      .slice(0, MAX_PREDICTIONS_PER_GROUP);

    // Capa de redacción natural (opcional, validada, con fallback)
    const groupNames = standings.map(p => p.name);
    predictions = await styleWithAI(groupNum, predictions, groupNames);

    highlights[groupNum] = { confirmed, predictions };
  }

  return { highlights, hash: currentHash, version: HIGHLIGHTS_VERSION };
}

module.exports = { computeHighlights, standingsHash };
