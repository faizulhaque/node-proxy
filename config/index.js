'use strict'

const nconf = require('nconf')
const path = require('path')

load()

function load () {
  // Set hierarchy of configuration
  // 1. Passed command-line arguments
  // 2. Environment variables
  // 3. Sensitive environment-specific config file (.config.{environment}.json)
  // 4. Sensitive generic config file (.config.generic.json)
  // 5. Environment-specific config file (config.{environment}.json)
  // 6. Generic config file (config.generic.json)

  // Use command-line arguments
  nconf.argv();

  // Use environment variables. Use __ as a separator, so setting an env as
  // db__pass would then set the db:pass setting.
  nconf.env('__');

  const env = nconf.get('NODE_ENV');

  // Use the various config files
  nconf.file('localOverride', path.resolve(__dirname, '.config.json'));
  nconf.file('sensitiveEnvironment', path.resolve(__dirname, '.config.' + env + '.json'));
  nconf.file('sensitiveGeneric', path.resolve(__dirname, '.config.generic.json'));
  nconf.file('safeEnvironment', path.resolve(__dirname, 'config.' + env + '.json'));
  nconf.file('safeGeneric', path.resolve(__dirname, 'config.generic.json'));
}

module.exports = {
  get: function (key) {
    return nconf.get(key);
  },
  isProduction: function () {
    return nconf.get('NODE_ENV') === 'production';
  },
  isLocal: function () {
    return nconf.get('NODE_ENV') === 'local';
  },
  isDevelopment: function () {
    return nconf.get('NODE_ENV') === 'development';
  }
}
