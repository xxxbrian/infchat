import type { PushEnvironment } from '@infchat/pocketbase';
import * as Notifications from 'expo-notifications';
import { router } from 'expo-router';

type CallPushPayload = {
  callerName?: string;
  callRoomId?: string;
  conversationId?: string;
  handle?: string;
  kind?: 'video' | 'voice';
  status?: string;
  type?: string;
  uuid?: string;
};

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

let lastHandledNotificationResponseId = '';

export function setupNotificationPresentation() {
  Notifications.setNotificationHandler({
    handleNotification: async (notification) => {
      const data = notification.request.content.data;
      const isMessageNotification = data?.type === 'message';

      return {
        shouldPlaySound: !isMessageNotification,
        shouldSetBadge: true,
        shouldShowAlert: !isMessageNotification,
        shouldShowBanner: !isMessageNotification,
        shouldShowList: !isMessageNotification,
      };
    },
  });
}

export function setupNotificationResponses(onMessageResponse?: () => void) {
  const notificationSubscription = Notifications.addNotificationResponseReceivedListener(
    (response) => handleNotificationResponse(response, onMessageResponse),
  );
  void Notifications.getLastNotificationResponseAsync().then((response) => {
    if (response) {
      handleNotificationResponse(response, onMessageResponse);
    }
  });

  return () => {
    notificationSubscription.remove();
  };
}

export function setupCallUpdateBackgroundNotifications() {}

export async function registerPushDeviceForPlatform(
  _appVersion?: string,
  _options: { throwOnFailure?: boolean } = {},
) {
  return false;
}

export function setupPushRegistrationRecovery(_appVersion?: string) {
  return () => {};
}

export function setupSystemCalls() {
  return () => {};
}

export function setSystemCallHandlers(_handlers: SystemCallHandlers) {
  return () => {};
}

export function endSystemCallForCallRoom(
  _callRoomId: string,
  _reason: IOSSystemCallEndReason = 'remote-ended',
) {}

export const registerIOSPushDevice = registerPushDeviceForPlatform;
export const setupIOSPushRegistrationRecovery = setupPushRegistrationRecovery;
export const setupIOSSystemCalls = setupSystemCalls;
export const setIOSSystemCallHandlers = setSystemCallHandlers;
export const endIOSSystemCallForCallRoom = endSystemCallForCallRoom;

export function getPushEnvironment(): PushEnvironment {
  const publicEnv = process.env.EXPO_PUBLIC_APNS_ENV?.trim().toLowerCase();

  if (publicEnv === 'sandbox' || publicEnv === 'production') {
    return publicEnv;
  }

  return __DEV__ ? 'sandbox' : 'production';
}

export function getPushProviderLabel() {
  return 'Android notifications';
}

export function isPushRegistrationSupported() {
  return false;
}

function handleNotificationResponse(
  response: Notifications.NotificationResponse,
  onMessageResponse?: () => void,
) {
  const responseId = `${response.notification.request.identifier}:${response.actionIdentifier}`;
  if (lastHandledNotificationResponseId === responseId) {
    return;
  }
  lastHandledNotificationResponseId = responseId;

  const data = response.notification.request.content.data;
  if (data?.type === 'message' && typeof data.conversationId === 'string') {
    onMessageResponse?.();
    router.push({
      pathname: '/chat/[id]',
      params: { id: data.conversationId },
    });
    void Notifications.clearLastNotificationResponseAsync();
  }
}
