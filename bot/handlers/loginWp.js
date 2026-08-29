const { Markup } = require('telegraf');
const { startNewSession, cancelPendingSession } = require('../../whatsapp/sessionManager');
const { showMainMenu } = require('./menu');

async function handleLoginWp(ctx) {
  await ctx.answerCbQuery();
  await ctx.editMessageText('⏳ Generating WhatsApp Web QR code, please wait...');

  const telegramId = ctx.from.id;
  let qrMsgId = null;
  let currentSessionId = null;

  const sessionId = await startNewSession(telegramId, {
    onQr: async (sid, dataUrl) => {
      currentSessionId = sid;
      const buffer = Buffer.from(dataUrl.split(',')[1], 'base64');

      const cancelKb = Markup.inlineKeyboard([
        Markup.button.callback('❌ Cancel', `cancel_login_${sid}`)
      ]);

      if (qrMsgId) {
        try {
          await ctx.telegram.editMessageMedia(
            ctx.chat.id, qrMsgId, undefined,
            { type: 'photo', media: { source: buffer }, caption: 'Scan this QR with WhatsApp > Linked Devices' },
            cancelKb
          );
        } catch (_) { /* qr refreshed too fast to edit, ignore */ }
      } else {
        try { await ctx.deleteMessage(); } catch (_) {}
        const sent = await ctx.replyWithPhoto({ source: buffer }, {
          caption: 'Scan this QR with WhatsApp > Linked Devices',
          ...cancelKb
        });
        qrMsgId = sent.message_id;
      }
    },
    onReady: async (sid, number) => {
      if (qrMsgId) {
        try { await ctx.telegram.deleteMessage(ctx.chat.id, qrMsgId); } catch (_) {}
      }
      await ctx.telegram.sendMessage(
        ctx.chat.id,
        `✅ *Your WP login successful*\n\n📞 Number: ${number}`,
        { parse_mode: 'Markdown' }
      );
      await showMainMenuRaw(ctx);
    },
    onAuthFail: async () => {
      await ctx.telegram.sendMessage(ctx.chat.id, '❌ WhatsApp authentication failed. Please try again.');
    },
    onDisconnected: async (sid, reason) => {
      await ctx.telegram.sendMessage(ctx.chat.id, `⚠️ Session disconnected: ${reason}`);
    }
  });

  currentSessionId = sessionId;
}

async function handleCancelLogin(ctx, sessionId) {
  cancelPendingSession(sessionId);
  await ctx.answerCbQuery('Cancelled');
  try { await ctx.deleteMessage(); } catch (_) {}
  await showMainMenuRaw(ctx);
}

async function showMainMenuRaw(ctx) {
  const { mainMenu } = require('./menu');
  await ctx.telegram.sendMessage(ctx.chat.id, '🏠 *Main Menu*', { parse_mode: 'Markdown', ...mainMenu() });
}

module.exports = { handleLoginWp, handleCancelLogin };
