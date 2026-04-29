const { withAppDelegate, withDangerousMod, withInfoPlist } = require('@expo/config-plugins');
const fs = require('node:fs');
const path = require('node:path');

function addOnce(contents, needle, addition) {
  if (contents.includes(needle)) {
    return contents;
  }

  return addition(contents);
}

function addSwiftImport(contents, importLine) {
  return addOnce(contents, importLine, (value) =>
    value.replace(/(import\s+Expo\n)/, `$1${importLine}\n`),
  );
}

function addVoipRegistration(contents) {
  if (contents.includes('RNVoipPushNotificationManager.voipRegistration()')) {
    return contents;
  }

  return contents.replace(
    /return super\.application\(application, didFinishLaunchingWithOptions: launchOptions\)/,
    'RNVoipPushNotificationManager.voipRegistration()\n    return super.application(application, didFinishLaunchingWithOptions: launchOptions)',
  );
}

function addPushKitExtension(contents) {
  contents = contents.replace(
    'RNVoipPushNotificationManager.didUpdatePushCredentials(pushCredentials, forType: type.rawValue)',
    'RNVoipPushNotificationManager.didUpdate(pushCredentials, forType: type.rawValue)',
  );

  const extensionStart = contents.indexOf('extension AppDelegate: PKPushRegistryDelegate');
  if (extensionStart >= 0) {
    return `${contents.slice(0, extensionStart).trimEnd()}\n\n${pushKitExtension()}`;
  }

  return `${contents}

${pushKitExtension()}`;
}

function pushKitExtension() {
  return `private var infChatTerminalCallUUIDs = Set<String>()

extension AppDelegate: PKPushRegistryDelegate {
  public func pushRegistry(_ registry: PKPushRegistry, didUpdate pushCredentials: PKPushCredentials, for type: PKPushType) {
    RNVoipPushNotificationManager.didUpdate(pushCredentials, forType: type.rawValue)
  }

  public func pushRegistry(_ registry: PKPushRegistry, didInvalidatePushTokenFor type: PKPushType) {}

  public func pushRegistry(
    _ registry: PKPushRegistry,
    didReceiveIncomingPushWith payload: PKPushPayload,
    for type: PKPushType,
    completion: @escaping () -> Void
  ) {
    let payloadDictionary = payload.dictionaryPayload
    let uuid = payloadDictionary["uuid"] as? String ?? UUID().uuidString
    let callerName = payloadDictionary["callerName"] as? String ?? "InfChat"
    let handle = payloadDictionary["handle"] as? String ?? callerName
    let hasVideo = (payloadDictionary["kind"] as? String) == "video"

    if (payloadDictionary["type"] as? String) == "call_update" {
      infChatTerminalCallUUIDs.insert(uuid)
      RNVoipPushNotificationManager.didReceiveIncomingPush(with: payload, forType: type.rawValue)
      RNCallKeep.endCall(withUUID: uuid, reason: infChatCallEndReason(payloadDictionary["status"] as? String ?? "ended"))
      completion()
      return
    }

    if infChatTerminalCallUUIDs.contains(uuid) {
      completion()
      return
    }

    RNVoipPushNotificationManager.addCompletionHandler(uuid, completionHandler: completion)
    RNVoipPushNotificationManager.didReceiveIncomingPush(with: payload, forType: type.rawValue)
    RNCallKeep.reportNewIncomingCall(
      uuid,
      handle: handle,
      handleType: "generic",
      hasVideo: hasVideo,
      localizedCallerName: callerName,
      supportsHolding: false,
      supportsDTMF: false,
      supportsGrouping: false,
      supportsUngrouping: false,
      fromPushKit: true,
      payload: payloadDictionary,
      withCompletionHandler: completion
    )
  }

  private func infChatCallEndReason(_ status: String) -> Int32 {
    switch status {
    case "active":
      return 4
    case "declined":
      return 5
    case "missed":
      return 6
    default:
      return 2
    }
  }
}
`;
}

module.exports = function withIosCallNotifications(config) {
  config = withInfoPlist(config, (mod) => {
    const modes = new Set(mod.modResults.UIBackgroundModes || []);
    modes.add('audio');
    modes.add('remote-notification');
    modes.add('voip');
    mod.modResults.UIBackgroundModes = [...modes];
    return mod;
  });

  config = withAppDelegate(config, (mod) => {
    if (mod.modResults.language !== 'swift') {
      return mod;
    }

    let contents = mod.modResults.contents;
    contents = addSwiftImport(contents, 'import PushKit');
    contents = addVoipRegistration(contents);
    contents = addPushKitExtension(contents);
    mod.modResults.contents = contents;
    return mod;
  });

  config = withDangerousMod(config, [
    'ios',
    (mod) => {
      const headerPath = path.join(
        mod.modRequest.platformProjectRoot,
        mod.modRequest.projectName,
        `${mod.modRequest.projectName}-Bridging-Header.h`,
      );
      let contents = fs.existsSync(headerPath) ? fs.readFileSync(headerPath, 'utf8') : '';
      contents = addOnce(
        contents,
        '#import "RNCallKeep.h"',
        (value) => `${value.trimEnd()}\n#import "RNCallKeep.h"\n`,
      );
      contents = addOnce(
        contents,
        '#import "RNVoipPushNotificationManager.h"',
        (value) => `${value.trimEnd()}\n#import "RNVoipPushNotificationManager.h"\n`,
      );
      fs.writeFileSync(headerPath, contents);
      return mod;
    },
  ]);

  return config;
};
