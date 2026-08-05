const mongoose = require('mongoose');
const { formatProxy } = require('../utils/proxy');

const proxySchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    host: { type: String, required: true, trim: true },
    port: { type: String, required: true, trim: true },
    username: { type: String, trim: true, default: '' },
    password: { type: String, default: '' },
    note: { type: String, trim: true, default: '' },
    enabled: { type: Boolean, default: true, index: true }
  },
  { timestamps: true }
);

proxySchema.methods.toConnectionString = function toConnectionString() {
  return formatProxy({
    host: this.host,
    port: this.port,
    username: this.username,
    password: this.password
  });
};

proxySchema.methods.toSafeJSON = function toSafeJSON() {
  const obj = this.toObject();
  if (obj.password) obj.password = '********';
  obj.connectionString = this.toConnectionString();
  return obj;
};

module.exports = mongoose.model('Proxy', proxySchema);
