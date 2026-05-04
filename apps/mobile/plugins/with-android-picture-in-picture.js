const { AndroidConfig, withAndroidManifest } = require('@expo/config-plugins');

module.exports = function withAndroidPictureInPicture(config) {
  return withAndroidManifest(config, (mod) => {
    const mainActivity = AndroidConfig.Manifest.getMainActivityOrThrow(mod.modResults);
    mainActivity.$['android:supportsPictureInPicture'] = 'true';
    mainActivity.$['android:resizeableActivity'] = 'true';

    const configChanges = new Set(
      String(mainActivity.$['android:configChanges'] || '')
        .split('|')
        .filter(Boolean),
    );
    configChanges.add('screenSize');
    configChanges.add('smallestScreenSize');
    configChanges.add('screenLayout');
    mainActivity.$['android:configChanges'] = [...configChanges].join('|');

    return mod;
  });
};
