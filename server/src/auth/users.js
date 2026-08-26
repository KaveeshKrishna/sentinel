'use strict';

const bcrypt = require('bcrypt');
const { getDb } = require('../db/connection');

const BCRYPT_COST = 12;

function countUsers() {
  return getDb().prepare('SELECT COUNT(*) AS c FROM users').get().c;
}

function getUserByUsername(username) {
  return getDb().prepare('SELECT * FROM users WHERE username = ?').get(username);
}

function getUserById(id) {
  return getDb().prepare('SELECT * FROM users WHERE id = ?').get(id);
}

async function createUser(username, password, role = 'owner') {
  const passwordHash = await bcrypt.hash(password, BCRYPT_COST);
  const info = getDb()
    .prepare('INSERT INTO users (username, password_hash, role, created_at) VALUES (?, ?, ?, ?)')
    .run(username, passwordHash, role, Date.now());
  return getUserById(info.lastInsertRowid);
}

function touchLastLogin(userId) {
  getDb().prepare('UPDATE users SET last_login_at = ? WHERE id = ?').run(Date.now(), userId);
}

module.exports = { countUsers, getUserByUsername, getUserById, createUser, touchLastLogin, BCRYPT_COST };
