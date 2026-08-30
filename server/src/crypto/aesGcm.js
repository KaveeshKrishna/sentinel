'use strict';

const crypto = require('crypto');
const { loadSecretKey } = require('./secretKey');

const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;

/** Encrypt a UTF-8 string; returns base64(iv + authTag + ciphertext). Random IV per call. */
function encrypt(plaintext) {
  const key = loadSecretKey();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, authTag, ciphertext]).toString('base64');
}

/** Decrypt a blob produced by encrypt(). Throws if the key or blob is wrong/tampered. */
function decrypt(blob) {
  const key = loadSecretKey();
  const raw = Buffer.from(blob, 'base64');
  const iv = raw.subarray(0, IV_LENGTH);
  const authTag = raw.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
  const ciphertext = raw.subarray(IV_LENGTH + AUTH_TAG_LENGTH);

  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

module.exports = { encrypt, decrypt };
