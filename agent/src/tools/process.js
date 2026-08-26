'use strict';

const fs = require('fs');
const path = require('path');

const HOST_PROC = process.env.HOST_PROC || '/proc';

function readProcEntry(pid) {
  try {
    const statusRaw = fs.readFileSync(path.join(HOST_PROC, pid, 'status'), 'utf8');
    const statRaw = fs.readFileSync(path.join(HOST_PROC, pid, 'stat'), 'utf8');

    const nameMatch = statusRaw.match(/^Name:\s+(.+)$/m);
    const stateMatch = statusRaw.match(/^State:\s+(\S+)/m);
    const rssMatch = statusRaw.match(/^VmRSS:\s+(\d+)\s+kB/m);

    // /proc/[pid]/stat fields: pid (comm) state ppid ... utime(14) stime(15)
    // — parse from after the closing paren since comm can itself contain
    // spaces/parens.
    const statFields = statRaw.slice(statRaw.lastIndexOf(')') + 2).trim().split(/\s+/);
    const utime = parseInt(statFields[11], 10) || 0;
    const stime = parseInt(statFields[12], 10) || 0;

    return {
      pid: parseInt(pid, 10),
      name: nameMatch ? nameMatch[1] : 'unknown',
      state: stateMatch ? stateMatch[1] : '?',
      rssKb: rssMatch ? parseInt(rssMatch[1], 10) : 0,
      cpuTicks: utime + stime
    };
  } catch {
    return null;
  }
}

module.exports = function registerProcessTools(registry) {
  registry.register({
    name: 'inspect_processes',
    description: 'List the top host processes by memory usage (RSS), with cumulative CPU ticks since process start.',
    risk: 'READ_ONLY',
    parameters: {
      type: 'object',
      properties: { limit: { type: 'integer', minimum: 1, maximum: 100 } },
      additionalProperties: false
    },
    handler: async ({ limit } = {}) => {
      const pids = fs.readdirSync(HOST_PROC).filter(d => /^\d+$/.test(d));
      const entries = pids.map(readProcEntry).filter(Boolean);
      entries.sort((a, b) => b.rssKb - a.rssKb);
      return entries.slice(0, limit || 20);
    }
  });
};
