const TelegramBot = require('node-telegram-bot-api');
const { exec } = require('child_process');
const path = require('path');
const { parseMatchResult } = require('./parser');
const { findPlayer, findPlayerExact, addMatch, deleteMatch, clearMatches, matchExists, getStandings, getRecentMatches, getAllPlayers } = require('./db');

// Pending overwrite requests: chatId -> { matchId, newMatchData, p1, p2, parsed }
const pendingOverwrites = new Map();
// Pending delete requests: chatId -> { matchId, p1, p2 }
const pendingDeletes = new Map();
// Pending reinicio confirmations: Set of chatIds
const pendingReinicio = new Set();

function triggerSync() {
  const script = path.join(__dirname, 'sync-to-github.sh');
  exec(`bash "${script}"`, (err, stdout, stderr) => {
    if (err) console.error('Sync error:', stderr || err.message);
    else console.log('Sync:', stdout.trim());
  });
}

const token = process.env.TELEGRAM_BOT_TOKEN;

if (!token) {
  console.log('⚠️  TELEGRAM_BOT_TOKEN no configurado — bot de Telegram no iniciado');
  module.exports = null;
  return;
}

const bot = new TelegramBot(token, { polling: true });

console.log('🤖 Bot de Telegram iniciado');

function formatStandings(standings) {
  const groupNames = { 1: 'GRUPO 1', 2: 'GRUPO 2', 3: 'GRUPO 3', 4: 'GRUPO 4' };

  let text = '';
  for (const [g, players] of Object.entries(standings)) {
    text += `\n*${groupNames[g]}*\n`;
    players.forEach((p, i) => {
      const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : i === players.length - 1 ? '🔻' : '·';
      text += `${medal} ${p.name} — ${p.points}pts (${p.wins}V/${p.losses}D, ${p.gamesWon}JG)\n`;
    });
  }
  return text.trim();
}

function formatRecentMatches(matches) {
  if (matches.length === 0) return 'Aún no hay partidos registrados.';
  return matches.slice(0, 5).map(m => {
    const score = `${m.player1_games}-${m.player2_games}`;
    const tb = m.is_tiebreak ? ' (TB)' : '';
    const date = new Date(m.played_at).toLocaleDateString('es-ES', { day: '2-digit', month: '2-digit' });
    return `🎾 *${m.winner_name}* ganó | ${m.player1_name} ${score} ${m.player2_name}${tb} [${date}]`;
  }).join('\n');
}

function formatExistingMatch(match) {
  const players = getAllPlayers();
  const p1 = players.find(p => p.id === match.player1_id);
  const p2 = players.find(p => p.id === match.player2_id);
  const winner = match.winner_id === match.player1_id ? p1 : p2;
  const loser = winner.id === match.player1_id ? p2 : p1;
  const score = `${match.player1_games}-${match.player2_games}`;
  const tb = match.is_tiebreak ? ' (TB)' : '';
  const date = new Date(match.played_at).toLocaleDateString('es-ES', { day: '2-digit', month: '2-digit' });
  return `🏆 *${winner.name}* ganó a *${loser.name}* · ${score}${tb} · [${date}]`;
}

function looksLikeDeleteRequest(text) {
  return /\b(borra|borrar|borre|elimina|eliminar|elimine|quita|quitar|quite|cancela|cancelar)\b/i.test(text);
}

async function handleDeleteRequest(chatId, text) {
  const norm = s => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  const t = norm(text);
  const players = getAllPlayers();

  const found = players
    .map(p => ({ ...p, pos: t.indexOf(norm(p.name)) }))
    .filter(p => p.pos !== -1)
    .sort((a, b) => a.pos - b.pos);

  if (found.length < 2) {
    return bot.sendMessage(chatId,
      '❓ No encontré dos jugadores en ese mensaje.\n\nPrueba: "borra el resultado de Raúl y Pablo"'
    );
  }

  const p1 = found[0];
  const p2 = found[1];
  const match = matchExists(p1.id, p2.id);

  if (!match) {
    return bot.sendMessage(chatId,
      `❌ No hay ningún resultado registrado entre *${p1.name}* y *${p2.name}*.`,
      { parse_mode: 'Markdown' }
    );
  }

  pendingDeletes.set(chatId, { matchId: match.id, p1, p2 });
  bot.sendMessage(chatId,
    `🗑️ ¿Borrar este resultado?\n\n${formatExistingMatch(match)}\n\nResponde /si para confirmar o /no para cancelar.`,
    { parse_mode: 'Markdown' }
  );
}

async function handleResult(chatId, text, senderName) {
  // Clear any pending overwrite/delete when a new result comes in
  pendingOverwrites.delete(chatId);
  pendingDeletes.delete(chatId);

  const thinking = await bot.sendMessage(chatId, '⏳ Interpretando resultado...');
  const parsed = await parseMatchResult(text);
  bot.deleteMessage(chatId, thinking.message_id).catch(() => {});

  if (!parsed) {
    return bot.sendMessage(chatId,
      '❓ No pude interpretar ese resultado.\n\nPrueba con:\n• "Pablo ganó a Javi 6-4"\n• "Resultado Chus 7-6 Jacobo"\n• "Mario 6 - Jorge 3"'
    );
  }

  const p1 = findPlayerExact(parsed.player1) || findPlayer(parsed.player1);
  const p2 = findPlayerExact(parsed.player2) || findPlayer(parsed.player2);

  if (!p1 || !p2) {
    const missing = [!p1 && parsed.player1, !p2 && parsed.player2].filter(Boolean).join(' y ');
    return bot.sendMessage(chatId,
      `❌ Jugador no reconocido: *${missing}*\n\nNombres válidos: Pepe, Javi, Raul, Pablo, Sergio, Mario, Jorge, Alex, Chus, Jacobo, JJ, Dani, Carlos DM, Carlitos, Guille, Juan, Rober`,
      { parse_mode: 'Markdown' }
    );
  }

  if (p1.group_number !== p2.group_number) {
    return bot.sendMessage(chatId,
      `❌ *${p1.name}* y *${p2.name}* están en grupos distintos (Grupo ${p1.group_number} vs Grupo ${p2.group_number}).\n\nSolo se pueden enfrentar jugadores del mismo grupo.`,
      { parse_mode: 'Markdown' }
    );
  }

  const existing = matchExists(p1.id, p2.id);
  if (existing) {
    pendingOverwrites.set(chatId, {
      matchId: existing.id,
      p1, p2, parsed,
      senderName,
      raw_input: text,
    });
    return bot.sendMessage(chatId,
      `⚠️ Ya existe un resultado entre *${p1.name}* y *${p2.name}*:\n\n${formatExistingMatch(existing)}\n\n¿Quieres sobrescribirlo con el nuevo resultado?\nResponde /si para confirmar o /no para cancelar.`,
      { parse_mode: 'Markdown' }
    );
  }

  saveMatch({ chatId, p1, p2, parsed, senderName, raw_input: text });
}

function saveMatch({ chatId, p1, p2, parsed, senderName, raw_input }) {
  addMatch({
    player1_id: p1.id,
    player2_id: p2.id,
    player1_games: parsed.player1_games,
    player2_games: parsed.player2_games,
    is_tiebreak: parsed.is_tiebreak,
    tiebreak_score: parsed.tiebreak_score,
    raw_input,
    added_by: senderName,
  });
  triggerSync();

  const winner = parsed.player1_games > parsed.player2_games ? p1 : p2;
  const loser = winner.id === p1.id ? p2 : p1;
  const score = `${parsed.player1_games}-${parsed.player2_games}`;
  const tbText = parsed.is_tiebreak ? ' _(tie-break)_' : '';

  bot.sendMessage(chatId,
    `✅ *Resultado registrado*\n\n🏆 *${winner.name}* ganó a *${loser.name}*\n📊 ${score}${tbText}\n👥 Grupo ${p1.group_number}`,
    { parse_mode: 'Markdown' }
  );
}

bot.onText(/\/reinicio/, (msg) => {
  const count = getRecentMatches(1000).length;
  pendingReinicio.add(msg.chat.id);
  bot.sendMessage(msg.chat.id,
    `⚠️ *REINICIO DEL TORNEO*\n\nEsto borrará los *${count} partidos* registrados y dejará la clasificación a cero.\n\nResponde /confirmar para continuar o /no para cancelar.`,
    { parse_mode: 'Markdown' }
  );
});

bot.onText(/\/confirmar/, (msg) => {
  if (!pendingReinicio.has(msg.chat.id)) return;
  pendingReinicio.delete(msg.chat.id);
  clearMatches();
  triggerSync();
  bot.sendMessage(msg.chat.id, '✅ Torneo reiniciado. Todos los partidos han sido borrados.');
});

bot.onText(/\/si/, (msg) => {
  const pendingDel = pendingDeletes.get(msg.chat.id);
  if (pendingDel) {
    pendingDeletes.delete(msg.chat.id);
    deleteMatch(pendingDel.matchId);
    triggerSync();
    return bot.sendMessage(msg.chat.id,
      `✅ Resultado borrado: *${pendingDel.p1.name}* vs *${pendingDel.p2.name}*.`,
      { parse_mode: 'Markdown' }
    );
  }
  const pending = pendingOverwrites.get(msg.chat.id);
  if (!pending) return;
  pendingOverwrites.delete(msg.chat.id);
  deleteMatch(pending.matchId);
  saveMatch({ chatId: msg.chat.id, ...pending });
});

bot.onText(/\/no/, (msg) => {
  if (pendingReinicio.has(msg.chat.id)) {
    pendingReinicio.delete(msg.chat.id);
    return bot.sendMessage(msg.chat.id, '↩️ Reinicio cancelado. Los datos se mantienen intactos.');
  }
  if (pendingDeletes.has(msg.chat.id)) {
    pendingDeletes.delete(msg.chat.id);
    return bot.sendMessage(msg.chat.id, '↩️ Cancelado. El resultado se mantiene.');
  }
  if (pendingOverwrites.has(msg.chat.id)) {
    pendingOverwrites.delete(msg.chat.id);
    return bot.sendMessage(msg.chat.id, '↩️ Operación cancelada. El resultado anterior se mantiene.');
  }
});

bot.onText(/\/clasificacion/, (msg) => {
  const standings = getStandings();
  bot.sendMessage(msg.chat.id, formatStandings(standings), { parse_mode: 'Markdown' });
});

bot.onText(/\/partidos/, (msg) => {
  const matches = getRecentMatches(10);
  bot.sendMessage(msg.chat.id, formatRecentMatches(matches), { parse_mode: 'Markdown' });
});

bot.onText(/\/ayuda/, (msg) => {
  bot.sendMessage(msg.chat.id,
    `*🎾 Tennis Ranking Bot*\n\n` +
    `Para registrar un resultado, escribe de forma natural:\n` +
    `• "Pablo ganó a Javi 6-4"\n` +
    `• "Resultado Chus 7-6(5) Jacobo"\n` +
    `• "Mario 6 - Jorge 3"\n\n` +
    `*Comandos:*\n` +
    `/clasificacion — Ver clasificación actual\n` +
    `/partidos — Últimos partidos\n` +
    `/ayuda — Este mensaje\n\n` +
    `*Para borrar un resultado:*\n` +
    `• "borra el resultado de Raúl y Pablo"\n` +
    `• "elimina el partido de Chus y JJ"`,
    { parse_mode: 'Markdown' }
  );
});

bot.on('message', async (msg) => {
  if (!msg.text) return;
  if (msg.text.startsWith('/')) return;

  if (looksLikeDeleteRequest(msg.text)) {
    await handleDeleteRequest(msg.chat.id, msg.text);
    return;
  }

  // In group chats, only react if the message looks like a tennis result
  const looksLikeResult = /(\d)\s*[-–]\s*(\d)|ganó|gano|perdió|perdio|resultado/i.test(msg.text);
  if (msg.chat.type !== 'private' && !looksLikeResult) return;

  const senderName = msg.from.first_name || msg.from.username || 'Desconocido';
  await handleResult(msg.chat.id, msg.text, senderName);
});

bot.on('polling_error', (err) => {
  console.error('Telegram polling error:', err.message);
});

module.exports = bot;
