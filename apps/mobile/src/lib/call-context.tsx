import Ionicons from '@expo/vector-icons/Ionicons';
import {
  AudioSession,
  isTrackReference,
  LiveKitRoom,
  useLocalParticipant,
  useTracks,
  VideoTrack,
} from '@livekit/react-native';
import {
  endCall,
  getCallRoom,
  heartbeatCall,
  joinCall,
  leaveCall,
  type CallRoomRecord,
} from '@infchat/pocketbase';
import { router, usePathname } from 'expo-router';
import { useKeepAwake } from 'expo-keep-awake';
import { Track } from 'livekit-client';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { Animated, PanResponder, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { getDeviceId } from './device-id';
import { pb } from './pocketbase';
import { useAuth } from './auth-context';
import { endIOSSystemCallForCallRoom, setIOSSystemCallHandlers } from './push-notifications';

const MINI_WINDOW_HEIGHT = 174;
const MINI_WINDOW_MARGIN = 16;
const MINI_WINDOW_TAB_BAR_CLEARANCE = 92;
const MINI_WINDOW_WIDTH = 132;
const CALL_HEARTBEAT_INTERVAL = 15_000;

type ActiveCallSession = {
  callRoom: CallRoomRecord;
  livekitUrl: string;
  token: string;
};

type CallSessionContextValue = {
  activeSession: ActiveCallSession | null;
  endActiveCall: () => Promise<void>;
  errorMessage: string;
  isJoining: boolean;
  joinCallRoom: (callRoomId: string) => Promise<boolean>;
  leaveActiveCall: () => Promise<void>;
  minimizeCall: () => void;
};

const CallSessionContext = createContext<CallSessionContextValue | null>(null);

export function CallSessionProvider({ children }: { children: ReactNode }) {
  const { authRecord } = useAuth();
  const pathname = usePathname();
  const pathnameRef = useRef(pathname);
  const blockedAutoJoinCallRoomIdRef = useRef<string | null>(null);
  const didRequestEndRef = useRef(false);
  const deviceIdRef = useRef<string | null>(null);
  const joiningCallRoomIdRef = useRef<string | null>(null);
  const [activeSession, setActiveSession] = useState<ActiveCallSession | null>(null);
  const [errorMessage, setErrorMessage] = useState('');
  const [isJoining, setIsJoining] = useState(false);
  const activeCallRoomId = activeSession?.callRoom.id;

  pathnameRef.current = pathname;

  useEffect(() => {
    const blockedCallRoomId = blockedAutoJoinCallRoomIdRef.current;
    if (blockedCallRoomId && pathname !== `/call/${blockedCallRoomId}`) {
      blockedAutoJoinCallRoomIdRef.current = null;
    }
  }, [pathname]);

  const dismissCallRoute = useCallback(() => {
    if (pathnameRef.current.startsWith('/call/')) {
      router.back();
    }
  }, []);

  const joinCallRoom = useCallback(
    async (callRoomId: string) => {
      const normalizedCallRoomId = callRoomId.trim();
      if (!normalizedCallRoomId) {
        setErrorMessage('Call was not found.');
        return false;
      }

      if (activeSession?.callRoom.id === normalizedCallRoomId) {
        return true;
      }

      if (activeSession) {
        setErrorMessage('Leave your current call before joining another one.');
        return false;
      }

      if (blockedAutoJoinCallRoomIdRef.current === normalizedCallRoomId) {
        return false;
      }

      if (joiningCallRoomIdRef.current === normalizedCallRoomId) {
        return false;
      }

      joiningCallRoomIdRef.current = normalizedCallRoomId;
      setIsJoining(true);
      setErrorMessage('');

      try {
        const deviceId = await getDeviceId();
        deviceIdRef.current = deviceId;
        const nextSession = await joinCall(pb, normalizedCallRoomId, deviceId);
        didRequestEndRef.current = false;
        setActiveSession(nextSession);
        return true;
      } catch {
        setErrorMessage('Could not join this call.');
        return false;
      } finally {
        if (joiningCallRoomIdRef.current === normalizedCallRoomId) {
          joiningCallRoomIdRef.current = null;
        }
        setIsJoining(false);
      }
    },
    [activeSession?.callRoom.id],
  );

  const endActiveCall = useCallback(async () => {
    if (!activeSession || didRequestEndRef.current) {
      return;
    }

    didRequestEndRef.current = true;
    blockedAutoJoinCallRoomIdRef.current = activeSession.callRoom.id;

    try {
      await endCall(pb, activeSession.callRoom.id);
    } catch {
      // Local teardown is still safest when the network drops during hangup.
    }

    setActiveSession(null);
    endIOSSystemCallForCallRoom(activeSession.callRoom.id, 'local');
    dismissCallRoute();
  }, [activeSession, dismissCallRoute]);

  const leaveActiveCall = useCallback(async () => {
    if (!activeSession || didRequestEndRef.current) {
      return;
    }

    didRequestEndRef.current = true;
    blockedAutoJoinCallRoomIdRef.current = activeSession.callRoom.id;

    const deviceId = deviceIdRef.current ?? (await getDeviceId());
    deviceIdRef.current = deviceId;

    if (
      activeSession.callRoom.status === 'ringing' &&
      activeSession.callRoom.created_by === authRecord.id
    ) {
      try {
        await endCall(pb, activeSession.callRoom.id);
      } catch {
        // The local device should still leave if cancel signaling fails.
      }
    } else {
      try {
        await leaveCall(pb, activeSession.callRoom.id, deviceId);
      } catch {
        // Local teardown is still safest when leave signaling fails.
      }
    }

    setActiveSession(null);
    endIOSSystemCallForCallRoom(activeSession.callRoom.id, 'local');
    dismissCallRoute();
  }, [activeSession, authRecord.id, dismissCallRoute]);

  const minimizeCall = useCallback(() => {
    dismissCallRoute();
  }, [dismissCallRoute]);

  useEffect(() => {
    if (!activeCallRoomId) {
      return;
    }

    let isMounted = true;

    void AudioSession.startAudioSession();

    pb.collection('call_rooms')
      .subscribe(activeCallRoomId, (event) => {
        const callRoom = event.record as unknown as CallRoomRecord | undefined;
        if (!isMounted || !callRoom) {
          return;
        }

        if (!isTerminalCallStatus(callRoom.status)) {
          setActiveSession((currentSession) =>
            currentSession?.callRoom.id === callRoom.id
              ? { ...currentSession, callRoom }
              : currentSession,
          );
          return;
        }

        didRequestEndRef.current = true;
        endIOSSystemCallForCallRoom(callRoom.id, systemCallEndReasonForStatus(callRoom.status));
        setActiveSession(null);
        dismissCallRoute();
      })
      .catch(() => {
        // A failed status subscription should not drop an already connected call.
      });

    return () => {
      isMounted = false;
      pb.collection('call_rooms').unsubscribe(activeCallRoomId);
      void AudioSession.stopAudioSession();
    };
  }, [activeCallRoomId, dismissCallRoute]);

  useEffect(() => {
    return setIOSSystemCallHandlers({
      onAnswerCall: async ({ callRoomId }) => {
        if (!callRoomId) {
          return;
        }

        const didJoin = await joinCallRoom(callRoomId);
        if (!didJoin) {
          throw new Error('Could not join this call.');
        }

        router.push({ pathname: '/call/[id]', params: { id: callRoomId } });
      },
      onEndCall: async ({ callRoomId }) => {
        if (!callRoomId) {
          return;
        }

        if (activeSession?.callRoom.id === callRoomId) {
          await leaveActiveCall();
          return;
        }

        try {
          const callRoom = await getCallRoom(pb, callRoomId);
          if (callRoom.status !== 'ringing') {
            return;
          }
        } catch {
          return;
        }

        try {
          await endCall(pb, callRoomId);
        } catch {
          // The system call has already ended locally; backend cleanup can still mark it missed.
        }
      },
    });
  }, [activeSession?.callRoom.id, joinCallRoom, leaveActiveCall]);

  useEffect(() => {
    if (!activeCallRoomId) {
      return;
    }

    let isMounted = true;

    const sendHeartbeat = async () => {
      try {
        const deviceId = deviceIdRef.current ?? (await getDeviceId());
        deviceIdRef.current = deviceId;
        const response = await heartbeatCall(pb, activeCallRoomId, deviceId);
        if (!isMounted) {
          return;
        }

        if (isTerminalCallStatus(response.callRoom.status)) {
          didRequestEndRef.current = true;
          endIOSSystemCallForCallRoom(
            response.callRoom.id,
            systemCallEndReasonForStatus(response.callRoom.status),
          );
          setActiveSession(null);
          dismissCallRoute();
          return;
        }

        setActiveSession((currentSession) =>
          currentSession?.callRoom.id === response.callRoom.id
            ? { ...currentSession, callRoom: response.callRoom }
            : currentSession,
        );
      } catch {
        // Realtime status updates and server stale cleanup handle temporary heartbeat failures.
      }
    };

    void sendHeartbeat();
    const interval = setInterval(sendHeartbeat, CALL_HEARTBEAT_INTERVAL);

    return () => {
      isMounted = false;
      clearInterval(interval);
    };
  }, [activeCallRoomId]);

  const contextValue = useMemo<CallSessionContextValue>(
    () => ({
      activeSession,
      endActiveCall,
      errorMessage,
      isJoining,
      joinCallRoom,
      leaveActiveCall,
      minimizeCall,
    }),
    [
      activeSession,
      endActiveCall,
      errorMessage,
      isJoining,
      joinCallRoom,
      leaveActiveCall,
      minimizeCall,
    ],
  );

  return (
    <CallSessionContext.Provider value={contextValue}>
      <LiveKitRoom
        audio={Boolean(activeSession)}
        connect={Boolean(activeSession)}
        onDisconnected={() => {
          if (!activeSession || didRequestEndRef.current) {
            return;
          }

          const disconnectedCallRoomId = activeSession.callRoom.id;
          void getDeviceId().then((deviceId) => leaveCall(pb, disconnectedCallRoomId, deviceId));
          setActiveSession(null);
          dismissCallRoute();
        }}
        options={{
          adaptiveStream: { pixelDensity: 'screen' },
          dynacast: true,
        }}
        serverUrl={activeSession?.livekitUrl}
        token={activeSession?.token}
        video={activeSession?.callRoom.kind === 'video'}
      >
        {activeSession ? <ActiveCallKeepAwake /> : null}
        {children}
        {activeSession && !pathname.startsWith('/call/') ? (
          <ActiveCallMiniWindow callRoom={activeSession.callRoom} />
        ) : null}
      </LiveKitRoom>
    </CallSessionContext.Provider>
  );
}

function ActiveCallKeepAwake() {
  useKeepAwake();

  return null;
}

export function useCallSession(): CallSessionContextValue {
  const value = useContext(CallSessionContext);
  if (!value) {
    throw new Error('useCallSession must be used within CallSessionProvider');
  }

  return value;
}

function ActiveCallMiniWindow({ callRoom }: { callRoom: CallRoomRecord }) {
  const insets = useSafeAreaInsets();
  const { height: windowHeight, width: windowWidth } = useWindowDimensions();
  const { localParticipant } = useLocalParticipant();
  const position = useRef(new Animated.ValueXY({ x: 0, y: 0 })).current;
  const currentPosition = useRef({ x: 0, y: 0 });
  const dragStartPosition = useRef({ x: 0, y: 0 });
  const didDrag = useRef(false);
  const minX = MINI_WINDOW_MARGIN;
  const maxX = Math.max(minX, windowWidth - MINI_WINDOW_WIDTH - MINI_WINDOW_MARGIN);
  const minY = Math.max(insets.top + MINI_WINDOW_MARGIN, MINI_WINDOW_MARGIN);
  const maxY = Math.max(
    minY,
    windowHeight - Math.max(insets.bottom, 12) - MINI_WINDOW_TAB_BAR_CLEARANCE - MINI_WINDOW_HEIGHT,
  );
  const bounds = useRef({ maxX, maxY, minX, minY });
  const tracks = useTracks([{ source: Track.Source.Camera, withPlaceholder: true }], {
    onlySubscribed: false,
  });
  const previewTrack =
    tracks.find(
      (trackRef) =>
        isTrackReference(trackRef) && trackRef.participant.identity !== localParticipant.identity,
    ) ?? tracks.find((trackRef) => isTrackReference(trackRef));

  bounds.current = { maxX, maxY, minX, minY };

  useEffect(() => {
    const nextPosition = {
      x: clamp(currentPosition.current.x || maxX, minX, maxX),
      y: clamp(currentPosition.current.y || maxY, minY, maxY),
    };
    currentPosition.current = nextPosition;
    position.setValue(nextPosition);
  }, [maxX, maxY, minX, minY, position]);

  const panResponder = useRef(
    PanResponder.create({
      onMoveShouldSetPanResponder: (_event, gestureState) =>
        Math.abs(gestureState.dx) > 5 || Math.abs(gestureState.dy) > 5,
      onPanResponderGrant: () => {
        didDrag.current = false;
        dragStartPosition.current = currentPosition.current;
      },
      onPanResponderMove: (_event, gestureState) => {
        didDrag.current = true;
        const nextPosition = {
          x: clamp(
            dragStartPosition.current.x + gestureState.dx,
            bounds.current.minX,
            bounds.current.maxX,
          ),
          y: clamp(
            dragStartPosition.current.y + gestureState.dy,
            bounds.current.minY,
            bounds.current.maxY,
          ),
        };
        currentPosition.current = nextPosition;
        position.setValue(nextPosition);
      },
      onPanResponderRelease: (_event, gestureState) => {
        if (!didDrag.current) {
          router.push({ pathname: '/call/[id]', params: { id: callRoom.id } });
          return;
        }

        const projectedX = currentPosition.current.x + gestureState.vx * 90;
        const projectedY = currentPosition.current.y + gestureState.vy * 90;
        const snapX =
          projectedX + MINI_WINDOW_WIDTH / 2 < (bounds.current.minX + bounds.current.maxX) / 2
            ? bounds.current.minX
            : bounds.current.maxX;
        const snapY =
          projectedY + MINI_WINDOW_HEIGHT / 2 < (bounds.current.minY + bounds.current.maxY) / 2
            ? bounds.current.minY
            : bounds.current.maxY;
        const nextPosition = { x: snapX, y: snapY };
        currentPosition.current = nextPosition;
        Animated.spring(position, {
          damping: 20,
          mass: 0.8,
          stiffness: 210,
          toValue: nextPosition,
          useNativeDriver: false,
        }).start();
      },
      onPanResponderTerminate: () => {
        const nextPosition = {
          x:
            currentPosition.current.x + MINI_WINDOW_WIDTH / 2 <
            (bounds.current.minX + bounds.current.maxX) / 2
              ? bounds.current.minX
              : bounds.current.maxX,
          y:
            currentPosition.current.y + MINI_WINDOW_HEIGHT / 2 <
            (bounds.current.minY + bounds.current.maxY) / 2
              ? bounds.current.minY
              : bounds.current.maxY,
        };
        currentPosition.current = nextPosition;
        position.setValue(nextPosition);
      },
      onStartShouldSetPanResponder: () => true,
    }),
  ).current;

  return (
    <Animated.View
      className="absolute z-30 overflow-hidden rounded-[28px] border border-white/10 bg-background/90"
      style={[
        styles.miniWindow,
        { transform: [{ translateX: position.x }, { translateY: position.y }] },
      ]}
      {...panResponder.panHandlers}
    >
      {previewTrack && isTrackReference(previewTrack) ? (
        <VideoTrack
          mirror={previewTrack.participant.isLocal && previewTrack.source === Track.Source.Camera}
          objectFit="cover"
          style={StyleSheet.absoluteFillObject}
          trackRef={previewTrack}
        />
      ) : (
        <View className="flex-1 items-center justify-center bg-[#101624]">
          <Ionicons
            color="#f8fafc"
            name={callRoom.kind === 'video' ? 'videocam' : 'call'}
            size={28}
          />
        </View>
      )}
      <View className="absolute bottom-2 left-2 right-2 flex-row items-center justify-center rounded-full bg-background/75 px-2.5 py-2">
        <View className="mr-1.5 h-2 w-2 rounded-full bg-emerald-400" />
        <Text className="text-xs font-black text-foreground" numberOfLines={1}>
          Back to call
        </Text>
      </View>
    </Animated.View>
  );
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), maximum);
}

function isTerminalCallStatus(status: CallRoomRecord['status']): boolean {
  return (
    status === 'ended' || status === 'missed' || status === 'declined' || status === 'canceled'
  );
}

function systemCallEndReasonForStatus(status: CallRoomRecord['status']) {
  switch (status) {
    case 'declined':
      return 'declined-elsewhere' as const;
    case 'missed':
      return 'missed' as const;
    default:
      return 'remote-ended' as const;
  }
}

const styles = StyleSheet.create({
  miniWindow: {
    height: MINI_WINDOW_HEIGHT,
    shadowColor: '#000',
    shadowOpacity: 0.28,
    shadowRadius: 24,
    width: MINI_WINDOW_WIDTH,
  },
});
