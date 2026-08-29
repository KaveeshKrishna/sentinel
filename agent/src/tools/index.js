'use strict';

const registerSystemTools = require('./system');
const registerDockerTools = require('./docker');
const registerServiceTools = require('./services');
const registerStorageTools = require('./storage');
const registerProcessTools = require('./process');
const registerNetworkTools = require('./network');
const registerGitTools = require('./git');
const registerFileTools = require('./files');

/** Register the full Phase-1 tool set against a ToolRegistry instance. */
module.exports = function registerAllTools(registry) {
  registerSystemTools(registry);
  registerDockerTools(registry);
  registerServiceTools(registry);
  registerStorageTools(registry);
  registerProcessTools(registry);
  registerNetworkTools(registry);
  registerGitTools(registry);
  registerFileTools(registry);
};
