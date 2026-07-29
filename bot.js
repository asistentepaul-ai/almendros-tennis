const TelegramBot = require('node-telegram-bot-api');
const { parseMatchResult } = require('./parser');
const { findPlayer, findPlayerExact, addMatch, matchExists, getStandings, getRecentMatches } = require('./db');

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
  const medals = ['🥇', '🥈', '🥉', '🔻'];

  let text = '';
  for (const [g, players] of Object.entries(standings)) {
    text += `\n*${groupNames[g]}*\n`;
    players.forEach((p, i) => {
      const medal = medals[Math.min(i, players.length - 1 === i && i > 0 ? 3 : i)] || '·';
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

async function handleResult(chatId, text, senderName) {
  const thinking = await bot.sendMessage(chatId, '⏳ Interpretando resultado...');

  const parsed = await parseMatchResult(text);

  if (!parsed) {
    bot.deleteMessage(chatId, thinking.message_id).catch(() => {});
    return bot.sendMessage(chatId,
      '❓ No pude interpretar ese resultado. Prueba con:\n• "Pablo ganó a Javi 6-4"\n• "Resultado Chus 7-6 Jacobo"\n• "Mario 6 - Jorge 3"'
    );
  }

  const p1 = findPlayerExact(parsed.player1) || findPlayer(parsed.player1);
  const p2 = findPlayerExact(parsed.player2) || findPlayer(parsed.player2);

  bot.deleteMessage(chatId, thinking.message_id).catch(() => {});

  if (!p1 || !p2) {
    const missing = [!p1 && parsed.player1, !p2 && parsed.player2].filter(Boolean).join(' y ');
    return bot.sendMessage(chatId, `❌ No reconozco al jugador: *${missing}*\nUsa los nombres exactos de la lista.`, { parse_mode: 'Markdown' });
  }

  if (p1.group_number !== p2.group_number) {
    return bot.sendMessage(chatId,
      `❌ *${p1.name}* (Grupo ${p1.group_number}) y *${p2.name}* (Grupo ${p2.group_number}) están en grupos distintos.`,
      { parse_mode: 'Markdown' }
    );
  }

  if (matchExists(p1.id, p2.id)) {
    return bot.sendMessage(chatId,
      `⚠️ Ya hay un resultado entre *${p1.name}* y *${p2.name}*. Contacta al coordinador si hay un error.`,
      { parse_mode: 'Markdown' }
    );
  }

  addMatch({
    player1_id: p1.id,
    player2_id: p2.id,
    player1_games: parsed.player1_games,
    player2_games: parsed.player2_games,
    is_tiebreak: parsed.is_tiebreak,
    tiebreak_score: parsed.tiebreak_score,
    raw_input: text,
    added_by: senderName,
  });

  const winner = parsed.player1_games > parsed.player2_games ? p1 : p2;
  const loser = winner.id === p1.id ? p2 : p1;
  const score = `${parsed.player1_games}-${parsed.player2_games}`;
  const tbText = parsed.is_tiebreak ? ` _(tie-break)_` : '';

  bot.sendMessage(chatId,
    `✅ *Resultado registrado*\n\n🏆 *${winner.name}* ganó a *${loser.name}*\n📊 ${score}${tbText}\n👥 Grupo ${p1.group_number}`,
    { parse_mode: 'Markdown' }
  );
}

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
    `/ayuda — Este mensaje`,
    { parse_mode: 'Markdown' }
  );
});

bot.on('message', async (msg) => {
  if (!msg.text) return;
  if (msg.text.startsWith('/')) return;

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
