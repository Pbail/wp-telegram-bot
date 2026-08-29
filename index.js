require('dotenv').config();
const { Telegraf, Scenes, session } = require('telegraf');
const { connectDB } = require('./config/db');
const logger = require('./config/logger');
const { requireAccess } = require('./bot/middlewares/auth');
const menu = require('./bot/handlers/menu');
const { handleLoginWp, handleCancelLogin } = require('./bot/handlers/loginWp');
const autoReply = require('./bot/handlers/autoReply');
const addTemplateScenes = require('./bot/scenes/addTemplate');
const payment = require('./bot/handlers/payment');
const diagnostics = require('./bot/handlers/diagnostics');
const { restoreAllActiveSessions, setBotInstance, shutdownAllSessions } = require('./whatsapp/sessionManager');

const bot = new Telegraf(process.env.BOT_TOKEN);

const stage = new Scenes.Stage(addTemplateScenes);
bot.use(session());
bot.use(stage.middleware());

// ---- Owner-only payment commands (no access check needed, they check isOwner internally) ----
bot.command('addpay', payment.addPay);
bot.command('removepay', payment.removePay);
bot.command('users', payment.listUsers);
bot.command('status', diagnostics.status);

// ---- Everything below requires paid/owner access ----
bot.use(requireAccess);

bot.start(menu.showMainMenu);
bot.command('menu', menu.showMainMenu);

bot.action('back_main', async (ctx) => {
  await ctx.answerCbQuery();
  await menu.showMainMenu(ctx);
});

// Session menu
bot.action('menu_session', async (ctx) => { await ctx.answerCbQuery(); await menu.showSessionMenu(ctx); });
bot.action('sess_menu', async (ctx) => { await ctx.answerCbQuery(); await menu.showSessionMenu(ctx); });
bot.action('sess_active', async (ctx) => { await ctx.answerCbQuery(); await menu.showActiveSessions(ctx); });
bot.action('sess_dead', async (ctx) => { await ctx.answerCbQuery(); await menu.showDeadSessions(ctx); });
bot.action(/^logout_(.+)$/, async (ctx) => {
  await menu.handleLogout(ctx, ctx.match[1]);
});

// Login WP
bot.action('menu_login_wp', handleLoginWp);
bot.action(/^cancel_login_(.+)$/, async (ctx) => {
  await handleCancelLogin(ctx, ctx.match[1]);
});

// Auto reply / templates
bot.action('menu_auto_reply', async (ctx) => { await ctx.answerCbQuery(); await autoReply.showAutoReplyMenu(ctx); });
bot.action('tpl_toggle_autoreply', autoReply.toggleAutoReply);
bot.action('tpl_shop_all', async (ctx) => { await ctx.answerCbQuery(); await autoReply.showAllTemplates(ctx); });
bot.action(/^tpl_view_(.+)$/, async (ctx) => { await autoReply.viewTemplate(ctx, ctx.match[1]); });
bot.action(/^tpl_preview_(.+)$/, async (ctx) => { await autoReply.previewTemplate(ctx, ctx.match[1]); });
bot.action(/^tpl_setactive_(.+)$/, async (ctx) => { await autoReply.setActiveTemplate(ctx, ctx.match[1]); });
bot.action(/^tpl_del_(.+)$/, async (ctx) => { await autoReply.deleteTemplate(ctx, ctx.match[1]); });
bot.action('tpl_add_new', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.scene.enter('ADD_TEMPLATE_KEYWORD');
});

bot.catch(async (err, ctx) => {
  console.error(`[Bot Error] for update ${ctx.updateType}:`, err);
  await logger.log(`Bot Error\nUpdate: ${ctx.updateType}\nError: ${String(err.message || err).slice(0, 500)}`);
});

async function main() {
  await connectDB();
  setBotInstance(bot);
  logger.init(bot);
  await bot.launch();
  console.log('[Bot] Telegram bot started');
  await logger.log('Bot Started');
  await restoreAllActiveSessions();
}

main().catch((err) => {
  console.error('[Fatal] Failed to start:', err);
  process.exit(1);
});

async function shutdown(signal) {
  console.log(`[Bot] Received ${signal}, shutting down gracefully...`);
  try {
    await shutdownAllSessions(); // let every WhatsApp session flush its data to disk properly
  } catch (err) {
    console.error('[Shutdown] Error while closing WhatsApp sessions:', err.message);
  }
  bot.stop(signal);
  process.exit(0);
}

process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));
