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

let currentNotificationRoute = '';
let lastHandledNotificationResponseId = '';

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

export function setupNotificationResponses() {
  const notificationSubscription = Notifications.addNotificationResponseReceivedListener(
    handleNotificationResponse,
  );
  void Notifications.getLastNotificationResponseAsync().then((response) => {
    if (response) {
      handleNotificationResponse(response);
    }
  });

  return () => {
    notificationSubscription.remove();
  };
}

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
    void Notifications.clearLastNotificationResponseAsync();
  }
}
