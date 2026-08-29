const { Schema, model } = require('mongoose');

// A single media attachment stored as base64 (small files) is avoided here.
// Instead we store the Telegram file_id (permanent, re-downloadable via Bot API any time)
// so we never need our own file storage/CDN.
const mediaSchema = new Schema({
  telegramFileId: { type: String, required: true },
  type: { type: String, enum: ['image', 'document', 'voice', 'video', 'audio'], required: true },
  fileName: { type: String, default: '' }
}, { _id: false });

const templateSchema = new Schema({
  telegramId: { type: String, required: true, index: true },
  name: { type: String, default: '' },        // optional label, just for identifying it in the list
  message: { type: String, default: '' },     // caption / greeting text, optional
  images: { type: [mediaSchema], default: [] },
  files: { type: [mediaSchema], default: [] }, // documents / voice notes etc.
  active: { type: Boolean, default: false },   // only ONE template per telegramId can be active at a time
  createdAt: { type: Date, default: Date.now }
});

module.exports = model('Template', templateSchema);
