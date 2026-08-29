const { Schema, model } = require('mongoose');

const chatStateSchema = new Schema({
  telegramId: { type: String, required: true, index: true },
  sessionId: { type: String, required: true, index: true },
  chatId: { type: String, required: true }, // WhatsApp chat jid e.g. 9198xxxxxxx@c.us
  greeted: { type: Boolean, default: false },
  greetingMsgId: { type: String, default: '' }, // serialized WA message id, used to quote-reply later
  createdAt: { type: Date, default: Date.now }
});

chatStateSchema.index({ sessionId: 1, chatId: 1 }, { unique: true });

module.exports = model('ChatState', chatStateSchema);
