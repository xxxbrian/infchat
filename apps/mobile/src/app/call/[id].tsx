import Ionicons from '@expo/vector-icons/Ionicons';
import {
  AudioSession,
  isTrackReference,
  LiveKitRoom,
  useConnectionState,
  useLocalParticipant,
  useRemoteParticipants,
  useRoomContext,
  useTracks,
  VideoTrack,
} from '@livekit/react-native';
import { endCall, joinCall, type CallRoomRecord } from '@infchat/pocketbase';
import { router, useLocalSearchParams } from 'expo-router';
import { ConnectionState, Room, Track } from 'livekit-client';
import { useEffect, useRef, useState } from 'react';
import {
  Alert,
  Animated,
  Easing,
  Pressable,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
  type ViewStyle,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { getDeviceId } from '../../lib/device-id';
import { pb } from '../../lib/pocketbase';

type CallSession = {
  callRoom: CallRoomRecord;
  livekitUrl: string;
  token: string;
};

const CONTROL_SIZE = 58;
const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

export default function CallScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const callRoomId = id ?? '';
  const insets = useSafeAreaInsets();
  const entrance = useRef(new Animated.Value(0)).current;
  const didLeaveRef = useRef(false);
  const [session, setSession] = useState<CallSession | null>(null);
  const [errorMessage, setErrorMessage] = useState('');

  useEffect(() => {
    Animated.timing(entrance, {
      toValue: 1,
      duration: 360,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    }).start();
  }, [entrance]);

  useEffect(() => {
    if (!callRoomId) {
      setErrorMessage('Call was not found.');
      return;
    }

    let isMounted = true;

    getDeviceId()
      .then((deviceId) => joinCall(pb, callRoomId, deviceId))
      .then((nextSession) => {
        if (isMounted) {
          setSession(nextSession);
        }
      })
      .catch(() => {
        if (isMounted) {
          setErrorMessage('Could not join this call.');
        }
      });

    return () => {
      isMounted = false;
    };
  }, [callRoomId]);

  useEffect(() => {
    if (!session) {
      return;
    }

    let isMounted = true;

    void AudioSession.startAudioSession();

    pb.collection('call_rooms')
      .subscribe(session.callRoom.id, (event) => {
        if (!isMounted || event.record?.status !== 'ended') {
          return;
        }

        didLeaveRef.current = true;
        router.back();
      })
      .catch(() => {
        // A failed status subscription should not drop an already connected call.
      });

    return () => {
      isMounted = false;
      pb.collection('call_rooms').unsubscribe(session.callRoom.id);
      void AudioSession.stopAudioSession();
    };
  }, [session]);

  const leaveCall = async () => {
    if (didLeaveRef.current) {
      return;
    }

    didLeaveRef.current = true;

    try {
      if (session) {
        await endCall(pb, session.callRoom.id);
      }
    } catch {
      // Navigating away is still the safest local fallback when the network drops mid-call.
    }

    router.back();
  };

  const contentOpacity = entrance;
  const contentTranslateY = entrance.interpolate({
    inputRange: [0, 1],
    outputRange: [18, 0],
  });

  return (
    <View className="flex-1 overflow-hidden bg-background">
      <View className="absolute -left-24 top-16 h-72 w-72 rounded-full bg-primary/20" />
      <View className="absolute -right-20 bottom-20 h-64 w-64 rounded-full bg-cyan-400/10" />
      <Animated.View
        className="flex-1 px-4"
        style={{
          opacity: contentOpacity,
          paddingBottom: Math.max(insets.bottom, 18),
          paddingTop: insets.top + 12,
          transform: [{ translateY: contentTranslateY }],
        }}
      >
        {session ? (
          <LiveKitRoom
            audio
            connect
            onDisconnected={() => {
              if (!didLeaveRef.current) {
                didLeaveRef.current = true;
                router.back();
              }
            }}
            onError={() => setErrorMessage('The call connection failed.')}
            options={{
              adaptiveStream: { pixelDensity: 'screen' },
              dynacast: true,
            }}
            serverUrl={session.livekitUrl}
            token={session.token}
            video={session.callRoom.kind === 'video'}
          >
            <CallRoomView callRoom={session.callRoom} onHangUp={leaveCall} />
          </LiveKitRoom>
        ) : (
          <CallLoadingState errorMessage={errorMessage} onClose={leaveCall} />
        )}
      </Animated.View>
    </View>
  );
}

function CallRoomView({ callRoom, onHangUp }: { callRoom: CallRoomRecord; onHangUp: () => void }) {
  const { height: windowHeight } = useWindowDimensions();
  const room = useRoomContext();
  const connectionState = useConnectionState();
  const remoteParticipants = useRemoteParticipants();
  const { cameraTrack, isCameraEnabled, isMicrophoneEnabled, localParticipant } =
    useLocalParticipant();
  const videoTracks = useTracks([{ source: Track.Source.Camera, withPlaceholder: true }], {
    onlySubscribed: false,
  });
  const remoteVideoTrack = videoTracks.find(
    (trackRef) =>
      isTrackReference(trackRef) && trackRef.participant.identity !== localParticipant.identity,
  );
  const localVideoTrack = cameraTrack
    ? {
        participant: localParticipant,
        publication: cameraTrack,
        source: Track.Source.Camera,
      }
    : undefined;
  const hasRemoteVideo =
    callRoom.kind === 'video' && remoteVideoTrack && isTrackReference(remoteVideoTrack);
  const statusLabel = getCallStatusLabel(connectionState, remoteParticipants.length, callRoom.kind);
  const title = callRoom.kind === 'video' ? 'Video call' : 'Voice call';

  const toggleMicrophone = async () => {
    try {
      await localParticipant.setMicrophoneEnabled(!isMicrophoneEnabled);
    } catch {
      Alert.alert('Microphone unavailable', 'Could not change microphone state.');
    }
  };

  const toggleCamera = async () => {
    try {
      await localParticipant.setCameraEnabled(!isCameraEnabled);
    } catch {
      Alert.alert('Camera unavailable', 'Could not change camera state.');
    }
  };

  const switchCamera = async () => {
    try {
      const devices = await Room.getLocalDevices('videoinput', true);
      const activeDeviceId = room.getActiveDevice('videoinput');
      const nextDevice = devices.find((device) => device.deviceId !== activeDeviceId) ?? devices[0];
      if (nextDevice) {
        await room.switchActiveDevice('videoinput', nextDevice.deviceId);
      }
    } catch {
      Alert.alert('Camera unavailable', 'Could not switch cameras.');
    }
  };

  return (
    <View className="flex-1">
      <View className="flex-row items-center justify-between">
        <View>
          <Text className="text-[32px] font-bold tracking-[-1.2px] text-foreground">{title}</Text>
          <Text className="mt-1 text-sm font-semibold text-muted-foreground">{statusLabel}</Text>
        </View>
        <View className="h-11 w-11 items-center justify-center rounded-full border border-border/70 bg-muted/80">
          <Ionicons
            color="#f8fafc"
            name={callRoom.kind === 'video' ? 'videocam' : 'call'}
            size={20}
          />
        </View>
      </View>

      <View className="flex-1 justify-center py-5">
        <View
          className="overflow-hidden rounded-[34px] border border-border/70 bg-muted/70"
          style={[styles.stage, { minHeight: Math.min(windowHeight * 0.62, 560) }]}
        >
          {hasRemoteVideo ? (
            <VideoTrack trackRef={remoteVideoTrack} style={StyleSheet.absoluteFillObject} />
          ) : (
            <View className="flex-1 items-center justify-center px-8">
              <PulsingCallGlyph kind={callRoom.kind} />
              <Text className="mt-6 text-center text-2xl font-bold text-foreground">
                {remoteParticipants.length ? 'Connected' : 'Ringing'}
              </Text>
              <Text className="mt-2 text-center text-base font-medium text-muted-foreground">
                {callRoom.kind === 'video'
                  ? 'Waiting for the other camera to join.'
                  : 'Audio is live when your friend joins.'}
              </Text>
            </View>
          )}

          {callRoom.kind === 'video' && localVideoTrack ? (
            <View className="absolute bottom-4 right-4 h-40 w-28 overflow-hidden rounded-[22px] border border-border bg-background">
              <VideoTrack mirror style={StyleSheet.absoluteFillObject} trackRef={localVideoTrack} />
            </View>
          ) : null}
        </View>
      </View>

      <View
        className="rounded-[32px] border border-border/70 bg-background/95 p-3"
        style={styles.controls}
      >
        <View className="flex-row items-center justify-center gap-3">
          <CallControl
            icon={isMicrophoneEnabled ? 'mic' : 'mic-off'}
            isActive={isMicrophoneEnabled}
            label={isMicrophoneEnabled ? 'Mute' : 'Unmute'}
            onPress={toggleMicrophone}
          />
          {callRoom.kind === 'video' ? (
            <CallControl
              icon={isCameraEnabled ? 'videocam' : 'videocam-off'}
              isActive={isCameraEnabled}
              label={isCameraEnabled ? 'Camera' : 'Camera off'}
              onPress={toggleCamera}
            />
          ) : null}
          {callRoom.kind === 'video' ? (
            <CallControl icon="camera-reverse" isActive label="Flip" onPress={switchCamera} />
          ) : null}
          <CallControl icon="call" isDanger label="End" onPress={onHangUp} />
        </View>
      </View>
    </View>
  );
}

function CallLoadingState({
  errorMessage,
  onClose,
}: {
  errorMessage: string;
  onClose: () => void;
}) {
  return (
    <View className="flex-1 items-center justify-center px-8">
      <PulsingCallGlyph kind="voice" />
      <Text className="mt-6 text-center text-2xl font-bold text-foreground">
        {errorMessage || 'Joining call'}
      </Text>
      <Text className="mt-2 text-center text-base font-medium text-muted-foreground">
        {errorMessage ? 'Check your connection and try again.' : 'Setting up secure audio.'}
      </Text>
      {errorMessage ? (
        <Pressable className="mt-6 rounded-full bg-foreground px-6 py-3" onPress={onClose}>
          <Text className="font-bold text-background">Close</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

function PulsingCallGlyph({ kind }: { kind: CallRoomRecord['kind'] }) {
  const pulse = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, {
          toValue: 1,
          duration: 1200,
          easing: Easing.out(Easing.cubic),
          useNativeDriver: true,
        }),
        Animated.timing(pulse, {
          toValue: 0,
          duration: 0,
          useNativeDriver: true,
        }),
      ]),
    ).start();
  }, [pulse]);

  const ringScale = pulse.interpolate({
    inputRange: [0, 1],
    outputRange: [0.72, 1.55],
  });
  const ringOpacity = pulse.interpolate({
    inputRange: [0, 1],
    outputRange: [0.36, 0],
  });

  return (
    <View className="h-32 w-32 items-center justify-center">
      <Animated.View
        className="absolute h-32 w-32 rounded-full border border-foreground/50"
        style={{ opacity: ringOpacity, transform: [{ scale: ringScale }] }}
      />
      <View className="h-24 w-24 items-center justify-center rounded-full bg-foreground">
        <Ionicons color="#080b12" name={kind === 'video' ? 'videocam' : 'call'} size={34} />
      </View>
    </View>
  );
}

function CallControl({
  icon,
  isActive,
  isDanger,
  label,
  onPress,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  isActive?: boolean;
  isDanger?: boolean;
  label: string;
  onPress: () => void;
}) {
  const scale = useRef(new Animated.Value(1)).current;
  const backgroundClass = isDanger ? 'bg-red-500' : isActive ? 'bg-foreground' : 'bg-muted';
  const iconColor = isDanger || isActive ? '#080b12' : '#f8fafc';

  return (
    <View className="items-center">
      <AnimatedPressable
        className={`items-center justify-center rounded-full ${backgroundClass}`}
        onPress={onPress}
        onPressIn={() => {
          Animated.spring(scale, {
            toValue: 0.92,
            useNativeDriver: true,
          }).start();
        }}
        onPressOut={() => {
          Animated.spring(scale, {
            friction: 5,
            toValue: 1,
            useNativeDriver: true,
          }).start();
        }}
        style={{
          height: CONTROL_SIZE,
          transform: [{ scale }],
          width: CONTROL_SIZE,
        }}
      >
        <Ionicons color={iconColor} name={icon} size={23} />
      </AnimatedPressable>
      <Text className="mt-2 text-xs font-bold text-muted-foreground">{label}</Text>
    </View>
  );
}

function getCallStatusLabel(
  connectionState: ConnectionState,
  remoteParticipantCount: number,
  kind: CallRoomRecord['kind'],
): string {
  if (connectionState === ConnectionState.Connected) {
    return remoteParticipantCount > 0
      ? 'Connected'
      : `Waiting for ${kind === 'video' ? 'video' : 'audio'}`;
  }

  if (connectionState === ConnectionState.Reconnecting) {
    return 'Reconnecting';
  }

  if (connectionState === ConnectionState.Disconnected) {
    return 'Disconnected';
  }

  return 'Connecting';
}

const styles = StyleSheet.create({
  controls: {
    shadowColor: '#000',
    shadowOpacity: 0.22,
    shadowRadius: 28,
  } as ViewStyle,
  stage: {
    borderCurve: 'continuous',
  } as ViewStyle,
});
