import Ionicons from '@expo/vector-icons/Ionicons';
import {
  AudioSession,
  isTrackReference,
  LiveKitRoom,
  useLocalParticipant,
  useTracks,
  VideoTrack,
} from '@livekit/react-native';
import { endCall, joinCall, type CallRoomRecord } from '@infchat/pocketbase';
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
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { getDeviceId } from './device-id';
import { pb } from './pocketbase';

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
  joinCallRoom: (callRoomId: string) => Promise<void>;
  minimizeCall: () => void;
};

const CallSessionContext = createContext<CallSessionContextValue | null>(null);

export function CallSessionProvider({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const pathnameRef = useRef(pathname);
  const didRequestEndRef = useRef(false);
  const [activeSession, setActiveSession] = useState<ActiveCallSession | null>(null);
  const [errorMessage, setErrorMessage] = useState('');
  const [isJoining, setIsJoining] = useState(false);

  pathnameRef.current = pathname;

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
        return;
      }

      if (activeSession?.callRoom.id === normalizedCallRoomId) {
        return;
      }

      setIsJoining(true);
      setErrorMessage('');

      try {
        const deviceId = await getDeviceId();
        const nextSession = await joinCall(pb, normalizedCallRoomId, deviceId);
        didRequestEndRef.current = false;
        setActiveSession(nextSession);
      } catch {
        setErrorMessage('Could not join this call.');
      } finally {
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

    try {
      await endCall(pb, activeSession.callRoom.id);
    } catch {
      // Local teardown is still safest when the network drops during hangup.
    }

    setActiveSession(null);
    dismissCallRoute();
  }, [activeSession, dismissCallRoute]);

  const minimizeCall = useCallback(() => {
    dismissCallRoute();
  }, [dismissCallRoute]);

  useEffect(() => {
    if (!activeSession) {
      return;
    }

    let isMounted = true;

    void AudioSession.startAudioSession();

    pb.collection('call_rooms')
      .subscribe(activeSession.callRoom.id, (event) => {
        if (!isMounted || event.record?.status !== 'ended') {
          return;
        }

        didRequestEndRef.current = true;
        setActiveSession(null);
        dismissCallRoute();
      })
      .catch(() => {
        // A failed status subscription should not drop an already connected call.
      });

    return () => {
      isMounted = false;
      pb.collection('call_rooms').unsubscribe(activeSession.callRoom.id);
      void AudioSession.stopAudioSession();
    };
  }, [activeSession, dismissCallRoute]);

  const contextValue = useMemo<CallSessionContextValue>(
    () => ({
      activeSession,
      endActiveCall,
      errorMessage,
      isJoining,
      joinCallRoom,
      minimizeCall,
    }),
    [activeSession, endActiveCall, errorMessage, isJoining, joinCallRoom, minimizeCall],
  );

  const content = activeSession ? (
    <LiveKitRoom
      audio
      connect
      onDisconnected={() => {
        if (!didRequestEndRef.current) {
          setActiveSession(null);
          dismissCallRoute();
        }
      }}
      options={{
        adaptiveStream: { pixelDensity: 'screen' },
        dynacast: true,
      }}
      serverUrl={activeSession.livekitUrl}
      token={activeSession.token}
      video={activeSession.callRoom.kind === 'video'}
    >
      <ActiveCallKeepAwake />
      {children}
      {pathname.startsWith('/call/') ? null : (
        <ActiveCallMiniWindow callRoom={activeSession.callRoom} />
      )}
    </LiveKitRoom>
  ) : (
    children
  );

  return <CallSessionContext.Provider value={contextValue}>{content}</CallSessionContext.Provider>;
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
  const { localParticipant } = useLocalParticipant();
  const tracks = useTracks([{ source: Track.Source.Camera, withPlaceholder: true }], {
    onlySubscribed: false,
  });
  const previewTrack =
    tracks.find(
      (trackRef) =>
        isTrackReference(trackRef) && trackRef.participant.identity !== localParticipant.identity,
    ) ?? tracks.find((trackRef) => isTrackReference(trackRef));

  return (
    <Pressable
      className="absolute right-4 z-30 overflow-hidden rounded-[28px] border border-white/10 bg-background/90"
      onPress={() => router.push({ pathname: '/call/[id]', params: { id: callRoom.id } })}
      style={[styles.miniWindow, { bottom: Math.max(insets.bottom, 12) + 92 }]}
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
      <View className="absolute bottom-2 left-2 right-2 flex-row items-center rounded-full bg-background/75 px-3 py-2">
        <View className="mr-2 h-2 w-2 rounded-full bg-emerald-400" />
        <Text className="flex-1 text-xs font-black text-foreground" numberOfLines={1}>
          Tap to return
        </Text>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  miniWindow: {
    height: 174,
    shadowColor: '#000',
    shadowOpacity: 0.28,
    shadowRadius: 24,
    width: 132,
  },
});
