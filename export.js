// Construye el paquete de datos que consumen ambos frontends
// (docs/data.json para GitHub Pages y /api/data en Express).
const { getStandings, getRecentMatches, getAllPlayers, listRounds } = require('./db');
const { computeHighlights } = require('./highlights');

async function buildExportData(cachedHighlights) {
  const info = listRounds();
  const rounds = info.rounds.map(r => ({
    number: r.number,
    standings: getStandings(r.number),
    matches: getRecentMatches(500, r.number),
  }));

  // Hipótesis solo para la ronda actual (las históricas están cerradas)
  const cur = rounds.find(r => r.number === info.currentRound) || rounds[rounds.length - 1];
  const hl = await computeHighlights(cur.standings, cur.matches, cachedHighlights);

  return {
    currentRound: info.currentRound,
    latestRound: info.latestRound,
    rounds,
    highlights: hl.highlights,
    highlightsCache: { hash: hl.hash, version: hl.version, highlights: hl.highlights },
    updatedAt: new Date().toISOString(),
    // Compatibilidad con frontends antiguos durante el despliegue:
    players: getAllPlayers(),
    matches: cur.matches,
    standings: cur.standings,
  };
}

module.exports = { buildExportData };
