const fs = require('fs');
const path = require('path');

// En Railway: monta el volumen en /data y configura DATA_DIR=/data
const DB_PATH = path.join(process.env.DATA_DIR || __dirname, 'tennis.json');

const INITIAL_DATA = {
  players: [
    // Grupo 1
    { id: 1, name: 'Pepe', group_number: 1 },
    { id: 2, name: 'Javi', group_number: 1 },
    { id: 3, name: 'Raul', group_number: 1 },
    { id: 4, name: 'Pablo', group_number: 1 },
    // Grupo 2
    { id: 5, name: 'Sergio', group_number: 2 },
    { id: 6, name: 'Mario', group_number: 2 },
    { id: 7, name: 'Jorge', group_number: 2 },
    { id: 8, name: 'Alex', group_number: 2 },
    // Grupo 3
    { id: 9,  name: 'Chus',      group_number: 3 },
    { id: 10, name: 'Jacobo',    group_number: 3 },
    { id: 11, name: 'JJ',        group_number: 3 },
    { id: 12, name: 'Dani',      group_number: 3 },
    { id: 13, name: 'Carlos DM', group_number: 3 },
    // Grupo 4
    { id: 14, name: 'Carlitos', group_number: 4 },
    { id: 15, name: 'Guille',   group_number: 4 },
    { id: 16, name: 'Juan',     group_number: 4 },
    { id: 17, name: 'Rober',    group_number: 4 },
  ],
  matches: [],
  nextMatchId: 1,
};

function load() {
  if (!fs.existsSync(DB_PATH)) {
    fs.writeFileSync(DB_PATH, JSON.stringify(INITIAL_DATA, null, 2));
    return structuredClone(INITIAL_DATA);
  }
  return JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
}

function save(data) {
  fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2));
}

function getAllPlayers() {
  return load().players;
}

function findPlayer(nameFragment) {
  const norm = s => s.toLowerCase().trim();
  const needle = norm(nameFragment);
  return load().players.find(p => norm(p.name).includes(needle));
}

function findPlayerExact(name) {
  const norm = s => s.toLowerCase().trim();
  return load().players.find(p => norm(p.name) === norm(name));
}

function matchExists(player1_id, player2_id) {
  return load().matches.find(
    m => (m.player1_id === player1_id && m.player2_id === player2_id) ||
         (m.player1_id === player2_id && m.player2_id === player1_id)
  );
}

function addMatch({ player1_id, player2_id, player1_games, player2_games, is_tiebreak, tiebreak_score, raw_input, added_by }) {
  const data = load();
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
  data.matches.push(match);
  save(data);
  return match.id;
}

function deleteMatch(id) {
  const data = load();
  data.matches = data.matches.filter(m => m.id !== id);
  save(data);
}

function getRecentMatches(limit = 30) {
  const data = load();
  const playerMap = Object.fromEntries(data.players.map(p => [p.id, p]));
  return [...data.matches]
    .sort((a, b) => new Date(b.played_at) - new Date(a.played_at))
    .slice(0, limit)
    .map(m => ({
      ...m,
      player1_name: playerMap[m.player1_id]?.name,
      player2_name: playerMap[m.player2_id]?.name,
      winner_name: playerMap[m.winner_id]?.name,
      group_number: playerMap[m.player1_id]?.group_number,
    }));
}

function getStandings() {
  const data = load();
  const result = {};

  for (let g = 1; g <= 4; g++) {
    const players = data.players.filter(p => p.group_number === g);
    const standings = players.map(player => {
      const matches = data.matches.filter(m => m.player1_id === player.id || m.player2_id === player.id);
      let wins = 0, losses = 0, gamesWon = 0, gamesLost = 0;

      for (const m of matches) {
        const isP1 = m.player1_id === player.id;
        if (m.winner_id === player.id) wins++;
        else losses++;
        if (isP1) { gamesWon += m.player1_games; gamesLost += m.player2_games; }
        else { gamesWon += m.player2_games; gamesLost += m.player1_games; }
      }

      return {
        id: player.id,
        name: player.name,
        group_number: g,
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
      const m = data.matches.find(x =>
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

function clearMatches() {
  const data = load();
  data.matches = [];
  data.nextMatchId = 1;
  save(data);
}

module.exports = { getAllPlayers, findPlayer, findPlayerExact, matchExists, addMatch, deleteMatch, clearMatches, getRecentMatches, getStandings };
