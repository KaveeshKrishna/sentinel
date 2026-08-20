'use strict';

const fs = require('fs');

const HOST_PROC = process.env.HOST_PROC || '/proc';

/**
 * Read system uptime in seconds from /proc/uptime.
 */
function getUptime() {
  try {
    const content = fs.readFileSync(`${HOST_PROC}/uptime`, 'utf8');
    return parseFloat(content.split(' ')[0]);
  } catch {
    return 0;
  }
}

module.exports = { getUptime };
