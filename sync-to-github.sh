#!/bin/bash
# Sincroniza tennis.json local → data.json público en GitHub Pages
# Se ejecuta al registrar/borrar resultados (bot y web); también puede lanzarse a mano.

set -e

REPO_DIR="$HOME/.openclaw/workspace/tennis-ranking"
DATA_FILE="$REPO_DIR/tennis.json"

if [ ! -f "$DATA_FILE" ]; then
  echo "No hay tennis.json, saliendo"
  exit 0
fi

# Generar data.json multi-ronda con standings y highlights calculados
cd "$REPO_DIR"
node --input-type=module <<'NODE_EOF'
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { buildExportData } = require('./export');
const fs = require('fs');

// Cache de highlights previa (evita recomputar si la clasificación no cambió)
let cached = null;
try {
  const prev = JSON.parse(fs.readFileSync('docs/data.json', 'utf8'));
  cached = prev.highlightsCache || null;
} catch (_) {}

const data = await buildExportData(cached);
fs.writeFileSync('docs/data.json', JSON.stringify(data, null, 2));
console.log('data.json actualizado: ronda', data.currentRound, 'de', data.rounds.length, 'ronda(s)');
NODE_EOF

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
