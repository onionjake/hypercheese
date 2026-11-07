'use strict';
// Default-export shims for the relative imports inside RN's FlatList.js.
const RN = require('./react-native');
module.exports = {
  View: { __esModule: true, default: RN.View },
  StyleSheet: { __esModule: true, default: RN.StyleSheet },
  Platform: { __esModule: true, default: RN.Platform },
  ScrollView: { __esModule: true, default: RN.ScrollView },
};
