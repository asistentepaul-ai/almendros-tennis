const fs = require('fs');
const path = require('path');

// En Railway: monta el volumen en /data y configura DATA_DIR=/data
const DB_PATH = path.join(process.env.DATA_DIR || __dirname, 'tennis.json');

// ─────────────────────────────────────────────────────────────────────────────
//  Modelo con RONDAS:
//  {
//    players: [{ id, name }],                        // registro global
//    rounds:  [{ number, groups: { "1": [ids] }, matches: [...] }],
//    nextMatchId, nextPlayerId
//  }
//  - Los resultados nuevos van SIEMPRE a la última ronda (mayor número).
//  - La "ronda actual" para visualización es la última CON resultados
//    (si ninguna tiene, la última).
// ─────────────────────────────────────────────────────────────────────────────

const INITIAL_PLAYERS = [
  { id: 1, name: 'Pepe' }, { id: 2, name: 'Javi' }, { id: 3, name: 'Raul' }, { id: 4, name: 'Pablo' },
  { id: 5, name: 'Sergio' }, { id: 6, name: 'Mario' }, { id: 7, name: 'Jorge' }, { id: 8, name: 'Alex' },
  { id: 9, name: 'Chus' }, { id: 10, name: 'Jacobo' }, { id: 11, name: 'JJ' }, { id: 12, name: 'Dani' },
  { id: 13, name: 'Carlos DM' },
  { id: 14, name: 'Carlitos' }, { id: 15, name: 'Guille' }, { id: 16, name: 'Juan' }, { id: 17, name: 'Rober' },
];

const INITIAL_DATA = {
  players: INITIAL_PLAYERS,
  rounds: [{
    number: 2, // el torneo empezó a registrarse en la ronda 2
    groups: {
      1: [1, 2, 3, 4],
      2: [5, 6, 7, 8],
      3: [9, 10, 11, 12, 13],
      4: [14, 15, 16, 17],
    },
    matches: [],
  }],
  nextMatchId: 1,
  nextPlayerId: 18,
};

// Migración desde el modelo plano (players con group_number + matches en raíz)
function migrate(data) {
  if (data.rounds) return data;
  const groups = {};
  for (const p of data.players) {
    const g = p.group_number;
    if (!groups[g]) groups[g] = [];
    groups[g].push(p.id);
  }
  return {
    players: data.players.map(p => ({ id: p.id, name: p.name })),
    rounds: [{ number: 2, groups, matches: data.matches || [] }],
    nextMatchId: data.nextMatchId || 1,
    nextPlayerId: Math.max(...data.players.map(p => p.id)) + 1,
  };
}

function load() {
  if (!fs.existsSync(DB_PATH)) {
    fs.writeFileSync(DB_PATH, JSON.stringify(INITIAL_DATA, null, 2));
    return structuredClone(INITIAL_DATA);
  }
  const raw = JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
  const data = migrate(raw);
  if (!raw.rounds) save(data); // persistir la migración una sola vez
  return data;
}

function save(data) {
  fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2));
}

// ─────────────────────────────────────────────────────────────────────────────
//  Rondas
// ─────────────────────────────────────────────────────────────────────────────

function latestRound(data) {
  return data.rounds.reduce((a, b) => (b.number > a.number ? b : a));
}

// Ronda "actual" para visualización: la última con resultados; si no hay, la última
function currentViewRoundNumber(data) {
  const withMatches = data.rounds.filter(r => r.matches.length > 0);
  if (withMatches.length > 0) return Math.max(...withMatches.map(r => r.number));
  return latestRound(data).number;
}

function getRound(data, roundNumber) {
  return data.rounds.find(r => r.number === roundNumber) || null;
}

function listRounds() {
  const data = load();
  return {
    rounds: data.rounds
      .map(r => ({ number: r.number, matches: r.matches.length, players: Object.values(r.groups).flat().length }))
      .sort((a, b) => a.number - b.number),
    currentRound: currentViewRoundNumber(data),
    latestRound: latestRound(data).number,
  };
}

// Crea una ronda nueva. groupsByNames: { "1": ["Pepe", "NuevoJugador", ...], ... }
// Jugadores que no existan se dan de alta. Devuelve resumen.
function createRound(number, groupsByNames) {
  const data = load();
  if (getRound(data, number)) {
    throw new Error(`La ronda ${number} ya existe`);
  }
  const norm = s => s.toLowerCase().trim();
  const groups = {};
  const created = [];
  const seen = new Set();

  for (const [g, names] of Object.entries(groupsByNames)) {
    groups[g] = [];
    for (const rawName of names) {
      const name = rawName.trim();
      if (!name) continue;
      if (seen.has(norm(name))) throw new Error(`Jugador repetido en la ronda: ${name}`);
      seen.add(norm(name));
      let player = data.players.find(p => norm(p.name) === norm(name));
      if (!player) {
        player = { id: data.nextPlayerId++, name };
        data.players.push(player);
        created.push(name);
      }
      groups[g].push(player.id);
    }
    if (groups[g].length < 2) throw new Error(`El grupo ${g} necesita al menos 2 jugadores`);
  }

  data.rounds.push({ number, groups, matches: [] });
  save(data);
  return { number, groups: groupsByNames, newPlayers: created };
}

// ─────────────────────────────────────────────────────────────────────────────
//  Jugadores (los resultados operan sobre la ÚLTIMA ronda)
// ─────────────────────────────────────────────────────────────────────────────

function playersOfRound(data, round) {
  const byId = Object.fromEntries(data.players.map(p => [p.id, p]));
  const out = [];
  for (const [g, ids] of Object.entries(round.groups)) {
    for (const id of ids) out.push({ id, name: byId[id]?.name || `#${id}`, group_number: parseInt(g) });
  }
  return out;
}

// Jugadores de la última ronda, con su group_number (compatibilidad con bot/server)
function getAllPlayers() {
  const data = load();
  return playersOfRound(data, latestRound(data));
}

function findPlayer(nameFragment) {
  const norm = s => s.toLowerCase().trim();
  const needle = norm(nameFragment);
  return getAllPlayers().find(p => norm(p.name).includes(needle));
}

function findPlayerExact(name) {
  const norm = s => s.toLowerCase().trim();
  return getAllPlayers().find(p => norm(p.name) === norm(name));
}

// ─────────────────────────────────────────────────────────────────────────────
//  Partidos (siempre sobre la última ronda)
// ─────────────────────────────────────────────────────────────────────────────

function matchExists(player1_id, player2_id) {
  const data = load();
  return latestRound(data).matches.find(
    m => (m.player1_id === player1_id && m.player2_id === player2_id) ||
         (m.player1_id === player2_id && m.player2_id === player1_id)
  );
}

function addMatch({ player1_id, player2_id, player1_games, player2_games, is_tiebreak, tiebreak_score, raw_input, added_by }) {
  const data = load();
  const round = latestRound(data);
  const winner_id = player1_games > player2_games ? player1_id : player2_id;
  const match = {
    id: data.nextMatchId++,
    player1_id,
    player2_id,
    player1_games,
    player2_games,
    winner_id,
    is_tiebreak: is_tiebreak ? 1 : 0,
    tiebreak_score: tiebreak_score || null,
    played_at: new Date().toISOString(),
    raw_input: raw_input || null,
    added_by: added_by || null,
  };
  round.matches.push(match);
  save(data);
  return match.id;
}

function deleteMatch(id) {
  const data = load();
  for (const r of data.rounds) {
    r.matches = r.matches.filter(m => m.id !== id);
  }
  save(data);
}

function clearMatches() {
  // Reinicio de la ÚLTIMA ronda (las anteriores son histórico intocable)
  const data = load();
  latestRound(data).matches = [];
  save(data);
}

function getRecentMatches(limit = 30, roundNumber = null) {
  const data = load();
  const round = roundNumber ? getRound(data, roundNumber) : getRound(data, currentViewRoundNumber(data));
  if (!round) return [];
  const roundPlayers = playersOfRound(data, round);
  const playerMap = Object.fromEntries(roundPlayers.map(p => [p.id, p]));
  const nameMap = Object.fromEntries(data.players.map(p => [p.id, p.name]));
  return [...round.matches]
    .sort((a, b) => new Date(b.played_at) - new Date(a.played_at))
    .slice(0, limit)
    .map(m => ({
      ...m,
      player1_name: nameMap[m.player1_id],
      player2_name: nameMap[m.player2_id],
      winner_name: nameMap[m.winner_id],
      group_number: playerMap[m.player1_id]?.group_number,
    }));
}

// ─────────────────────────────────────────────────────────────────────────────
//  Clasificación
// ─────────────────────────────────────────────────────────────────────────────

function getStandings(roundNumber = null) {
  const data = load();
  const round = roundNumber ? getRound(data, roundNumber) : getRound(data, currentViewRoundNumber(data));
  if (!round) return {};
  const nameMap = Object.fromEntries(data.players.map(p => [p.id, p.name]));
  const result = {};

  for (const [g, ids] of Object.entries(round.groups)) {
    const standings = ids.map(id => {
      const matches = round.matches.filter(m => m.player1_id === id || m.player2_id === id);
      let wins = 0, losses = 0, gamesWon = 0, gamesLost = 0;

      for (const m of matches) {
        const isP1 = m.player1_id === id;
        if (m.winner_id === id) wins++;
        else losses++;
        if (isP1) { gamesWon += m.player1_games; gamesLost += m.player2_games; }
        else { gamesWon += m.player2_games; gamesLost += m.player1_games; }
      }

      return {
        id,
        name: nameMap[id] || `#${id}`,
        group_number: parseInt(g),
        matchesPlayed: matches.length,
        wins,
        losses,
        gamesWon,
        gamesLost,
        gamesDiff: gamesWon - gamesLost,
        // juegos ganados + 2 pts bonus por victoria (normativa Almendros)
        points: gamesWon + wins * 2,
      };
    });

    // Desempate: puntos → dif. juegos → juegos ganados → cara a cara (head-to-head)
    const h2hWinner = (idA, idB) => {
      const m = round.matches.find(x =>
        (x.player1_id === idA && x.player2_id === idB) ||
        (x.player1_id === idB && x.player2_id === idA)
      );
      return m ? m.winner_id : null;
    };
    standings.sort((a, b) => {
      const base = b.points - a.points || b.gamesDiff - a.gamesDiff || b.gamesWon - a.gamesWon;
      if (base !== 0) return base;
      const w = h2hWinner(a.id, b.id);
      if (w === a.id) return -1;
      if (w === b.id) return 1;
      return 0;
    });
    result[g] = standings;
  }

  return result;
}

module.exports = {
  getAllPlayers, findPlayer, findPlayerExact, matchExists, addMatch, deleteMatch,
  clearMatches, getRecentMatches, getStandings, listRounds, createRound,
};
