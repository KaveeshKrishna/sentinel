#!/usr/bin/env node
'use strict';

/**
 * Sentinel Setup Script
 * Run: node scripts/setup.js
 *
 * Creates a .env file in the backend directory with:
 *  - bcrypt-hashed admin password
 *  - cryptographically random JWT secret
 *  - all required environment variables
 */

const readline = require('readline');
const bcrypt   = require('bcrypt');
const crypto   = require('crypto');
const fs       = require('fs');
const path     = require('path');

const ENV_FILE    = path.resolve(__dirname, '../.env');
const ENV_EXAMPLE = path.resolve(__dirname, '../.env.example');

async function question(rl, prompt) {
  return new Promise(resolve => rl.question(prompt, resolve));
}

async function main() {
  console.log('\n╔══════════════════════════════════╗');
  console.log('║  🛡️   Sentinel Setup Wizard      ║');
  console.log('╚══════════════════════════════════╝\n');

  if (fs.existsSync(ENV_FILE)) {
    console.log('⚠️  A .env file already exists.');
    console.log('   Delete it manually if you want to regenerate credentials.\n');
    process.exit(0);
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  // Username
  const username = ((await question(rl, 'Admin username [admin]: ')).trim()) || 'admin';

  // Password (min 8 chars)
  let password = '';
  while (password.length < 8) {
    password = (await question(rl, 'Admin password (min 8 characters): ')).trim();
    if (password.length < 8) console.log('  ❌ Password must be at least 8 characters.\n');
  }

  // Public IP (optional)
  const publicIp = (await question(rl, 'Server public IP (optional, press Enter to skip): ')).trim();

  rl.close();

  console.log('\n⏳ Hashing password with bcrypt (cost=12)…');
  const hash      = await bcrypt.hash(password, 12);
  const jwtSecret = crypto.randomBytes(64).toString('hex');

  const envContent = `# ─────────────────────────────────────────
# Sentinel Configuration
# Generated: ${new Date().toISOString()}
# ─────────────────────────────────────────

# Authentication — NEVER share these values
ADMIN_USERNAME=${username}
ADMIN_PASSWORD_HASH=${hash}
JWT_SECRET=${jwtSecret}

# Network info (displayed on dashboard)
LAN_IP=192.168.1.50
PUBLIC_IP=${publicIp}

# Runtime
NODE_ENV=production
PORT=3000

# Host paths (bind-mounted in compose.yml)
HOST_PROC=/host/proc
HOST_SYS=/host/sys
APPS_PATH=/srv/apps
DB_PATH=/app/data/sentinel.db
CADDY_FILE=/host/caddy/Caddyfile
CADDY_LOG=/host/var/log/caddy/access.log
`;

  fs.writeFileSync(ENV_FILE, envContent, { mode: 0o600 });

  console.log('\n✅ Setup complete!\n');
  console.log(`   Admin username : ${username}`);
  console.log(`   .env created   : ${ENV_FILE}`);
  console.log(`   JWT secret     : ${jwtSecret.slice(0, 12)}… (${jwtSecret.length} chars)\n`);
  console.log('▶  Run:  docker compose up -d  (from the project root)\n');
}

main().catch(err => {
  console.error('\n❌ Setup failed:', err.message);
  process.exit(1);
});
