import { registerPushDevice, type PushEnvironment } from '@infchat/pocketbase';
import Constants from 'expo-constants';
import * as Notifications from 'expo-notifications';
import { router } from 'expo-router';
import { Platform } from 'react-native';
import RNCallKeep from 'react-native-callkeep';
import VoipPushNotification from 'react-native-voip-push-notification';

import { getDeviceId } from './device-id';
import { pb } from './pocketbase';

type CallPushPayload = {
  callerName?: string;
  callRoomId?: string;
  conversationId?: string;
  handle?: string;
  kind?: 'video' | 'voice';
  type?: string;
  uuid?: string;
};

const callPushesByUUID = new Map<string, CallPushPayload>();

export function setupNotificationPresentation() {
  Notifications.setNotificationHandler({
    handleNotification: async () => ({
      shouldPlaySound: true,
      shouldSetBadge: true,
      shouldShowAlert: true,
      shouldShowBanner: true,
      shouldShowList: true,
    }),
  });
}

export async function registerIOSPushDevice(appVersion?: string) {
  if (Platform.OS !== 'ios' || !pb.authStore.isValid) {
    return;
  }

  const permissions = await Notifications.requestPermissionsAsync({
    ios: {
      allowAlert: true,
      allowBadge: true,
      allowSound: true,
    },
  });
  const granted =
    permissions.granted ||
    permissions.ios?.status === Notifications.IosAuthorizationStatus.PROVISIONAL;
  if (!granted) {
    return;
  }

  const token = await Notifications.getDevicePushTokenAsync();
  if (token.type !== 'ios' || typeof token.data !== 'string') {
    return;
  }

  await registerPushDevice(pb, {
    apnsToken: token.data,
    appVersion,
    deviceId: await getDeviceId(),
    environment: getPushEnvironment(),
    platform: 'ios',
  });
}

export function setupIOSSystemCalls() {
  if (Platform.OS !== 'ios') {
    return () => {};
  }

  void RNCallKeep.setup({
    android: {
      additionalPermissions: [],
      alertDescription: 'InfChat needs phone account access for calls.',
      alertTitle: 'Phone account access',
      cancelButton: 'Cancel',
      okButton: 'OK',
    },
    ios: {
      appName: 'InfChat',
      includesCallsInRecents: false,
      maximumCallGroups: '1',
      maximumCallsPerCallGroup: '1',
      supportsVideo: true,
    },
  });
  RNCallKeep.canMakeMultipleCalls(false);

  const answerSubscription = RNCallKeep.addEventListener('answerCall', ({ callUUID }) => {
    const payload = callPushesByUUID.get(callUUID);
    if (!payload?.callRoomId) {
      RNCallKeep.endCall(callUUID);
      return;
    }

    RNCallKeep.setCurrentCallActive(callUUID);
    router.push({
      pathname: '/call/[id]',
      params: { id: payload.callRoomId },
    });
  });
  const endSubscription = RNCallKeep.addEventListener('endCall', ({ callUUID }) => {
    callPushesByUUID.delete(callUUID);
  });

  VoipPushNotification.addEventListener('register', (token) => {
    void registerVoipToken(token, Constants.expoConfig?.version);
  });
  VoipPushNotification.addEventListener('notification', (notification) => {
    const payload = notification as CallPushPayload;
    if (payload.uuid) {
      callPushesByUUID.set(payload.uuid, payload);
      VoipPushNotification.onVoipNotificationCompleted(payload.uuid);
    }
  });
  VoipPushNotification.addEventListener('didLoadWithEvents', (events) => {
    for (const event of events ?? []) {
      if (event.name === VoipPushNotification.RNVoipPushRemoteNotificationsRegisteredEvent) {
        void registerVoipToken(event.data as string, Constants.expoConfig?.version);
      }
      if (event.name === VoipPushNotification.RNVoipPushRemoteNotificationReceivedEvent) {
        const payload = event.data as CallPushPayload;
        if (payload.uuid) {
          callPushesByUUID.set(payload.uuid, payload);
        }
      }
    }
  });
  VoipPushNotification.registerVoipToken();

  const notificationSubscription = Notifications.addNotificationResponseReceivedListener(
    (response) => {
      const data = response.notification.request.content.data;
      if (data?.type === 'message' && typeof data.conversationId === 'string') {
        router.push({
          pathname: '/chat/[id]',
          params: { id: data.conversationId },
        });
      }
    },
  );

  return () => {
    answerSubscription.remove();
    endSubscription.remove();
    notificationSubscription.remove();
    VoipPushNotification.removeEventListener('register');
    VoipPushNotification.removeEventListener('notification');
    VoipPushNotification.removeEventListener('didLoadWithEvents');
  };
}

async function registerVoipToken(token: string, appVersion?: string) {
  if (!pb.authStore.isValid) {
    return;
  }

  await registerPushDevice(pb, {
    appVersion,
    deviceId: await getDeviceId(),
    environment: getPushEnvironment(),
    platform: 'ios',
    voipToken: token,
  });
}

function getPushEnvironment(): PushEnvironment {
  const publicEnv = process.env.EXPO_PUBLIC_APNS_ENV;
  const configuredEnv = Constants.expoConfig?.extra?.apnsEnv;

  return publicEnv === 'production' || configuredEnv === 'production' ? 'production' : 'sandbox';
}
