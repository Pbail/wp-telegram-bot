const { Schema, model } = require('mongoose');

const userSchema = new Schema({
  telegramId: { type: String, required: true, unique: true, index: true },
  username: { type: String, default: '' },
  isPaid: { type: Boolean, default: false },
  planExpiry: { type: Date, default: null }, // null = no active plan
  autoReplyEnabled: { type: Boolean, default: false }, // global on/off switch for WA auto-reply
  addedBy: { type: String, default: '' },    // owner id who granted access
  createdAt: { type: Date, default: Date.now }
});

module.exports = model('User', userSchema);
