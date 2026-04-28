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
  useVisualStableUpdate,
  VideoTrack,
  type TrackReferenceOrPlaceholder,
} from '@livekit/react-native';
import { endCall, joinCall, type CallRoomRecord } from '@infchat/pocketbase';
import { router, useLocalSearchParams } from 'expo-router';
import { ConnectionState, Room, Track, type Participant } from 'livekit-client';
import { useEffect, useRef, useState } from 'react';
import {
  Alert,
  Animated,
  Easing,
  Pressable,
  ScrollView,
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

type CallLayoutMode = 'focus' | 'gallery';

type ParticipantMetadata = {
  deviceId?: string;
  userId?: string;
};

const CONTROL_SIZE = 56;
const CONTROL_BAR_HEIGHT = 124;
const FILMSTRIP_GAP = 12;
const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

export default function CallScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const callRoomId = id ?? '';
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
      <Animated.View
        className="flex-1"
        style={{
          opacity: contentOpacity,
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
  const { height: windowHeight, width: windowWidth } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const room = useRoomContext();
  const connectionState = useConnectionState();
  const remoteParticipants = useRemoteParticipants();
  const { isCameraEnabled, isMicrophoneEnabled, localParticipant } = useLocalParticipant();
  const [layoutMode, setLayoutMode] = useState<CallLayoutMode>('focus');
  const [selectedTrackKey, setSelectedTrackKey] = useState<string | null>(null);
  const tracks = useTracks(
    [
      { source: Track.Source.ScreenShare, withPlaceholder: false },
      { source: Track.Source.Camera, withPlaceholder: true },
    ],
    { onlySubscribed: false },
  );
  const stableTracks = useVisualStableUpdate(tracks, 3);
  const sortedTracks = sortTrackTiles(stableTracks, localParticipant.identity);
  const mainTrack = getMainTrack(sortedTracks, selectedTrackKey, localParticipant.identity);
  const mainTrackKey = mainTrack ? getTrackKey(mainTrack) : '';
  const filmstripTracks = sortedTracks.filter((trackRef) => getTrackKey(trackRef) !== mainTrackKey);
  const participantCount = sortedTracks.length;
  const statusLabel = getCallStatusLabel(connectionState, remoteParticipants.length, callRoom.kind);
  const title = callRoom.kind === 'video' ? 'Video call' : 'Voice call';
  const controlsBottom = Math.max(insets.bottom, 14);
  const filmstripBottom = controlsBottom + CONTROL_BAR_HEIGHT + FILMSTRIP_GAP;

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
    <View className="flex-1 bg-background">
      <View className="absolute inset-0 bg-[#05070d]" />
      <CallHeader
        layoutMode={layoutMode}
        onChangeLayout={() => setLayoutMode(layoutMode === 'focus' ? 'gallery' : 'focus')}
        participantCount={participantCount}
        statusLabel={statusLabel}
        style={{ top: insets.top + 12 }}
        title={title}
      />

      {callRoom.kind === 'video' ? (
        layoutMode === 'gallery' ? (
          <GalleryStage
            controlsBottom={controlsBottom}
            selectedTrackKey={selectedTrackKey}
            tracks={sortedTracks}
            windowHeight={windowHeight}
            windowWidth={windowWidth}
            onSelect={(trackRef) => {
              setSelectedTrackKey(getTrackKey(trackRef));
              setLayoutMode('focus');
            }}
          />
        ) : (
          <FocusStage
            filmstripBottom={filmstripBottom}
            filmstripTracks={filmstripTracks}
            mainTrack={mainTrack}
            selectedTrackKey={selectedTrackKey}
            onSelect={(trackRef) => setSelectedTrackKey(getTrackKey(trackRef))}
          />
        )
      ) : (
        <VoiceStage tracks={sortedTracks} />
      )}

      <View
        className="absolute left-4 right-4 rounded-[30px] border border-white/10 bg-background/90 p-3"
        style={[styles.controls, { bottom: controlsBottom }]}
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

function CallHeader({
  layoutMode,
  onChangeLayout,
  participantCount,
  statusLabel,
  style,
  title,
}: {
  layoutMode: CallLayoutMode;
  onChangeLayout: () => void;
  participantCount: number;
  statusLabel: string;
  style: ViewStyle;
  title: string;
  onMinimize?: () => void;
}) {
  return (
    <View
      className="absolute left-4 right-4 z-20 flex-row items-center justify-between"
      style={style}
    >
      <View>
        <Text className="text-[24px] font-bold tracking-[-0.6px] text-foreground">{title}</Text>
        <Text className="mt-1 text-sm font-semibold text-white/60">
          {statusLabel} · {participantCount}{' '}
          {participantCount === 1 ? 'participant' : 'participants'}
        </Text>
      </View>
      <View className="flex-row items-center gap-2">
        <Pressable
          className="h-11 w-11 items-center justify-center rounded-full border border-white/10 bg-white/10"
          onPress={onChangeLayout}
        >
          <Ionicons color="#f8fafc" name={layoutMode === 'focus' ? 'grid' : 'expand'} size={19} />
        </Pressable>
      </View>
    </View>
  );
}

function FocusStage({
  filmstripBottom,
  filmstripTracks,
  mainTrack,
  onSelect,
  selectedTrackKey,
}: {
  filmstripBottom: number;
  filmstripTracks: TrackReferenceOrPlaceholder[];
  mainTrack: TrackReferenceOrPlaceholder | undefined;
  selectedTrackKey: string | null;
  onSelect: (trackRef: TrackReferenceOrPlaceholder) => void;
}) {
  return (
    <View className="flex-1">
      {mainTrack ? (
        <ParticipantTile hideFooter isLarge trackRef={mainTrack} />
      ) : (
        <EmptyCallStage message="Waiting for participants" />
      )}

      {filmstripTracks.length ? (
        <View className="absolute left-0 right-0 z-10" style={{ bottom: filmstripBottom }}>
          <ScrollView
            horizontal
            contentContainerStyle={styles.filmstripContent}
            showsHorizontalScrollIndicator={false}
          >
            {filmstripTracks.map((trackRef) => {
              const trackKey = getTrackKey(trackRef);

              return (
                <ParticipantTile
                  containerStyle={styles.filmstripTile}
                  isSelected={selectedTrackKey === trackKey}
                  key={trackKey}
                  trackRef={trackRef}
                  onPress={() => onSelect(trackRef)}
                />
              );
            })}
          </ScrollView>
        </View>
      ) : null}
    </View>
  );
}

function GalleryStage({
  controlsBottom,
  onSelect,
  selectedTrackKey,
  tracks,
  windowHeight,
  windowWidth,
}: {
  controlsBottom: number;
  onSelect: (trackRef: TrackReferenceOrPlaceholder) => void;
  selectedTrackKey: string | null;
  tracks: TrackReferenceOrPlaceholder[];
  windowHeight: number;
  windowWidth: number;
}) {
  const columns = getGalleryColumns(tracks.length, windowWidth);
  const rows = Math.ceil(tracks.length / columns);
  const gridTop = 116;
  const gridBottom = controlsBottom + CONTROL_BAR_HEIGHT + 18;
  const gridHeight = Math.max(220, windowHeight - gridTop - gridBottom);
  const tileWidth = (windowWidth - 32 - 10 * (columns - 1)) / columns;
  const tileHeight = Math.max(132, (gridHeight - 10 * (rows - 1)) / rows);

  if (!tracks.length) {
    return <EmptyCallStage message="Waiting for participants" />;
  }

  return (
    <View
      className="flex-1 flex-row flex-wrap content-center justify-center px-4"
      style={{ gap: 10, paddingBottom: gridBottom, paddingTop: gridTop }}
    >
      {tracks.map((trackRef) => {
        const trackKey = getTrackKey(trackRef);

        return (
          <ParticipantTile
            containerStyle={{
              height: tileHeight,
              width: tileWidth,
            }}
            isSelected={selectedTrackKey === trackKey}
            key={trackKey}
            trackRef={trackRef}
            onPress={() => onSelect(trackRef)}
          />
        );
      })}
    </View>
  );
}

function VoiceStage({ tracks }: { tracks: TrackReferenceOrPlaceholder[] }) {
  return (
    <View className="flex-1 px-4 pb-36 pt-28">
      <View className="flex-1 justify-center">
        <View className="flex-row flex-wrap justify-center gap-3">
          {tracks.map((trackRef) => {
            const participant = trackRef.participant;
            if (!participant) {
              return null;
            }

            return <VoiceParticipantCard key={getTrackKey(trackRef)} participant={participant} />;
          })}
        </View>
      </View>
    </View>
  );
}

function ParticipantTile({
  containerStyle,
  hideFooter,
  isLarge,
  isSelected,
  onPress,
  trackRef,
}: {
  containerStyle?: ViewStyle;
  hideFooter?: boolean;
  isLarge?: boolean;
  isSelected?: boolean;
  onPress?: () => void;
  trackRef: TrackReferenceOrPlaceholder;
}) {
  const participant = trackRef.participant;
  const hasVideo = isTrackReference(trackRef);
  const label = participant ? getParticipantLabel(participant) : 'Joining';
  const isScreenShare = trackRef.source === Track.Source.ScreenShare;
  const isMicEnabled = participant?.isMicrophoneEnabled ?? true;
  const borderClass = isSelected ? 'border-foreground/90' : 'border-white/10';

  return (
    <Pressable
      className={`overflow-hidden rounded-[30px] border bg-[#121723] ${borderClass}`}
      disabled={!onPress}
      onPress={onPress}
      style={[isLarge ? styles.mainTile : undefined, containerStyle]}
    >
      {hasVideo ? (
        <VideoTrack
          mirror={trackRef.participant?.isLocal && trackRef.source === Track.Source.Camera}
          objectFit="cover"
          style={StyleSheet.absoluteFillObject}
          trackRef={trackRef}
        />
      ) : (
        <ParticipantPlaceholder isLarge={isLarge} participant={participant} />
      )}
      <View className="absolute left-3 right-3 top-3 flex-row items-center justify-between">
        {participant?.isSpeaking ? (
          <View className="rounded-full bg-emerald-400 px-2.5 py-1">
            <Text className="text-[11px] font-black uppercase tracking-[0.8px] text-background">
              Speaking
            </Text>
          </View>
        ) : (
          <View />
        )}
        {isScreenShare ? (
          <View className="rounded-full bg-background/75 px-2.5 py-1">
            <Text className="text-[11px] font-black uppercase tracking-[0.8px] text-foreground">
              Screen
            </Text>
          </View>
        ) : null}
      </View>
      {hideFooter ? null : (
        <View className="absolute bottom-3 left-3 right-3 flex-row items-center justify-between rounded-full bg-background/70 px-3 py-2">
          <Text className="min-w-0 flex-1 text-sm font-bold text-foreground" numberOfLines={1}>
            {label}
          </Text>
          <View className="ml-2 h-7 w-7 items-center justify-center rounded-full bg-white/10">
            <Ionicons
              color={isMicEnabled ? '#f8fafc' : '#fb7185'}
              name={isMicEnabled ? 'mic' : 'mic-off'}
              size={14}
            />
          </View>
        </View>
      )}
    </Pressable>
  );
}

function ParticipantPlaceholder({
  isLarge,
  participant,
}: {
  isLarge?: boolean;
  participant: Participant | undefined;
}) {
  return (
    <View className="flex-1 items-center justify-center bg-[#101624]">
      <View
        className="items-center justify-center rounded-[34px] bg-foreground"
        style={{ height: isLarge ? 104 : 62, width: isLarge ? 104 : 62 }}
      >
        <Text className="font-black text-background" style={{ fontSize: isLarge ? 40 : 24 }}>
          {getParticipantInitial(participant)}
        </Text>
      </View>
      <Text className="mt-4 text-center text-base font-semibold text-white/60">
        {participant?.isLocal ? 'Your camera is off' : 'Camera is off'}
      </Text>
    </View>
  );
}

function VoiceParticipantCard({ participant }: { participant: Participant }) {
  const isMicEnabled = participant.isMicrophoneEnabled ?? true;

  return (
    <View className="w-[46%] items-center rounded-[30px] border border-white/10 bg-white/5 px-4 py-6">
      <View
        className={`h-20 w-20 items-center justify-center rounded-[28px] ${
          participant.isSpeaking ? 'bg-emerald-400' : 'bg-foreground'
        }`}
      >
        <Text className="text-3xl font-black text-background">
          {getParticipantInitial(participant)}
        </Text>
      </View>
      <Text className="mt-4 text-center text-base font-bold text-foreground" numberOfLines={1}>
        {getParticipantLabel(participant)}
      </Text>
      <View className="mt-3 flex-row items-center gap-1.5 rounded-full bg-background/70 px-3 py-1.5">
        <Ionicons
          color={isMicEnabled ? '#f8fafc' : '#fb7185'}
          name={isMicEnabled ? 'mic' : 'mic-off'}
          size={13}
        />
        <Text className="text-xs font-bold text-white/70">
          {participant.isSpeaking ? 'Speaking' : isMicEnabled ? 'Audio on' : 'Muted'}
        </Text>
      </View>
    </View>
  );
}

function EmptyCallStage({ message }: { message: string }) {
  return (
    <View className="flex-1 items-center justify-center px-8">
      <View className="h-16 w-16 items-center justify-center rounded-[24px] bg-white/10">
        <Ionicons color="#f8fafc" name="people" size={28} />
      </View>
      <Text className="mt-5 text-center text-xl font-bold text-foreground">{message}</Text>
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
    <View className="flex-1 items-center justify-center bg-[#05070d] px-8">
      <View className="h-16 w-16 items-center justify-center rounded-[24px] bg-white/10">
        <Ionicons color="#f8fafc" name="call" size={28} />
      </View>
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
  const backgroundClass = isDanger ? 'bg-red-500' : isActive ? 'bg-foreground' : 'bg-white/10';
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
        <Ionicons color={iconColor} name={icon} size={22} />
      </AnimatedPressable>
      <Text className="mt-2 text-xs font-bold text-white/60">{label}</Text>
    </View>
  );
}

function getMainTrack(
  tracks: TrackReferenceOrPlaceholder[],
  selectedTrackKey: string | null,
  localIdentity: string,
): TrackReferenceOrPlaceholder | undefined {
  if (selectedTrackKey) {
    const selectedTrack = tracks.find((trackRef) => getTrackKey(trackRef) === selectedTrackKey);
    if (selectedTrack) {
      return selectedTrack;
    }
  }

  return (
    tracks.find(
      (trackRef) => isTrackReference(trackRef) && trackRef.source === Track.Source.ScreenShare,
    ) ??
    tracks.find(
      (trackRef) =>
        isTrackReference(trackRef) &&
        trackRef.participant.identity !== localIdentity &&
        trackRef.source === Track.Source.Camera,
    ) ??
    tracks.find((trackRef) => trackRef.participant.identity !== localIdentity) ??
    tracks[0]
  );
}

function sortTrackTiles(
  tracks: TrackReferenceOrPlaceholder[],
  localIdentity: string,
): TrackReferenceOrPlaceholder[] {
  return [...tracks]
    .filter((trackRef) => trackRef.participant)
    .sort(
      (left, right) => getTrackScore(right, localIdentity) - getTrackScore(left, localIdentity),
    );
}

function getTrackScore(trackRef: TrackReferenceOrPlaceholder, localIdentity: string): number {
  let score = 0;

  if (trackRef.source === Track.Source.ScreenShare) {
    score += 120;
  }
  if (trackRef.participant?.isSpeaking) {
    score += 60;
  }
  if (isTrackReference(trackRef)) {
    score += 30;
  }
  if (trackRef.participant?.identity !== localIdentity) {
    score += 20;
  }

  return score;
}

function getTrackKey(trackRef: TrackReferenceOrPlaceholder): string {
  return `${trackRef.participant?.sid ?? trackRef.participant?.identity ?? 'participant'}:${trackRef.source}`;
}

function getGalleryColumns(count: number, windowWidth: number): number {
  if (windowWidth >= 760) {
    return Math.min(3, Math.max(count, 1));
  }

  return count <= 2 ? 1 : 2;
}

function getParticipantLabel(participant: Participant): string {
  if (participant.isLocal) {
    return 'You';
  }

  const metadata = getParticipantMetadata(participant);
  const userLabel = participant.name || metadata.userId || participant.identity;
  const deviceLabel = metadata.deviceId ? metadata.deviceId.slice(-4) : '';

  return deviceLabel
    ? `${shortenIdentity(userLabel)} · ${deviceLabel}`
    : shortenIdentity(userLabel);
}

function getParticipantInitial(participant: Participant | undefined): string {
  if (!participant) {
    return '?';
  }

  const label = getParticipantLabel(participant);
  return label.slice(0, 1).toUpperCase();
}

function getParticipantMetadata(participant: Participant): ParticipantMetadata {
  try {
    return JSON.parse(participant.metadata || '{}') as ParticipantMetadata;
  } catch {
    return {};
  }
}

function shortenIdentity(identity: string): string {
  if (identity.length <= 12) {
    return identity;
  }

  return `${identity.slice(0, 6)}…${identity.slice(-4)}`;
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
    shadowOpacity: 0.26,
    shadowRadius: 28,
  } as ViewStyle,
  filmstripContent: {
    gap: 10,
    paddingHorizontal: 16,
  },
  filmstripTile: {
    height: 168,
    width: 128,
  } as ViewStyle,
  mainTile: {
    borderRadius: 0,
    flex: 1,
  } as ViewStyle,
});
