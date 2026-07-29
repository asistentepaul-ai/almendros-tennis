#!/bin/bash
# Sincroniza tennis.json local → data.json público en GitHub Pages
# + backup a Google Sheet
# Ejecutado por cron de OpenClaw cada 2 minutos

set -e

REPO_DIR="$HOME/.openclaw/workspace/tennis-ranking"
DATA_FILE="$REPO_DIR/tennis.json"
DOCS_DIR="$REPO_DIR/docs/data.json"

if [ ! -f "$DATA_FILE" ]; then
  echo "No hay tennis.json, saliendo"
  exit 0
fi

# Generar data.json con standings calculados
cd "$REPO_DIR"
node -e "
const { getStandings, getRecentMatches, getAllPlayers } = require('./db');
const data = {
  players: getAllPlayers(),
  matches: getRecentMatches(100),
  standings: getStandings(),
  updatedAt: new Date().toISOString()
};
require('fs').writeFileSync('docs/data.json', JSON.stringify(data, null, 2));
console.log('data.json actualizado:', data.matches.length, 'partidos');
"

# Commit y push si hay cambios
cd "$REPO_DIR"
git add docs/data.json
if git diff --cached --quiet; then
  echo "Sin cambios en data.json"
else
  git commit -m "auto: sync data.json [$(date -u +%Y-%m-%dT%H:%M:%SZ)]"
  git push origin main
  echo "data.json actualizado y pushed a GitHub"
fi
