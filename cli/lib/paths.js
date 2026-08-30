'use strict';

// Canonical filesystem layout the installer creates. Kept in one place
// so the CLI, the installer, and (indirectly, via env files) the
// services themselves agree on where everything lives.
module.exports = {
  CONFIG_DIR: '/etc/sentinel',
  AGENT_ENV: '/etc/sentinel/agent.env',
  SERVER_ENV: '/etc/sentinel/server.env',
  AGENT_TOKEN: '/etc/sentinel/agent.token',
  SECRET_KEY: '/etc/sentinel/secret.key',
  DATA_DIR: '/var/lib/sentinel',
  DB_PATH: '/var/lib/sentinel/sentinel.db',
  LOG_DIR: '/var/log/sentinel',
  APP_DIR: '/usr/lib/sentinel',
  AGENT_SOCKET: '/run/sentinel/agent.sock',
  SYSTEMD_UNIT_DIR: '/etc/systemd/system',
  UNITS: ['sentinel-agent', 'sentinel-server']
};
