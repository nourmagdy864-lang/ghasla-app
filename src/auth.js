// auth.js — تشفير كلمات المرور وإدارة جلسات الدخول (بدون مكتبات خارجية)

const crypto = require('crypto');
const db = require('./db');

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 يوم

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(password), salt, 32).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  if (!stored) return false;
  const [salt, hash] = stored.split(':');
  const check = crypto.scryptSync(String(password), salt, 32).toString('hex');
  return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(check, 'hex'));
}

function verifyPin(pin, stored) {
  return verifyPassword(pin, stored);
}

function createSession(userId, role, extra = {}) {
  const data = db.get();
  const token = crypto.randomBytes(24).toString('hex');
  data.sessions[token] = {
    userId,
    role, // 'customer' أو 'employee'
    ...extra,
    expiresAt: Date.now() + SESSION_TTL_MS
  };
  db.persist();
  return token;
}

function getSession(token) {
  if (!token) return null;
  const data = db.get();
  const session = data.sessions[token];
  if (!session) return null;
  if (session.expiresAt < Date.now()) {
    delete data.sessions[token];
    db.persist();
    return null;
  }
  return session;
}

function destroySession(token) {
  const data = db.get();
  delete data.sessions[token];
  db.persist();
}

function getTokenFromReq(req) {
  const header = req.headers['authorization'] || '';
  const match = header.match(/^Bearer (.+)$/);
  return match ? match[1] : null;
}

module.exports = {
  hashPassword,
  verifyPassword,
  verifyPin,
  createSession,
  getSession,
  destroySession,
  getTokenFromReq
};
