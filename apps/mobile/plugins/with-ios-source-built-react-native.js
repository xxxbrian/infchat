const { withPodfileProperties } = require('@expo/config-plugins');

module.exports = function withIosSourceBuiltReactNative(config) {
  return withPodfileProperties(config, (mod) => {
    mod.modResults['ios.buildReactNativeFromSource'] = 'true';
    return mod;
  });
};
