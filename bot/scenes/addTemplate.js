const { Scenes, Markup } = require('telegraf');
const Template = require('../../models/Template');
const logger = require('../../config/logger');

const skipNameKb = Markup.inlineKeyboard([
  [Markup.button.callback('⏭ Skip', 'tpl_skip_name')]
]);

const yesNoImages = Markup.inlineKeyboard([
  [Markup.button.callback('➕ Add More Image', 'tpl_more_img')],
  [Markup.button.callback('➡️ Next (Message)', 'tpl_img_done')]
]);

const skipMessageKb = Markup.inlineKeyboard([
  [Markup.button.callback('⏭ Skip', 'tpl_skip_msg')]
]);

const fileStepKb = Markup.inlineKeyboard([
  [Markup.button.callback('⏭ Skip', 'tpl_skip_file')]
]);

const keepNameKb = Markup.inlineKeyboard([
  [Markup.button.callback('⏭ Keep Original Name', 'tpl_keep_filename')]
]);

const moreFileKb = Markup.inlineKeyboard([
  [Markup.button.callback('➕ Add More File', 'tpl_more_file')],
  [Markup.button.callback('✅ Finish Template', 'tpl_finish')]
]);

// ---- Step 1: name (optional, just for identifying it later in the list) ----
const step1 = new Scenes.BaseScene('ADD_TEMPLATE_KEYWORD');
step1.enter(async (ctx) => {
  ctx.scene.state.images = [];
  ctx.scene.state.files = [];
  await ctx.reply('🏷 Send a *name* for this template (just for your own reference), or skip.', {
    parse_mode: 'Markdown', ...skipNameKb
  });
});
step1.on('text', async (ctx) => {
  ctx.scene.state.name = ctx.message.text.trim();
  await goToImages(ctx);
});
step1.action('tpl_skip_name', async (ctx) => {
  await ctx.answerCbQuery();
  ctx.scene.state.name = '';
  await goToImages(ctx);
});
async function goToImages(ctx) {
  await ctx.scene.enter('ADD_TEMPLATE_IMAGES', ctx.scene.state);
}

// ---- Step 2: images (loop) ----
const step2 = new Scenes.BaseScene('ADD_TEMPLATE_IMAGES');
step2.enter(async (ctx) => {
  await ctx.reply('🖼 Send an image for this template.');
});
step2.on('photo', async (ctx) => {
  const photos = ctx.message.photo;
  const best = photos[photos.length - 1];
  ctx.scene.state.images.push({ telegramFileId: best.file_id, type: 'image' });
  await ctx.reply(`✅ Image added (${ctx.scene.state.images.length} total).`, yesNoImages);
});
step2.action('tpl_more_img', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.reply('🖼 Send the next image.');
});
step2.action('tpl_img_done', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.scene.enter('ADD_TEMPLATE_MESSAGE', ctx.scene.state);
});

// ---- Step 3: message / caption ----
const step3 = new Scenes.BaseScene('ADD_TEMPLATE_MESSAGE');
step3.enter(async (ctx) => {
  await ctx.reply('💬 Send the greeting message/script (or skip).', skipMessageKb);
});
step3.on('text', async (ctx) => {
  ctx.scene.state.message = ctx.message.text;
  await ctx.scene.enter('ADD_TEMPLATE_FILES', ctx.scene.state);
});
step3.action('tpl_skip_msg', async (ctx) => {
  await ctx.answerCbQuery();
  ctx.scene.state.message = '';
  await ctx.scene.enter('ADD_TEMPLATE_FILES', ctx.scene.state);
});

// ---- Step 4: files/voice (loop) + rename ----
const step4 = new Scenes.BaseScene('ADD_TEMPLATE_FILES');
step4.enter(async (ctx) => {
  ctx.scene.state.awaitingRename = false;
  await ctx.reply('📎 Send a file / voice note for this template (or skip).', fileStepKb);
});

async function askRename(ctx) {
  ctx.scene.state.awaitingRename = true;
  await ctx.reply('✏️ Send a new name for this file (or keep the original):', keepNameKb);
}

async function confirmFileAdded(ctx) {
  ctx.scene.state.awaitingRename = false;
  await ctx.reply(`✅ File added (${ctx.scene.state.files.length} total).`, moreFileKb);
}

step4.on('document', async (ctx) => {
  ctx.scene.state.files.push({ telegramFileId: ctx.message.document.file_id, type: 'document', fileName: ctx.message.document.file_name || '' });
  await askRename(ctx);
});
step4.on('voice', async (ctx) => {
  ctx.scene.state.files.push({ telegramFileId: ctx.message.voice.file_id, type: 'voice', fileName: '' });
  await askRename(ctx);
});
step4.on('audio', async (ctx) => {
  ctx.scene.state.files.push({ telegramFileId: ctx.message.audio.file_id, type: 'audio', fileName: ctx.message.audio.file_name || '' });
  await askRename(ctx);
});
step4.on('video', async (ctx) => {
  ctx.scene.state.files.push({ telegramFileId: ctx.message.video.file_id, type: 'video', fileName: '' });
  await askRename(ctx);
});

// Rename text reply — only applies right after a file was added
step4.on('text', async (ctx) => {
  if (!ctx.scene.state.awaitingRename || ctx.scene.state.files.length === 0) return;
  ctx.scene.state.files[ctx.scene.state.files.length - 1].fileName = ctx.message.text.trim();
  await confirmFileAdded(ctx);
});
step4.action('tpl_keep_filename', async (ctx) => {
  await ctx.answerCbQuery();
  if (ctx.scene.state.files.length === 0) return;
  await confirmFileAdded(ctx);
});

step4.action('tpl_skip_file', async (ctx) => {
  await ctx.answerCbQuery();
  await finishTemplate(ctx);
});
step4.action('tpl_more_file', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.reply('📎 Send the next file / voice note.');
});
step4.action('tpl_finish', async (ctx) => {
  await ctx.answerCbQuery();
  await finishTemplate(ctx);
});

async function finishTemplate(ctx) {
  const { name, images, message, files } = ctx.scene.state;
  const doc = await Template.create({
    telegramId: String(ctx.from.id),
    name: name || '',
    message: message || '',
    images,
    files
  });

  await ctx.reply(
    `✅ Template saved!\n\n🏷 Name: ${name || '(unnamed)'}\n🖼 Images: ${images.length}\n📎 Files: ${files.length}`,
    Markup.inlineKeyboard([
      [Markup.button.callback('⭐ Set as Active Greeting', `tpl_setactive_${doc._id}`)],
      [Markup.button.callback('🏠 Main Menu', 'back_main')]
    ])
  );

  await logger.log(
    `New Template Created\nUser: ${ctx.from.id}\nName: ${name || '(unnamed)'}\nImages: ${images.length}\nFiles: ${files.length}\nMessage: ${message ? 'yes' : 'none'}`
  );

  await ctx.scene.leave();
}

module.exports = [step1, step2, step3, step4];
