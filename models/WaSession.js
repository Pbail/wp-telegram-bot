const { Schema, model } = require('mongoose');

const waSessionSchema = new Schema({
  telegramId: { type: String, required: true, index: true },
  sessionId: { type: String, required: true, unique: true }, // used as whatsapp-web.js clientId
  phoneNumber: { type: String, default: '' },
  status: { type: String, enum: ['pending', 'active', 'dead'], default: 'pending' },
  createdAt: { type: Date, default: Date.now },
  lastActiveAt: { type: Date, default: Date.now }
});

module.exports = model('WaSession', waSessionSchema);
