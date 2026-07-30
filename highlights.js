const crypto = require('crypto');

const MAX_WIN_PTS = 9; // ganar 7-5 = 7 juegos + 2 bonus

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

async function getAIConditionals(groupNum, standings, remaining, remainingPairs, apiKey) {
  const standingsText = standings.map((p, i) =>
    `${i + 1}. ${p.name}: ${p.points} pts (${p.wins}V ${p.losses}D, dif. juegos: ${p.gamesDiff >= 0 ? '+' : ''}${p.gamesDiff}) — pendientes: ${remaining[p.id]}`
  ).join('\n');

  const matchesText = remainingPairs.map(([p1, p2]) => `${p1.name} vs ${p2.name}`).join(', ');

  const prompt = `Analiza la situación del Grupo ${groupNum} de este torneo de tenis y genera frases cortas y asépticas en español.

Sistema de puntos: juegos ganados + 2 bonus por victoria. Desempate: diferencia de juegos, luego juegos ganados. Máximo por partido ganado ≈ 9 pts (ej. 7-5 = 9pts), mínimo 0 (perder 0-6).

Clasificación:
${standingsText}

Partidos pendientes: ${matchesText}

Genera solo los mensajes realmente relevantes (máximo 2 en total), en formato {"highlights": [...]}.
Cada elemento: {"type": "conditional_first"|"conditional_safe", "player": "nombre", "text": "frase"}
- conditional_first: si el líder puede ser alcanzado, di exactamente qué resultado necesitaría el perseguidor (qué partido, qué margen aproximado)
- conditional_safe: si el último puede evitar serlo, di qué necesita

Tono neutro y factual. Sé específico sobre resultados concretos. Si hay demasiados partidos por jugar o el gap es grande, devuelve {"highlights": []}.`;

  try {
    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: process.env.OPENROUTER_MODEL || 'anthropic/claude-haiku-4-5-20251001',
        messages: [{ role: 'user', content: prompt }],
        response_format: { type: 'json_object' },
        max_tokens: 400,
      }),
    });

    const data = await response.json();
    const content = data.choices?.[0]?.message?.content;
    if (!content) return [];
    const parsed = JSON.parse(content);
    return Array.isArray(parsed) ? parsed : (parsed.highlights || []);
  } catch (e) {
    console.error(`AI highlights error (group ${groupNum}):`, e.message);
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
    if (n < 2) { highlights[groupNum] = []; continue; }

    const groupIds = new Set(standings.map(p => p.id));
    const groupMatches = allMatches.filter(m => groupIds.has(m.player1_id));
    const groupPlayers = standings.map(p => ({ id: p.id, name: p.name }));
    const remaining = getRemainingCount(groupPlayers, groupMatches);
    const remainingPairs = getRemainingPairs(groupPlayers, groupMatches);

    const leader = standings[0];
    const last = standings[n - 1];
    const secondToLast = standings[n - 2];

    const groupHighlights = [];

    // Primero matemático: líder.puntos actuales > máximo posible de cualquier perseguidor
    const maxChallenger = Math.max(...standings.slice(1).map(p =>
      p.points + remaining[p.id] * MAX_WIN_PTS
    ));
    const confirmedFirst = leader.points > maxChallenger;

    if (confirmedFirst) {
      groupHighlights.push({
        type: 'confirmed_first',
        player: leader.name,
        text: `${leader.name} está matemáticamente clasificado como primero de grupo.`,
      });
    }

    // Último matemático: el penúltimo no puede ser alcanzado por el último
    const lastMax = last.points + remaining[last.id] * MAX_WIN_PTS;
    const confirmedLast = secondToLast.points > lastMax;

    if (confirmedLast) {
      groupHighlights.push({
        type: 'confirmed_last',
        player: last.name,
        text: `${last.name} no puede evitar terminar último de grupo.`,
      });
    }

    // Salvado matemático: el antepenúltimo (si existe) no puede ser alcanzado por el último
    if (n >= 3) {
      const thirdToLast = standings[n - 3];
      if (thirdToLast && thirdToLast.points > lastMax) {
        groupHighlights.push({
          type: 'safe',
          player: thirdToLast.name,
          text: `${thirdToLast.name} ya no puede terminar último de grupo.`,
        });
      }
    }

    // Condicionales vía IA (solo si hay partidos pendientes y situación sin confirmar)
    const needsAI = (!confirmedFirst || !confirmedLast) && remainingPairs.length > 0 && apiKey;
    if (needsAI) {
      const aiItems = await getAIConditionals(groupNum, standings, remaining, remainingPairs, apiKey);
      groupHighlights.push(...aiItems);
    }

    highlights[groupNum] = groupHighlights;
  }

  return { highlights, hash: currentHash };
}

module.exports = { computeHighlights, standingsHash };
