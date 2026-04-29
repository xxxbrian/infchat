import { endCall, registerPushDevice, type PushEnvironment } from '@infchat/pocketbase';
import Constants from 'expo-constants';
import * as Notifications from 'expo-notifications';
import { router } from 'expo-router';
import { Platform } from 'react-native';
import RNCallKeep, { CONSTANTS as CALLKEEP_CONSTANTS } from 'react-native-callkeep';
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
const endingSystemCallUUIDs = new Set<string>();
let currentNotificationRoute = '';
let lastHandledNotificationResponseId = '';

type SystemCallPayload = CallPushPayload & { callUUID: string };

type SystemCallHandlers = {
  onAnswerCall?: (payload: SystemCallPayload) => Promise<void> | void;
  onEndCall?: (payload: SystemCallPayload) => Promise<void> | void;
};

export type IOSSystemCallEndReason =
  | 'answered-elsewhere'
  | 'declined-elsewhere'
  | 'local'
  | 'missed'
  | 'remote-ended';

let systemCallHandlers: SystemCallHandlers = {};

export function setIOSSystemCallHandlers(handlers: SystemCallHandlers) {
  systemCallHandlers = handlers;

  return () => {
    if (systemCallHandlers === handlers) {
      systemCallHandlers = {};
    }
  };
}

export function endIOSSystemCallForCallRoom(
  callRoomId: string,
  reason: IOSSystemCallEndReason = 'remote-ended',
) {
  if (Platform.OS !== 'ios') {
    return;
  }

  for (const [callUUID, payload] of callPushesByUUID.entries()) {
    if (payload.callRoomId !== callRoomId) {
      continue;
    }

    endingSystemCallUUIDs.add(callUUID);
    callPushesByUUID.delete(callUUID);
    if (reason === 'local') {
      RNCallKeep.endCall(callUUID);
    } else {
      RNCallKeep.reportEndCallWithUUID(callUUID, toCallKeepEndReason(reason));
    }
    return;
  }
}

function toCallKeepEndReason(reason: Exclude<IOSSystemCallEndReason, 'local'>): number {
  switch (reason) {
    case 'answered-elsewhere':
      return CALLKEEP_CONSTANTS.END_CALL_REASONS.ANSWERED_ELSEWHERE;
    case 'declined-elsewhere':
      return CALLKEEP_CONSTANTS.END_CALL_REASONS.DECLINED_ELSEWHERE;
    case 'missed':
      return CALLKEEP_CONSTANTS.END_CALL_REASONS.MISSED;
    case 'remote-ended':
      return CALLKEEP_CONSTANTS.END_CALL_REASONS.REMOTE_ENDED;
  }
}

export function setupNotificationPresentation() {
  Notifications.setNotificationHandler({
    handleNotification: async (notification) => {
      const data = notification.request.content.data;
      const isActiveChatMessage =
        data?.type === 'message' &&
        typeof data.conversationId === 'string' &&
        currentNotificationRoute === `/chat/${data.conversationId}`;

      return {
        shouldPlaySound: !isActiveChatMessage,
        shouldSetBadge: true,
        shouldShowAlert: !isActiveChatMessage,
        shouldShowBanner: !isActiveChatMessage,
        shouldShowList: !isActiveChatMessage,
      };
    },
  });
}

export function setCurrentNotificationRoute(pathname: string) {
  currentNotificationRoute = pathname;
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

  const handleAnswerCall = (callUUID: string) => {
    const payload = callPushesByUUID.get(callUUID);
    if (!payload?.callRoomId) {
      RNCallKeep.endCall(callUUID);
      return;
    }

    const actionPayload = { ...payload, callUUID };
    if (systemCallHandlers.onAnswerCall) {
      void Promise.resolve(systemCallHandlers.onAnswerCall(actionPayload))
        .then(() => RNCallKeep.setCurrentCallActive(callUUID))
        .catch(() => RNCallKeep.endCall(callUUID));
      return;
    }

    router.push({
      pathname: '/call/[id]',
      params: { id: payload.callRoomId },
    });
  };
  const handleEndCall = (callUUID: string) => {
    const payload = callPushesByUUID.get(callUUID);
    callPushesByUUID.delete(callUUID);
    if (endingSystemCallUUIDs.delete(callUUID)) {
      return;
    }

    if (!payload?.callRoomId) {
      return;
    }

    const actionPayload = { ...payload, callUUID };
    if (systemCallHandlers.onEndCall) {
      void systemCallHandlers.onEndCall(actionPayload);
      return;
    }

    void endCall(pb, payload.callRoomId);
  };

  const answerSubscription = RNCallKeep.addEventListener('answerCall', ({ callUUID }) => {
    handleAnswerCall(callUUID);
  });
  const endSubscription = RNCallKeep.addEventListener('endCall', ({ callUUID }) => {
    handleEndCall(callUUID);
  });
  const callKeepInitialEventsSubscription = RNCallKeep.addEventListener(
    'didLoadWithEvents',
    (events) => {
      for (const event of events ?? []) {
        if (event.name === 'RNCallKeepPerformAnswerCallAction') {
          handleAnswerCall(event.data.callUUID);
        }
        if (event.name === 'RNCallKeepPerformEndCallAction') {
          handleEndCall(event.data.callUUID);
        }
      }
    },
  );

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
          VoipPushNotification.onVoipNotificationCompleted(payload.uuid);
        }
      }
    }
  });
  VoipPushNotification.registerVoipToken();

  const notificationSubscription = Notifications.addNotificationResponseReceivedListener(
    handleNotificationResponse,
  );
  void Notifications.getLastNotificationResponseAsync().then((response) => {
    if (response) {
      handleNotificationResponse(response);
    }
  });

  return () => {
    answerSubscription.remove();
    callKeepInitialEventsSubscription.remove();
    endSubscription.remove();
    notificationSubscription.remove();
    VoipPushNotification.removeEventListener('register');
    VoipPushNotification.removeEventListener('notification');
    VoipPushNotification.removeEventListener('didLoadWithEvents');
  };
}

function handleNotificationResponse(response: Notifications.NotificationResponse) {
  const responseId = `${response.notification.request.identifier}:${response.actionIdentifier}`;
  if (lastHandledNotificationResponseId === responseId) {
    return;
  }
  lastHandledNotificationResponseId = responseId;

  const data = response.notification.request.content.data;
  if (data?.type === 'message' && typeof data.conversationId === 'string') {
    router.push({
      pathname: '/chat/[id]',
      params: { id: data.conversationId },
    });
  }
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
  const publicEnv = process.env.EXPO_PUBLIC_APNS_ENV?.trim().toLowerCase();

  if (publicEnv === 'sandbox' || publicEnv === 'production') {
    return publicEnv;
  }

  return __DEV__ ? 'sandbox' : 'production';
}
