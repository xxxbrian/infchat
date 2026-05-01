import { endCall, type PushEnvironment, registerPushDevice } from '@infchat/pocketbase';
import Constants from 'expo-constants';
import * as Notifications from 'expo-notifications';
import { router } from 'expo-router';
import * as TaskManager from 'expo-task-manager';
import { AppState, Platform } from 'react-native';
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
  status?: string;
  type?: string;
  uuid?: string;
};

const callPushesByUUID = new Map<string, CallPushPayload>();
const endingSystemCallUUIDs = new Set<string>();
const terminalCallUUIDTimeouts = new Map<string, ReturnType<typeof setTimeout>>();
let lastHandledNotificationResponseId = '';

type SystemCallPayload = CallPushPayload & { callUUID: string };

type SystemCallHandlers = {
  onAnswerCall?: (payload: SystemCallPayload) => Promise<void> | void;
  onEndCall?: (payload: SystemCallPayload) => Promise<void> | void;
};

type PendingCallKeepAction = 'answer' | 'end';

const PENDING_CALLKEEP_ACTION_TIMEOUT = 30_000;
const TERMINAL_CALL_UUID_TIMEOUT = 10 * 60_000;
const PUSH_REGISTRATION_RETRY_DELAYS = [1_000, 5_000, 15_000];
const CALL_UPDATE_BACKGROUND_NOTIFICATION_TASK = 'infchat-call-update-background-notification';

export type IOSSystemCallEndReason =
  | 'answered-elsewhere'
  | 'declined-elsewhere'
  | 'local'
  | 'missed'
  | 'remote-ended';

let systemCallHandlers: SystemCallHandlers = {};
let latestVoipToken = '';
const pendingCallKeepActionsByUUID = new Map<
  string,
  { actions: PendingCallKeepAction[]; timeout: ReturnType<typeof setTimeout> }
>();

if (Platform.OS === 'ios' && !TaskManager.isTaskDefined(CALL_UPDATE_BACKGROUND_NOTIFICATION_TASK)) {
  TaskManager.defineTask<Notifications.NotificationTaskPayload>(
    CALL_UPDATE_BACKGROUND_NOTIFICATION_TASK,
    async ({ data, error }) => {
      if (error) {
        return Notifications.BackgroundNotificationTaskResult.Failed;
      }

      return handleCallUpdateNotificationPayload(data)
        ? Notifications.BackgroundNotificationTaskResult.NewData
        : Notifications.BackgroundNotificationTaskResult.NoData;
    },
  );
}

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
    markTerminalCallUUID(callUUID);
    callPushesByUUID.delete(callUUID);
    if (reason === 'local') {
      RNCallKeep.endCall(callUUID);
    } else {
      RNCallKeep.reportEndCallWithUUID(callUUID, toCallKeepEndReason(reason));
    }
    return;
  }
}

function markTerminalCallUUID(callUUID: string) {
  const existingTimeout = terminalCallUUIDTimeouts.get(callUUID);
  if (existingTimeout) {
    clearTimeout(existingTimeout);
  }

  const timeout = setTimeout(() => {
    terminalCallUUIDTimeouts.delete(callUUID);
  }, TERMINAL_CALL_UUID_TIMEOUT);
  terminalCallUUIDTimeouts.set(callUUID, timeout);
}

function isTerminalCallUUID(callUUID: string) {
  return terminalCallUUIDTimeouts.has(callUUID);
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

function queuePendingCallKeepAction(callUUID: string, action: PendingCallKeepAction) {
  const existing = pendingCallKeepActionsByUUID.get(callUUID);
  if (existing) {
    existing.actions.push(action);
    return;
  }

  const timeout = setTimeout(() => {
    const pending = pendingCallKeepActionsByUUID.get(callUUID);
    pendingCallKeepActionsByUUID.delete(callUUID);
    if (pending?.actions.includes('answer')) {
      RNCallKeep.endCall(callUUID);
    }
  }, PENDING_CALLKEEP_ACTION_TIMEOUT);

  pendingCallKeepActionsByUUID.set(callUUID, { actions: [action], timeout });
}

function takePendingCallKeepActions(callUUID: string): PendingCallKeepAction[] {
  const pending = pendingCallKeepActionsByUUID.get(callUUID);
  if (!pending) {
    return [];
  }

  clearTimeout(pending.timeout);
  pendingCallKeepActionsByUUID.delete(callUUID);
  return pending.actions;
}

function clearPendingCallKeepActions(callUUID: string) {
  const pending = pendingCallKeepActionsByUUID.get(callUUID);
  if (!pending) {
    return;
  }

  clearTimeout(pending.timeout);
  pendingCallKeepActionsByUUID.delete(callUUID);
}

function handleCallUpdatePayload(payload: CallPushPayload): boolean {
  if (payload.type !== 'call_update' || !payload.uuid) {
    return false;
  }

  clearPendingCallKeepActions(payload.uuid);
  callPushesByUUID.delete(payload.uuid);
  endingSystemCallUUIDs.add(payload.uuid);
  markTerminalCallUUID(payload.uuid);
  RNCallKeep.reportEndCallWithUUID(
    payload.uuid,
    toCallKeepEndReason(systemCallEndReasonForStatus(payload.status)),
  );

  return true;
}

function handleCallUpdateNotificationPayload(data: unknown): boolean {
  const payload = callPushPayloadFromNotificationData(data);
  if (!payload) {
    return false;
  }

  return handleCallUpdatePayload(payload);
}

function callPushPayloadFromNotificationData(data: unknown): CallPushPayload | null {
  const record = asRecord(data);
  if (!record) {
    return null;
  }

  if (typeof record.dataString === 'string') {
    const parsedPayload = parseCallPushPayloadString(record.dataString);
    if (parsedPayload) {
      return parsedPayload;
    }
  }

  const type = stringValue(record.type);
  const uuid = stringValue(record.uuid);
  if (type || uuid) {
    const kind = stringValue(record.kind);
    return {
      callerName: stringValue(record.callerName),
      callRoomId: stringValue(record.callRoomId),
      conversationId: stringValue(record.conversationId),
      handle: stringValue(record.handle),
      kind: kind === 'video' || kind === 'voice' ? kind : undefined,
      status: stringValue(record.status),
      type,
      uuid,
    };
  }

  return (
    callPushPayloadFromNotificationData(record.data) ??
    callPushPayloadFromNotificationData(record.notification) ??
    callPushPayloadFromNotificationData(record.request) ??
    callPushPayloadFromNotificationData(record.content)
  );
}

function parseCallPushPayloadString(value: string): CallPushPayload | null {
  try {
    return callPushPayloadFromNotificationData(JSON.parse(value));
  } catch {
    return null;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }

  return value as Record<string, unknown>;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function systemCallEndReasonForStatus(
  status: string | undefined,
): Exclude<IOSSystemCallEndReason, 'local'> {
  switch (status) {
    case 'active':
      return 'answered-elsewhere';
    case 'declined':
      return 'declined-elsewhere';
    case 'missed':
      return 'missed';
    default:
      return 'remote-ended';
  }
}

export function setupNotificationPresentation() {
  Notifications.setNotificationHandler({
    handleNotification: async (notification) => {
      const data = notification.request.content.data;
      const isMessageNotification = data?.type === 'message';
      const isCallUpdateNotification = data?.type === 'call_update';
      const shouldPresent = !isMessageNotification && !isCallUpdateNotification;

      return {
        shouldPlaySound: shouldPresent,
        shouldSetBadge: true,
        shouldShowAlert: shouldPresent,
        shouldShowBanner: shouldPresent,
        shouldShowList: shouldPresent,
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

export function setupCallUpdateBackgroundNotifications() {
  if (Platform.OS !== 'ios') {
    return;
  }

  void Notifications.registerTaskAsync(CALL_UPDATE_BACKGROUND_NOTIFICATION_TASK).catch(() => {});
}

export async function registerIOSPushDevice(
  appVersion?: string,
  options: { throwOnFailure?: boolean } = {},
) {
  if (Platform.OS !== 'ios' || !pb.authStore.isValid) {
    return false;
  }

  try {
    return await retryPushRegistration(() => registerIOSPushDeviceOnce(appVersion));
  } catch (error) {
    if (options.throwOnFailure) {
      throw error;
    }

    return false;
  }
}

async function registerIOSPushDeviceOnce(appVersion?: string) {
  if (!pb.authStore.isValid) {
    return false;
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
    return false;
  }

  const token = await Notifications.getDevicePushTokenAsync();
  if (token.type !== 'ios' || typeof token.data !== 'string') {
    return false;
  }

  await registerPushDevice(pb, {
    apnsToken: token.data,
    appVersion: appVersion ?? Constants.expoConfig?.version,
    deviceId: await getDeviceId(),
    environment: getPushEnvironment(),
    platform: 'ios',
  });

  return true;
}

export function setupIOSPushRegistrationRecovery(appVersion?: string) {
  if (Platform.OS !== 'ios') {
    return () => {};
  }

  const recoverRegistration = () => {
    void registerIOSPushDevice(appVersion);
    if (latestVoipToken) {
      void registerVoipToken(latestVoipToken, appVersion);
    }
    VoipPushNotification.registerVoipToken();
  };

  const appStateSubscription = AppState.addEventListener('change', (status) => {
    if (status === 'active') {
      recoverRegistration();
    }
  });

  return () => {
    appStateSubscription.remove();
  };
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
      queuePendingCallKeepAction(callUUID, 'answer');
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
    if (endingSystemCallUUIDs.delete(callUUID)) {
      callPushesByUUID.delete(callUUID);
      return;
    }

    if (!payload?.callRoomId) {
      queuePendingCallKeepAction(callUUID, 'end');
      return;
    }

    callPushesByUUID.delete(callUUID);

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
  const notificationSubscription = Notifications.addNotificationReceivedListener((notification) => {
    handleCallUpdateNotificationPayload(notification.request.content.data);
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

  const storeCallPushPayload = (payload: CallPushPayload) => {
    if (handleCallUpdatePayload(payload)) {
      return;
    }

    if (!payload.uuid) {
      return;
    }
    if (isTerminalCallUUID(payload.uuid)) {
      return;
    }

    callPushesByUUID.set(payload.uuid, payload);
    const pendingActions = takePendingCallKeepActions(payload.uuid);
    for (const action of pendingActions) {
      if (action === 'answer') {
        handleAnswerCall(payload.uuid);
      } else {
        handleEndCall(payload.uuid);
      }
    }
  };

  VoipPushNotification.addEventListener('register', (token) => {
    void registerVoipToken(token, Constants.expoConfig?.version);
  });
  VoipPushNotification.addEventListener('notification', (notification) => {
    const payload = notification as CallPushPayload;
    if (payload.uuid) {
      storeCallPushPayload(payload);
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
          storeCallPushPayload(payload);
          VoipPushNotification.onVoipNotificationCompleted(payload.uuid);
        }
      }
    }
  });
  VoipPushNotification.registerVoipToken();

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

async function registerVoipToken(token: string, appVersion?: string) {
  latestVoipToken = token.trim();
  if (!latestVoipToken || !pb.authStore.isValid) {
    return;
  }

  await retryPushRegistration(async () => {
    if (!pb.authStore.isValid) {
      return false;
    }

    await registerPushDevice(pb, {
      appVersion: appVersion ?? Constants.expoConfig?.version,
      deviceId: await getDeviceId(),
      environment: getPushEnvironment(),
      platform: 'ios',
      voipToken: latestVoipToken,
    });

    return true;
  }).catch(() => {});
}

async function retryPushRegistration(task: () => Promise<boolean>) {
  for (let attempt = 0; attempt <= PUSH_REGISTRATION_RETRY_DELAYS.length; attempt += 1) {
    try {
      return await task();
    } catch (error) {
      if (attempt === PUSH_REGISTRATION_RETRY_DELAYS.length) {
        throw error;
      }

      await new Promise((resolve) => setTimeout(resolve, PUSH_REGISTRATION_RETRY_DELAYS[attempt]));
    }
  }
}

export function getPushEnvironment(): PushEnvironment {
  const publicEnv = process.env.EXPO_PUBLIC_APNS_ENV?.trim().toLowerCase();

  if (publicEnv === 'sandbox' || publicEnv === 'production') {
    return publicEnv;
  }

  return __DEV__ ? 'sandbox' : 'production';
}

export const setSystemCallHandlers = setIOSSystemCallHandlers;
export const endSystemCallForCallRoom = endIOSSystemCallForCallRoom;
export const registerPushDeviceForPlatform = registerIOSPushDevice;
export const setupPushRegistrationRecovery = setupIOSPushRegistrationRecovery;
export const setupSystemCalls = setupIOSSystemCalls;

export function getPushProviderLabel() {
  return 'APNs';
}

export function isPushRegistrationSupported() {
  return true;
}
