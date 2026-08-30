'use strict';

const { execFileSync } = require('child_process');
const { UNITS } = require('./paths');

function systemctl(args) {
  return execFileSync('systemctl', args, { encoding: 'utf8' });
}

/** Returns 'active'/'inactive'/'failed'/etc — never throws. */
function isActive(unit) {
  try {
    return systemctl(['is-active', unit]).trim();
  } catch (err) {
    return (err.stdout || 'inactive').trim() || 'inactive';
  }
}

/** Returns 'enabled'/'disabled'/'not-found'/etc — never throws. */
function isEnabled(unit) {
  try {
    return systemctl(['is-enabled', unit]).trim();
  } catch (err) {
    return (err.stdout || 'disabled').trim() || 'disabled';
  }
}

function start(units = UNITS) { systemctl(['start', ...units]); }
function stop(units = UNITS) { systemctl(['stop', ...units]); }
function restart(units = UNITS) { systemctl(['restart', ...units]); }
function enable(units = UNITS) { systemctl(['enable', ...units]); }
function disable(units = UNITS) { systemctl(['disable', ...units]); }
function daemonReload() { systemctl(['daemon-reload']); }

module.exports = { systemctl, isActive, isEnabled, start, stop, restart, enable, disable, daemonReload, UNITS };
