#!/bin/bash
# Sincroniza tennis.json local → data.json público en GitHub Pages
# Ejecutado por cron de OpenClaw cada 2 minutos

set -e

REPO_DIR="$HOME/.openclaw/workspace/tennis-ranking"
DATA_FILE="$REPO_DIR/tennis.json"
DOCS_DIR="$REPO_DIR/docs/data.json"

if [ ! -f "$DATA_FILE" ]; then
  echo "No hay tennis.json, saliendo"
  exit 0
fi

# Generar data.json con standings y highlights calculados
cd "$REPO_DIR"
node --input-type=module <<'EOF'
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { getStandings, getRecentMatches, getAllPlayers } = require('./db');
const { computeHighlights } = require('./highlights');
const fs = require('fs');

const standings = getStandings();
const matches = getRecentMatches(500);

// Leer cache de highlights anterior (evita llamar a IA si standings no cambiaron)
let cached = null;
try {
  const prev = JSON.parse(fs.readFileSync('docs/data.json', 'utf8'));
  cached = prev.highlightsCache || null;
} catch (_) {}

const highlightsResult = await computeHighlights(standings, matches, cached);

const data = {
  players: getAllPlayers(),
  matches,
  standings,
  highlights: highlightsResult.highlights,
  highlightsCache: { hash: highlightsResult.hash, highlights: highlightsResult.highlights },
  updatedAt: new Date().toISOString(),
};
fs.writeFileSync('docs/data.json', JSON.stringify(data, null, 2));
console.log('data.json actualizado:', matches.length, 'partidos');
EOF

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
