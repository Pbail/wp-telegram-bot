const User = require('../../models/User');
const logger = require('../../config/logger');

function isOwner(ctx) {
  return String(ctx.from.id) === String(process.env.OWNER_ID);
}

/** Blocks everyone except the owner and users with a non-expired paid plan. */
async function requireAccess(ctx, next) {
  if (isOwner(ctx)) return next();

  const telegramId = String(ctx.from.id);
  let user = await User.findOne({ telegramId });

  if (!user) {
    // first time this Telegram account has ever touched the bot -> log it
    user = await User.create({ telegramId, username: ctx.from.username || '' });
    await logger.log(`New Bot Visitor\nID: ${telegramId}\nUsername: @${ctx.from.username || 'n/a'}`);
  }

  const active = user.isPaid && user.planExpiry && user.planExpiry > new Date();
  if (active) return next();

  const blockMsg = process.env.BLOCK_MESSAGE || 'Get lost! By @MR_Pbail';
  return ctx.reply(blockMsg);
}

module.exports = { requireAccess, isOwner };
