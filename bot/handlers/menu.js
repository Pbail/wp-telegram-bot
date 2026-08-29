const { Markup } = require('telegraf');
const WaSession = require('../../models/WaSession');
const { logoutSession } = require('../../whatsapp/sessionManager');

function mainMenu() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('📱 Session', 'menu_session')],
    [Markup.button.callback('🔐 Login Wp', 'menu_login_wp')],
    [Markup.button.callback('🤖 Start Auto Reply', 'menu_auto_reply')]
  ]);
}

async function showMainMenu(ctx) {
  const text = '🏠 *Main Menu*\n\nChoose an option below:';
  if (ctx.updateType === 'callback_query') {
    await ctx.editMessageText(text, { parse_mode: 'Markdown', ...mainMenu() });
  } else {
    await ctx.reply(text, { parse_mode: 'Markdown', ...mainMenu() });
  }
}

function sessionMenu() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('✅ Active Session', 'sess_active')],
    [Markup.button.callback('💀 Dead Session', 'sess_dead')],
    [Markup.button.callback('⬅️ Back', 'back_main')]
  ]);
}

async function showSessionMenu(ctx) {
  await ctx.editMessageText('📱 *Session Menu*', { parse_mode: 'Markdown', ...sessionMenu() });
}

async function showActiveSessions(ctx) {
  const telegramId = String(ctx.from.id);
  const sessions = await WaSession.find({ telegramId, status: 'active' });

  if (sessions.length === 0) {
    return ctx.editMessageText('No active WhatsApp sessions.', backOnly('sess_menu'));
  }

  const buttons = sessions.map(s => [
    Markup.button.callback(`🔓 Logout ${s.phoneNumber || s.sessionId}`, `logout_${s.sessionId}`)
  ]);
  buttons.push([Markup.button.callback('⬅️ Back', 'sess_menu')]);

  const list = sessions.map((s, i) => `${i + 1}. ${s.phoneNumber || 'unknown'}`).join('\n');
  await ctx.editMessageText(`✅ *Active Sessions*\n\n${list}`, {
    parse_mode: 'Markdown',
    ...Markup.inlineKeyboard(buttons)
  });
}

async function showDeadSessions(ctx) {
  const telegramId = String(ctx.from.id);
  const sessions = await WaSession.find({ telegramId, status: 'dead' });

  if (sessions.length === 0) {
    return ctx.editMessageText('No dead sessions.', backOnly('sess_menu'));
  }

  const list = sessions.map((s, i) => `${i + 1}. ${s.phoneNumber || s.sessionId}`).join('\n');
  await ctx.editMessageText(`💀 *Dead Sessions*\n\n${list}`, {
    parse_mode: 'Markdown',
    ...backOnly('sess_menu')
  });
}

function backOnly(cb) {
  return Markup.inlineKeyboard([[Markup.button.callback('⬅️ Back', cb)]]);
}

async function handleLogout(ctx, sessionId) {
  await logoutSession(sessionId);
  await ctx.answerCbQuery('Logged out');
  await showActiveSessions(ctx);
}

module.exports = {
  mainMenu, showMainMenu,
  sessionMenu, showSessionMenu,
  showActiveSessions, showDeadSessions,
  handleLogout, backOnly
};
