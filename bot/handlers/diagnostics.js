const WaSession = require('../../models/WaSession');
const Template = require('../../models/Template');
const User = require('../../models/User');
const { isOwner } = require('../middlewares/auth');
const { getLiveSessionIds } = require('../../whatsapp/sessionManager');

async function status(ctx) {
  if (!isOwner(ctx)) return;

  const telegramId = String(ctx.from.id);
  const sessions = await WaSession.find({ telegramId });
  const liveIds = getLiveSessionIds();
  const user = await User.findOne({ telegramId });
  const activeTemplate = await Template.findOne({ telegramId, active: true });

  // Plain text on purpose — phone numbers/session ids contain underscores which break Telegram's Markdown parser.
  let text = `🔍 Status Report\n\n`;
  text += `Auto Reply: ${user && user.autoReplyEnabled ? '🟢 ON' : '🔴 OFF'}\n`;
  text += `Active Template: ${activeTemplate ? (activeTemplate.name || '(unnamed)') : '❌ none set — this blocks all greetings'}\n\n`;
  text += `WhatsApp Sessions:\n`;

  if (sessions.length === 0) {
    text += 'None — you have not logged in any WhatsApp number yet.\n';
  } else {
    for (const s of sessions) {
      const isLive = liveIds.includes(s.sessionId);
      text += `\n📱 ${s.phoneNumber || 'unknown'}\n`;
      text += `DB status: ${s.status}\n`;
      text += `In memory: ${isLive ? '🟢 yes (client object exists)' : '🔴 NO — this is likely the bug: the WhatsApp client is not actually running even though DB says "' + s.status + '"'}\n`;
    }
  }

  if (sessions.some(s => s.status === 'active' && !liveIds.includes(s.sessionId))) {
    text += `\n⚠️ Fix: Go to Session > Active Session and Logout that number, then Login Wp again with a fresh QR scan.`;
  }

  await ctx.reply(text);
}

module.exports = { status };
