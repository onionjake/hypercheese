const fs = require('fs');
const path = require('path');

// google-services.json comes from Firebase and enables push notifications.
// CI writes it from a repository secret for release builds; developers can
// drop one in locally to test. Without it the app still builds and runs —
// push notifications are simply unavailable.
module.exports = ({ config }) => {
  if (fs.existsSync(path.join(__dirname, 'google-services.json'))) {
    config.android = { ...config.android, googleServicesFile: './google-services.json' };
  }
  return config;
};
