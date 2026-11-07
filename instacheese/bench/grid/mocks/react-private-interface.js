'use strict';
// react-native/react-private-interface, as far as @react-native/virtualized-lists
// (0.88+) uses it: the feature flags, served from the defaults mock.
module.exports = {
  get ReactNativeFeatureFlags() {
    return require('./feature-flags');
  },
};
