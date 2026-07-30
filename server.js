require('dotenv').config();
const express = require('express');
const path = require('path');
const { exec } = require('child_process');
const { getStandings, getRecentMatches, addMatch, deleteMatch, findPlayer, findPlayerExact, matchExists, getAllPlayers } = require('./db');
const { parseMatchResult } = require('./parser');
const { computeHighlights } = require('./highlights');

let highlightsCache = null;

function triggerSync() {
  const script = path.join(__dirname, 'sync-to-github.sh');
  exec(`bash "${script}"`, (err, stdout, stderr) => {
    if (err) console.error('Sync error:', stderr || err.message);
    else console.log('Sync:', stdout.trim());
  });
}

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Load bot (non-blocking, only if token is set)
require('./bot');

app.get('/api/standings', (req, res) => {
  res.json(getStandings());
});

app.get('/api/matches', (req, res) => {
  const limit = parseInt(req.query.limit) || 30;
  res.json(getRecentMatches(limit));
});

app.get('/api/players', (req, res) => {
  res.json(getAllPlayers());
});

app.get('/api/highlights', async (req, res) => {
  try {
    const standings = getStandings();
    const matches = getRecentMatches(500);
    const result = await computeHighlights(standings, matches, highlightsCache);
    highlightsCache = result;
    res.json(result.highlights);
  } catch (e) {
    console.error('Highlights error:', e.message);
    res.json({});
  }
});

// Parse natural language and save match
app.post('/api/parse', async (req, res) => {
  const { text, added_by } = req.body;
  if (!text) return res.status(400).json({ error: 'text requerido' });

  const parsed = await parseMatchResult(text);
  if (!parsed) return res.json({ success: false, error: 'No se pudo interpretar el resultado' });

  const p1 = findPlayerExact(parsed.player1) || findPlayer(parsed.player1);
  const p2 = findPlayerExact(parsed.player2) || findPlayer(parsed.player2);

  if (!p1 || !p2) {
    const missing = [!p1 && parsed.player1, !p2 && parsed.player2].filter(Boolean).join(' y ');
    return res.json({ success: false, error: `Jugador no encontrado: ${missing}` });
  }

  if (p1.group_number !== p2.group_number) {
    return res.json({ success: false, error: `${p1.name} y ${p2.name} no están en el mismo grupo` });
  }

  if (matchExists(p1.id, p2.id)) {
    return res.json({ success: false, error: `Ya existe un resultado entre ${p1.name} y ${p2.name}` });
  }

  const id = addMatch({
    player1_id: p1.id,
    player2_id: p2.id,
    player1_games: parsed.player1_games,
    player2_games: parsed.player2_games,
    is_tiebreak: parsed.is_tiebreak,
    tiebreak_score: parsed.tiebreak_score,
    raw_input: text,
    added_by: added_by || 'web',
  });

  const winner = parsed.player1_games > parsed.player2_games ? p1 : p2;
  const loser = winner.id === p1.id ? p2 : p1;

  triggerSync();
  res.json({
    success: true,
    id,
    parsed,
    player1: p1.name,
    player2: p2.name,
    winner: winner.name,
    loser: loser.name,
    score: `${parsed.player1_games}-${parsed.player2_games}`,
    group: p1.group_number,
  });
});

// Direct match save (structured input)
app.post('/api/matches', (req, res) => {
  const { player1_id, player2_id, player1_games, player2_games, is_tiebreak, tiebreak_score, added_by } = req.body;
  if (!player1_id || !player2_id) return res.status(400).json({ error: 'Faltan jugadores' });

  if (matchExists(player1_id, player2_id)) {
    return res.status(409).json({ error: 'Ya existe ese partido' });
  }

  const id = addMatch({ player1_id, player2_id, player1_games, player2_games, is_tiebreak, tiebreak_score, added_by });
  triggerSync();
  res.json({ success: true, id });
});

// Delete match (admin)
app.delete('/api/matches/:id', (req, res) => {
  deleteMatch(parseInt(req.params.id));
  res.json({ success: true });
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`🎾 Tennis Ranking corriendo en http://localhost:${PORT}`);
});
