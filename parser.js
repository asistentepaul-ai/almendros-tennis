const ALL_PLAYERS = [
  'Pepe', 'Javi', 'Raul', 'Pablo',
  'Sergio', 'Mario', 'Jorge', 'Alex',
  'Chus', 'Jacobo', 'JJ', 'Dani', 'Carlos DM',
  'Carlitos', 'Guille', 'Juan', 'Rober',
];

// Regex-based parser — works without any API key
function regexParse(text) {
  const norm = s => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  const t = norm(text);

  // Find all mentioned players (sorted by position in text)
  const found = ALL_PLAYERS
    .map(name => ({ name, pos: t.indexOf(norm(name)) }))
    .filter(p => p.pos !== -1)
    .sort((a, b) => a.pos - b.pos);

  if (found.length < 2) return null;

  const player1 = found[0].name;
  const player2 = found[1].name;

  // Try "Player1 N - Player2 M" format (score split by names)
  // e.g. "Mario 6 - Jorge 3" → p1=Mario g1=6, p2=Jorge g2=3
  const splitScoreRe = /(\w[\w\s]*?)\s+(\d)\s*[-–]\s*(\w[\w\s]*?)\s+(\d)\s*$/i;
  const splitMatch = text.match(splitScoreRe);
  if (splitMatch) {
    const g1 = parseInt(splitMatch[2]);
    const g2 = parseInt(splitMatch[4]);
    if (g1 !== g2) {
      const n1 = splitMatch[1].trim();
      const n2 = splitMatch[3].trim();
      const fp1 = ALL_PLAYERS.find(p => norm(p) === norm(n1) || norm(n1).includes(norm(p)));
      const fp2 = ALL_PLAYERS.find(p => norm(p) === norm(n2) || norm(n2).includes(norm(p)));
      if (fp1 && fp2) {
        return { player1: fp1, player2: fp2, player1_games: g1, player2_games: g2, is_tiebreak: (g1===7&&g2===6)||(g1===6&&g2===7), tiebreak_score: null };
      }
    }
  }

  // Find score: 6-4, 7-5, 7-6(3), 6 - 4, etc.
  const scoreRe = /(\d)\s*[-–]\s*(\d)(?:\((\d+)\))?/;
  const scoreMatch = text.match(scoreRe);
  if (!scoreMatch) return null;

  let g1 = parseInt(scoreMatch[1]);
  let g2 = parseInt(scoreMatch[2]);
  const tbScore = scoreMatch[3] || null;

  if (g1 === g2) return null;

  const isTiebreak = (g1 === 7 && g2 === 6) || (g1 === 6 && g2 === 7);

  // Determine assignment: does player1 have g1 or g2 games?
  // Look for explicit winner clues: "ganó", "gano", "perdió", "perdio", "winner"
  const winnerClues = ['ganó', 'gano', 'gane', 'gané', 'winner', 'wins', 'beat'];
  const loserClues = ['perdió', 'perdio', 'perdi', 'perdí', 'lost', 'loses'];

  // Check if player1 name appears right before a winner-clue word
  const p1NormPos = t.indexOf(norm(player1));
  const p2NormPos = t.indexOf(norm(player2));
  const afterP1 = t.slice(p1NormPos + player1.length, p1NormPos + player1.length + 25);
  const afterP2 = t.slice(p2NormPos + player2.length, p2NormPos + player2.length + 25);

  let p1Wins = g1 > g2; // default: first number belongs to first player mentioned

  if (winnerClues.some(w => afterP1.includes(w))) {
    p1Wins = true; // player1 explicitly won
  } else if (loserClues.some(l => afterP1.includes(l))) {
    p1Wins = false;
  } else if (winnerClues.some(w => afterP2.includes(w))) {
    p1Wins = false;
  } else if (loserClues.some(l => afterP2.includes(l))) {
    p1Wins = true;
  }

  // Assign games so the winner has the higher number
  let player1_games, player2_games;
  if (p1Wins) {
    player1_games = Math.max(g1, g2);
    player2_games = Math.min(g1, g2);
  } else {
    player1_games = Math.min(g1, g2);
    player2_games = Math.max(g1, g2);
  }

  return { player1, player2, player1_games, player2_games, is_tiebreak: isTiebreak, tiebreak_score: tbScore };
}

// AI-enhanced parser via OpenRouter
async function aiParse(text) {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) return null;

  const model = process.env.OPENROUTER_MODEL || 'anthropic/claude-haiku-4.5';

  try {
    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        max_tokens: 300,
        messages: [{
          role: 'user',
          content: `Eres un sistema de análisis de resultados de tenis.

Jugadores válidos: ${ALL_PLAYERS.join(', ')}

Mensaje: "${text}"

Responde SOLO con JSON (sin markdown):
{"player1":"nombre","player2":"nombre","player1_games":N,"player2_games":N,"is_tiebreak":bool,"tiebreak_score":"N" o null}

Si no puedes interpretar, responde: null`,
        }],
      }),
    });

    if (!response.ok) {
      console.error(`aiParse: OpenRouter HTTP ${response.status} (modelo: ${model})`);
      return null;
    }
    const data = await response.json();
    let content = data.choices?.[0]?.message?.content?.trim();
    if (!content || content === 'null') return null;

    // Strip markdown code fences if present
    content = content.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
    if (!content || content === 'null') return null;

    const parsed = JSON.parse(content);
    if (!parsed?.player1 || !parsed?.player2) return null;
    if (parsed.player1_games === parsed.player2_games) return null;

    return parsed;
  } catch {
    return null;
  }
}

async function parseMatchResult(text) {
  // Try AI first if key available, regex as fallback
  if (process.env.OPENROUTER_API_KEY) {
    const aiResult = await aiParse(text);
    if (aiResult) return aiResult;
  }

  return regexParse(text);
}

module.exports = { parseMatchResult, ALL_PLAYERS };
