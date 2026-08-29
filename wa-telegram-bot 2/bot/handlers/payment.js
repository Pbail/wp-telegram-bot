const moment = require('moment');
const User = require('../../models/User');
const { isOwner } = require('../middlewares/auth');
const logger = require('../../config/logger');

const PLAN_HOURS = {
  '24h': 24,
  '7d': 24 * 7,
  '30d': 24 * 30
};

// Usage: /addpay <telegram_id> <24h|7d|30d>
async function addPay(ctx) {
  if (!isOwner(ctx)) return; // silently ignore, non-owners can't even see this

  const parts = ctx.message.text.trim().split(/\s+/);
  if (parts.length !== 3) {
    return ctx.reply('Usage: /addpay <telegram_id> <24h|7d|30d>');
  }
  const [, targetId, plan] = parts;
  const hours = PLAN_HOURS[plan];
  if (!hours) {
    return ctx.reply('Invalid plan. Use one of: 24h, 7d, 30d');
  }

  const expiry = moment().add(hours, 'hours').toDate();

  await User.findOneAndUpdate(
    { telegramId: targetId },
    { telegramId: targetId, isPaid: true, planExpiry: expiry, addedBy: String(ctx.from.id) },
    { upsert: true }
  );

  await ctx.reply(`✅ User ${targetId} activated on plan *${plan}*, expires: ${moment(expiry).format('YYYY-MM-DD HH:mm')}`, { parse_mode: 'Markdown' });
  await logger.log(`New Paid User\nID: ${targetId}\nPlan: ${plan}\nExpires: ${moment(expiry).format('YYYY-MM-DD HH:mm')}`);
}

// Usage: /removepay <telegram_id>
async function removePay(ctx) {
  if (!isOwner(ctx)) return;
  const parts = ctx.message.text.trim().split(/\s+/);
  if (parts.length !== 2) return ctx.reply('Usage: /removepay <telegram_id>');
  const [, targetId] = parts;
  await User.findOneAndUpdate({ telegramId: targetId }, { isPaid: false, planExpiry: null });
  await ctx.reply(`🚫 Access removed for user ${targetId}`);
}

// Usage: /users - list all paid users
async function listUsers(ctx) {
  if (!isOwner(ctx)) return;
  const users = await User.find({ isPaid: true }).sort({ planExpiry: -1 });
  if (users.length === 0) return ctx.reply('No paid users yet.');
  const lines = users.map(u => {
    const expired = u.planExpiry < new Date();
    return `${u.telegramId} — expires ${moment(u.planExpiry).format('YYYY-MM-DD HH:mm')} ${expired ? '(expired)' : ''}`;
  });
  await ctx.reply(lines.join('\n'));
}

module.exports = { addPay, removePay, listUsers };
