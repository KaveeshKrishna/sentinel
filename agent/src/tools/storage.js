'use strict';

const { getDiskUsage, getDiskIO } = require('../collectors/disk');

module.exports = function registerStorageTools(registry) {
  registry.register({
    name: 'inspect_disk',
    description: 'Get disk usage and I/O throughput for the host.',
    risk: 'READ_ONLY',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    handler: async () => ({ usage: getDiskUsage(), io: getDiskIO() })
  });
};
