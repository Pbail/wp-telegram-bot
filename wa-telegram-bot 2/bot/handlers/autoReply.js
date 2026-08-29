const { Markup } = require('telegraf');
const Template = require('../../models/Template');
const User = require('../../models/User');
const logger = require('../../config/logger');

function autoReplyMenu(enabled) {
  return Markup.inlineKeyboard([
    [Markup.button.callback(enabled ? '⏹ Stop Auto Reply' : '▶️ Start Auto Reply', 'tpl_toggle_autoreply')],
    [Markup.button.callback('➕ Add New Template', 'tpl_add_new')],
    [Markup.button.callback('👁 Show All Template', 'tpl_shop_all')],
    [Markup.button.callback('⬅️ Back', 'back_main')]
  ]);
}

async function showAutoReplyMenu(ctx) {
  const telegramId = String(ctx.from.id);
  const user = await User.findOne({ telegramId });
  const enabled = !!(user && user.autoReplyEnabled);

  await ctx.editMessageText(
    `🤖 *Start Auto Reply*\n\nStatus: ${enabled ? '🟢 Running' : '🔴 Stopped'}`,
    { parse_mode: 'Markdown', ...autoReplyMenu(enabled) }
  );
}

/** Turns the WhatsApp auto-reply engine on/off for this Telegram user's sessions. */
async function toggleAutoReply(ctx) {
  const telegramId = String(ctx.from.id);
  let user = await User.findOne({ telegramId });
  if (!user) user = await User.create({ telegramId });

  const turningOn = !user.autoReplyEnabled;

  if (turningOn) {
    const activeTemplate = await Template.findOne({ telegramId, active: true });
    if (!activeTemplate) {
      await ctx.answerCbQuery('⚠️ Set an Active template first (Show All Template).', { show_alert: true });
      return showAutoReplyMenu(ctx);
    }
  }

  user.autoReplyEnabled = turningOn;
  await user.save();

  await ctx.answerCbQuery(turningOn ? 'Auto Reply started ✅' : 'Auto Reply stopped ⏹');
  await logger.log(`${turningOn ? 'Auto Reply Started' : 'Auto Reply Stopped'}\nUser: ${telegramId}`);
  await showAutoReplyMenu(ctx);
}

async function showAllTemplates(ctx) {
  const telegramId = String(ctx.from.id);
  const templates = await Template.find({ telegramId });

  if (templates.length === 0) {
    return ctx.editMessageText('No templates yet. Add one first.', Markup.inlineKeyboard([
      [Markup.button.callback('⬅️ Back', 'menu_auto_reply')]
    ]));
  }

  const buttons = [];
  for (const t of templates) {
    const label = `${t.active ? '⭐' : '▫️'} ${t.name || '(unnamed)'} (${t.images.length} img, ${t.files.length} file)`;
    buttons.push([Markup.button.callback(label, `tpl_view_${t._id}`)]);
  }
  buttons.push([Markup.button.callback('⬅️ Back', 'menu_auto_reply')]);

  await ctx.editMessageText('👁 *Show All Template*\n⭐ = currently active greeting\n\nTap one to manage it.', {
    parse_mode: 'Markdown',
    ...Markup.inlineKeyboard(buttons)
  });
}

async function viewTemplate(ctx, id) {
  const t = await Template.findById(id);
  if (!t) return ctx.answerCbQuery('Not found');
  await ctx.answerCbQuery();

  const buttons = [];
  if (!t.active) buttons.push([Markup.button.callback('⭐ Set as Active', `tpl_setactive_${t._id}`)]);
  buttons.push([Markup.button.callback('👁 Preview', `tpl_preview_${t._id}`)]);
  buttons.push([Markup.button.callback('🗑 Delete', `tpl_del_${t._id}`)]);
  buttons.push([Markup.button.callback('⬅️ Back', 'tpl_shop_all')]);

  await ctx.editMessageText(
    `🏷 *${t.name || '(unnamed)'}*\n${t.active ? '⭐ Currently ACTIVE' : '▫️ Not active'}\n\n🖼 Images: ${t.images.length}\n💬 Message: ${t.message ? 'yes' : 'none'}\n📎 Files: ${t.files.length}`,
    { parse_mode: 'Markdown', ...Markup.inlineKeyboard(buttons) }
  );
}

/** Sends the template's actual content (images, message, files) back into the Telegram
 *  chat so the owner/user can see exactly what a WhatsApp contact would receive. */
async function previewTemplate(ctx, id) {
  const t = await Template.findById(id);
  if (!t) return ctx.answerCbQuery('Not found');
  await ctx.answerCbQuery('Sending preview...');

  if (t.images.length > 0) {
    for (let i = 0; i < t.images.length; i++) {
      const caption = i === 0 ? (t.message || undefined) : undefined;
      await ctx.replyWithPhoto(t.images[i].telegramFileId, caption ? { caption } : {});
    }
  } else if (t.message) {
    await ctx.reply(t.message);
  }

  for (const f of t.files) {
    const opts = f.fileName ? { caption: f.fileName } : {};
    if (f.type === 'voice') await ctx.replyWithVoice(f.telegramFileId, opts);
    else if (f.type === 'audio') await ctx.replyWithAudio(f.telegramFileId, opts);
    else if (f.type === 'video') await ctx.replyWithVideo(f.telegramFileId, opts);
    else await ctx.replyWithDocument(f.telegramFileId, opts);
  }

  await ctx.reply('☝️ This is exactly what a new WhatsApp contact will receive.');
}

async function setActiveTemplate(ctx, id) {
  const telegramId = String(ctx.from.id);
  await Template.updateMany({ telegramId }, { active: false });
  await Template.updateOne({ _id: id, telegramId }, { active: true });
  await ctx.answerCbQuery('Set as active greeting ✅');
  await showAllTemplates(ctx);
}

async function deleteTemplate(ctx, id) {
  await Template.deleteOne({ _id: id, telegramId: String(ctx.from.id) });
  await ctx.answerCbQuery('Deleted');
  await showAllTemplates(ctx);
}

module.exports = {
  autoReplyMenu, showAutoReplyMenu, toggleAutoReply, showAllTemplates,
  viewTemplate, previewTemplate, setActiveTemplate, deleteTemplate
};
