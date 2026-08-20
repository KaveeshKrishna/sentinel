'use strict';

const fs = require('fs');

const HOST_SYS = process.env.HOST_SYS || '/sys';

/**
 * Read CPU temperature from /sys/class/thermal/thermal_zone*/
/*temp.
 * Prefers zones of type x86_pkg_temp or coretemp; falls back to zone0.
 */
function getCpuTemperature() {
  const zones = [];
  try {
    const thermalPath = `${HOST_SYS}/class/thermal`;
    const entries = fs.readdirSync(thermalPath).filter(e => e.startsWith('thermal_zone'));

    for (const entry of entries) {
      try {
        const base = `${thermalPath}/${entry}`;
        const type = fs.readFileSync(`${base}/type`, 'utf8').trim();
        const tempRaw = parseInt(fs.readFileSync(`${base}/temp`, 'utf8').trim());
        if (isNaN(tempRaw)) continue;
        zones.push({ zone: entry, type, temp: tempRaw / 1000 });
      } catch {}
    }
  } catch {}

  // Prefer Intel package temp or coretemp; fall back to first available zone
  const preferred = zones.find(z =>
    z.type === 'x86_pkg_temp' || z.type === 'coretemp' || z.type.includes('cpu')
  ) || zones[0] || null;

  return {
    current: preferred ? Math.round(preferred.temp * 10) / 10 : null,
    zone: preferred?.zone || null,
    type: preferred?.type || null,
    allZones: zones
  };
}

module.exports = { getCpuTemperature };
