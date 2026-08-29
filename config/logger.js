let botInstance = null;

function init(bot) {
  botInstance = bot;
}

/** Sends a message to the configured LOG_GROUP_ID. Silently no-ops if not configured. */
async function log(text) {
  const groupId = process.env.LOG_GROUP_ID;
  if (!botInstance || !groupId) return;
  try {
    await botInstance.telegram.sendMessage(groupId, text); // plain text on purpose — dynamic content (IDs, error messages) can contain characters that break Markdown parsing
  } catch (err) {
    console.error('[Logger] Failed to send log message:', err.message);
  }
}

module.exports = { init, log };
