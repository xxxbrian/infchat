import Ionicons from '@expo/vector-icons/Ionicons';
import {
  AudioSession,
  isTrackReference,
  useIOSAudioManagement,
  useConnectionState,
  useLocalParticipant,
  useRemoteParticipants,
  useRoomContext,
  useTracks,
  useVisualStableUpdate,
  VideoTrack,
  type TrackReferenceOrPlaceholder,
} from '@livekit/react-native';
import { getProfileAvatarUrl, type CallRoomRecord, type ProfileRecord } from '@infchat/pocketbase';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useLocalSearchParams } from 'expo-router';
import { ConnectionState, Room, Track, type Participant } from 'livekit-client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  Animated,
  Easing,
  PanResponder,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
  type ViewStyle,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { ProfileAvatar } from '../../components/ProfileAvatar';
import { useCallSession } from '../../lib/call-context';
import { listCachedProfilesByUserIds, refreshCachedProfilesByUserIds } from '../../lib/local-cache';
import { pb } from '../../lib/pocketbase';

type CallLayoutMode = 'focus' | 'gallery';
type ChromePointerEvents = 'auto' | 'none';

type ParticipantMetadata = {
  deviceId?: string;
  displayName?: string;
  userId?: string;
  username?: string;
};

type CallProfile = {
  avatarUrl?: string | null;
  displayName: string;
  userId: string;
  username: string;
};

const CONTROL_SIZE = 56;
const CONTROL_BAR_HEIGHT = 96;
const CHROME_AUTO_HIDE_DELAY = 3200;
const FILMSTRIP_GAP = 12;
const PIP_HEIGHT = 178;
const PIP_MARGIN = 16;
const PIP_TOP_OFFSET = 118;
const PIP_WIDTH = 134;
const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

export default function CallScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const callRoomId = id ?? '';
  const entrance = useRef(new Animated.Value(0)).current;
  const {
    activeSession,
    endActiveCall,
    errorMessage,
    isJoining,
    joinCallRoom,
    leaveActiveCall,
    minimizeCall,
  } = useCallSession();

  useEffect(() => {
    Animated.timing(entrance, {
      toValue: 1,
      duration: 360,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    }).start();
  }, [entrance]);

  useEffect(() => {
    if (!callRoomId || activeSession?.callRoom.id === callRoomId) {
      return;
    }

    void joinCallRoom(callRoomId);
  }, [activeSession?.callRoom.id, callRoomId, joinCallRoom]);

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
        {activeSession?.callRoom.id === callRoomId ? (
          <CallRoomView
            callRoom={activeSession.callRoom}
            onEndCall={endActiveCall}
            onHangUp={leaveActiveCall}
            onMinimize={minimizeCall}
          />
        ) : (
          <CallLoadingState
            errorMessage={errorMessage}
            isJoining={isJoining}
            onClose={minimizeCall}
          />
        )}
      </Animated.View>
    </View>
  );
}

function CallRoomView({
  callRoom,
  onEndCall,
  onHangUp,
  onMinimize,
}: {
  callRoom: CallRoomRecord;
  onEndCall: () => void;
  onHangUp: () => void;
  onMinimize: () => void;
}) {
  const { height: windowHeight, width: windowWidth } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const room = useRoomContext();
  const queryClient = useQueryClient();
  const connectionState = useConnectionState();
  const remoteParticipants = useRemoteParticipants();
  const { isCameraEnabled, isMicrophoneEnabled, localParticipant } = useLocalParticipant();
  const [layoutMode, setLayoutMode] = useState<CallLayoutMode>('focus');
  const [isFrontCamera, setIsFrontCamera] = useState(true);
  const [isSpeakerEnabled, setIsSpeakerEnabled] = useState(true);
  const [selectedTrackKey, setSelectedTrackKey] = useState<string | null>(null);
  const [isChromeVisible, setIsChromeVisible] = useState(true);
  const chromeProgress = useRef(new Animated.Value(1)).current;
  const hideChromeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const tracks = useTracks(
    [
      { source: Track.Source.ScreenShare, withPlaceholder: false },
      { source: Track.Source.Camera, withPlaceholder: true },
    ],
    { onlySubscribed: false },
  );
  const stableTracks = useVisualStableUpdate(tracks, 3);
  const sortedTracks = sortTrackTiles(stableTracks, localParticipant.identity);
  const participantUserIds = useMemo(
    () =>
      [
        ...new Set(
          sortedTracks
            .map((trackRef) => getParticipantMetadata(trackRef.participant).userId)
            .filter((userId): userId is string => Boolean(userId)),
        ),
      ].sort(),
    [sortedTracks],
  );
  const profilesQuery = useQuery({
    queryKey: ['profiles', 'call-participants', participantUserIds],
    queryFn: () => listCachedProfilesByUserIds(pb, participantUserIds),
    enabled: participantUserIds.length > 0,
    networkMode: 'always',
  });

  useEffect(() => {
    if (participantUserIds.length === 0) {
      return;
    }

    let isMounted = true;

    void refreshCachedProfilesByUserIds(pb, participantUserIds)
      .then((profiles) => {
        if (isMounted) {
          queryClient.setQueryData(['profiles', 'call-participants', participantUserIds], profiles);
        }
      })
      .catch(() => {
        // Cached participant profiles are enough for call chrome while offline.
      });

    return () => {
      isMounted = false;
    };
  }, [participantUserIds, queryClient]);
  const fileTokenQuery = useQuery({
    queryKey: ['file-token', pb.authStore.record?.id],
    queryFn: () => pb.files.getToken(),
    staleTime: 1000 * 60 * 5,
  });
  const profilesByUserId = useMemo(() => {
    const profiles = new Map<string, CallProfile>();

    for (const profile of profilesQuery.data ?? []) {
      profiles.set(profile.user, toCallProfile(profile, fileTokenQuery.data));
    }

    return profiles;
  }, [fileTokenQuery.data, profilesQuery.data]);
  const mainTrack = getMainTrack(sortedTracks, selectedTrackKey, localParticipant.identity);
  const mainTrackKey = mainTrack ? getTrackKey(mainTrack) : '';
  const filmstripTracks = sortedTracks.filter((trackRef) => getTrackKey(trackRef) !== mainTrackKey);
  const systemPipTrack = getSystemPipTrack(sortedTracks, mainTrack);
  const systemPipTrackKey = systemPipTrack ? getTrackKey(systemPipTrack) : '';
  const participantCount = sortedTracks.length;
  const statusLabel = getCallStatusLabel(connectionState, remoteParticipants.length, callRoom.kind);
  const title = callRoom.kind === 'video' ? 'Video call' : 'Voice call';
  const controlsBottom = Math.max(insets.bottom, 14);
  const filmstripBottom = controlsBottom + CONTROL_BAR_HEIGHT + FILMSTRIP_GAP;
  const shouldAutoHideChrome = callRoom.kind === 'video';
  const chromePointerEvents = isChromeVisible ? 'auto' : 'none';
  const headerTranslateY = chromeProgress.interpolate({
    inputRange: [0, 1],
    outputRange: [-16, 0],
  });
  const controlsTranslateY = chromeProgress.interpolate({
    inputRange: [0, 1],
    outputRange: [18, 0],
  });

  useIOSAudioManagement(room, isSpeakerEnabled, (_trackState, preferSpeakerOutput) => ({
    audioCategory: 'playAndRecord',
    audioCategoryOptions: preferSpeakerOutput
      ? ['allowAirPlay', 'allowBluetooth', 'allowBluetoothA2DP', 'defaultToSpeaker']
      : ['allowAirPlay', 'allowBluetooth', 'allowBluetoothA2DP'],
    audioMode: preferSpeakerOutput ? 'videoChat' : 'voiceChat',
  }));

  const clearChromeTimer = useCallback(() => {
    if (hideChromeTimer.current) {
      clearTimeout(hideChromeTimer.current);
      hideChromeTimer.current = null;
    }
  }, []);

  const hideChrome = useCallback(() => {
    if (!shouldAutoHideChrome) {
      return;
    }

    setIsChromeVisible(false);
    Animated.timing(chromeProgress, {
      toValue: 0,
      duration: 220,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    }).start();
  }, [chromeProgress, shouldAutoHideChrome]);

  const scheduleChromeHide = useCallback(() => {
    clearChromeTimer();

    if (!shouldAutoHideChrome) {
      return;
    }

    hideChromeTimer.current = setTimeout(hideChrome, CHROME_AUTO_HIDE_DELAY);
  }, [clearChromeTimer, hideChrome, shouldAutoHideChrome]);

  const revealChrome = useCallback(() => {
    if (!shouldAutoHideChrome) {
      return;
    }

    setIsChromeVisible(true);
    Animated.timing(chromeProgress, {
      toValue: 1,
      duration: 180,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    }).start();
    scheduleChromeHide();
  }, [chromeProgress, scheduleChromeHide, shouldAutoHideChrome]);

  useEffect(() => {
    if (!shouldAutoHideChrome) {
      clearChromeTimer();
      setIsChromeVisible(true);
      chromeProgress.setValue(1);
      return;
    }

    revealChrome();

    return clearChromeTimer;
  }, [chromeProgress, clearChromeTimer, revealChrome, shouldAutoHideChrome]);

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

  const toggleSpeaker = async () => {
    try {
      const nextSpeakerEnabled = !isSpeakerEnabled;
      const outputs = await AudioSession.getAudioOutputs();
      const nextOutput = getPreferredAudioOutput(outputs, nextSpeakerEnabled);

      if (!nextOutput) {
        Alert.alert('Audio output unavailable', 'This device cannot switch audio output here.');
        return;
      }

      if (Platform.OS === 'ios') {
        await AudioSession.setAppleAudioConfiguration({
          audioCategory: 'playAndRecord',
          audioCategoryOptions: nextSpeakerEnabled
            ? ['allowAirPlay', 'allowBluetooth', 'allowBluetoothA2DP', 'defaultToSpeaker']
            : ['allowAirPlay', 'allowBluetooth', 'allowBluetoothA2DP'],
          audioMode: nextSpeakerEnabled ? 'videoChat' : 'voiceChat',
        });
      }

      await AudioSession.selectAudioOutput(nextOutput);
      setIsSpeakerEnabled(nextSpeakerEnabled);
    } catch {
      Alert.alert('Audio output unavailable', 'Could not change speaker output.');
    }
  };

  const switchCamera = async () => {
    try {
      const devices = await Room.getLocalDevices('videoinput', true);
      const activeDeviceId = room.getActiveDevice('videoinput');
      const nextDevice = devices.find((device) => device.deviceId !== activeDeviceId) ?? devices[0];
      if (nextDevice) {
        await room.switchActiveDevice('videoinput', nextDevice.deviceId);
        setIsFrontCamera((current) => (devices.length > 1 ? !current : current));
      }
    } catch {
      Alert.alert('Camera unavailable', 'Could not switch cameras.');
    }
  };

  const confirmEndCall = () => {
    Alert.alert('End call for everyone?', 'This will disconnect every participant in this call.', [
      { style: 'cancel', text: 'Cancel' },
      { onPress: onEndCall, style: 'destructive', text: 'End call' },
    ]);
  };

  return (
    <View className="flex-1 bg-background" onTouchStart={revealChrome}>
      <View className="absolute inset-0 bg-[#05070d]" />
      <CallHeader
        chromeStyle={{
          opacity: chromeProgress,
          transform: [{ translateY: headerTranslateY }],
        }}
        layoutMode={layoutMode}
        onChangeLayout={() => setLayoutMode(layoutMode === 'focus' ? 'gallery' : 'focus')}
        onMinimize={onMinimize}
        pointerEvents={chromePointerEvents}
        participantCount={participantCount}
        statusLabel={statusLabel}
        style={{ top: insets.top + 12 }}
        title={title}
      />

      {callRoom.kind === 'video' ? (
        layoutMode === 'gallery' ? (
          <GalleryStage
            controlsBottom={controlsBottom}
            mirrorLocalCamera={isFrontCamera}
            profilesByUserId={profilesByUserId}
            selectedTrackKey={selectedTrackKey}
            systemPipTrackKey={systemPipTrackKey}
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
            chromePointerEvents={chromePointerEvents}
            chromeProgress={chromeProgress}
            filmstripBottom={filmstripBottom}
            filmstripTracks={filmstripTracks}
            mainTrack={mainTrack}
            mirrorLocalCamera={isFrontCamera}
            profilesByUserId={profilesByUserId}
            selectedTrackKey={selectedTrackKey}
            systemPipTrackKey={systemPipTrackKey}
            windowHeight={windowHeight}
            windowWidth={windowWidth}
            onSelect={(trackRef) => setSelectedTrackKey(getTrackKey(trackRef))}
          />
        )
      ) : (
        <VoiceStage profilesByUserId={profilesByUserId} tracks={sortedTracks} />
      )}

      <Animated.View
        className="absolute left-6 right-6 z-20"
        pointerEvents={chromePointerEvents}
        style={[
          styles.controls,
          {
            bottom: controlsBottom,
            opacity: chromeProgress,
            transform: [{ translateY: controlsTranslateY }],
          },
        ]}
      >
        <View className="flex-row items-start justify-between">
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
          <CallControl
            icon={isSpeakerEnabled ? 'volume-high' : 'volume-low'}
            isActive={isSpeakerEnabled}
            label={isSpeakerEnabled ? 'Speaker' : 'Earpiece'}
            onPress={toggleSpeaker}
          />
          <CallControl
            icon="call"
            isDanger
            label="Leave"
            onLongPress={confirmEndCall}
            onPress={onHangUp}
          />
        </View>
      </Animated.View>
    </View>
  );
}

function CallHeader({
  chromeStyle,
  layoutMode,
  onChangeLayout,
  onMinimize,
  pointerEvents,
  participantCount,
  statusLabel,
  style,
  title,
}: {
  chromeStyle: object;
  layoutMode: CallLayoutMode;
  onChangeLayout: () => void;
  onMinimize: () => void;
  pointerEvents: ChromePointerEvents;
  participantCount: number;
  statusLabel: string;
  style: ViewStyle;
  title: string;
}) {
  return (
    <Animated.View
      className="absolute left-4 right-4 z-20 flex-row items-center justify-between"
      pointerEvents={pointerEvents}
      style={[style, chromeStyle]}
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
          onPress={onMinimize}
        >
          <Ionicons color="#f8fafc" name="chevron-down" size={20} />
        </Pressable>
        <Pressable
          className="h-11 w-11 items-center justify-center rounded-full border border-white/10 bg-white/10"
          onPress={onChangeLayout}
        >
          <Ionicons color="#f8fafc" name={layoutMode === 'focus' ? 'grid' : 'expand'} size={19} />
        </Pressable>
      </View>
    </Animated.View>
  );
}

function FocusStage({
  chromePointerEvents,
  chromeProgress,
  filmstripBottom,
  filmstripTracks,
  mainTrack,
  mirrorLocalCamera,
  onSelect,
  profilesByUserId,
  selectedTrackKey,
  systemPipTrackKey,
  windowHeight,
  windowWidth,
}: {
  chromePointerEvents: ChromePointerEvents;
  chromeProgress: Animated.Value;
  filmstripBottom: number;
  filmstripTracks: TrackReferenceOrPlaceholder[];
  mainTrack: TrackReferenceOrPlaceholder | undefined;
  mirrorLocalCamera: boolean;
  profilesByUserId: Map<string, CallProfile>;
  selectedTrackKey: string | null;
  systemPipTrackKey: string;
  windowHeight: number;
  windowWidth: number;
  onSelect: (trackRef: TrackReferenceOrPlaceholder) => void;
}) {
  const floatingTrack = filmstripTracks.length === 1 ? filmstripTracks[0] : undefined;
  const filmstripTranslateY = chromeProgress.interpolate({
    inputRange: [0, 1],
    outputRange: [16, 0],
  });

  return (
    <View className="flex-1">
      {mainTrack ? (
        <ParticipantTile
          enableSystemPip={getTrackKey(mainTrack) === systemPipTrackKey}
          hideFooter
          isLarge
          mirrorLocalCamera={mirrorLocalCamera}
          profilesByUserId={profilesByUserId}
          trackRef={mainTrack}
        />
      ) : (
        <EmptyCallStage message="Waiting for participants" />
      )}

      {floatingTrack ? (
        <DraggablePip
          enableSystemPip={getTrackKey(floatingTrack) === systemPipTrackKey}
          filmstripBottom={filmstripBottom}
          isSelected={selectedTrackKey === getTrackKey(floatingTrack)}
          footerProgress={chromeProgress}
          mirrorLocalCamera={mirrorLocalCamera}
          profilesByUserId={profilesByUserId}
          trackRef={floatingTrack}
          windowHeight={windowHeight}
          windowWidth={windowWidth}
          onPress={() => onSelect(floatingTrack)}
        />
      ) : filmstripTracks.length ? (
        <Animated.View
          className="absolute left-0 right-0 z-10"
          pointerEvents={chromePointerEvents}
          style={{
            bottom: filmstripBottom,
            opacity: chromeProgress,
            transform: [{ translateY: filmstripTranslateY }],
          }}
        >
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
                  enableSystemPip={trackKey === systemPipTrackKey}
                  isSelected={selectedTrackKey === trackKey}
                  key={trackKey}
                  mirrorLocalCamera={mirrorLocalCamera}
                  profilesByUserId={profilesByUserId}
                  trackRef={trackRef}
                  onPress={() => onSelect(trackRef)}
                />
              );
            })}
          </ScrollView>
        </Animated.View>
      ) : null}
    </View>
  );
}

function DraggablePip({
  enableSystemPip,
  filmstripBottom,
  footerProgress,
  isSelected,
  mirrorLocalCamera,
  onPress,
  profilesByUserId,
  trackRef,
  windowHeight,
  windowWidth,
}: {
  enableSystemPip?: boolean;
  filmstripBottom: number;
  footerProgress: Animated.Value;
  isSelected: boolean;
  mirrorLocalCamera: boolean;
  onPress: () => void;
  profilesByUserId: Map<string, CallProfile>;
  trackRef: TrackReferenceOrPlaceholder;
  windowHeight: number;
  windowWidth: number;
}) {
  const position = useRef(new Animated.ValueXY({ x: PIP_MARGIN, y: 0 })).current;
  const currentPosition = useRef({ x: PIP_MARGIN, y: 0 });
  const dragStartPosition = useRef({ x: PIP_MARGIN, y: 0 });
  const didDrag = useRef(false);
  const onPressRef = useRef(onPress);
  const maxX = Math.max(PIP_MARGIN, windowWidth - PIP_WIDTH - PIP_MARGIN);
  const minY = PIP_TOP_OFFSET;
  const maxY = Math.max(minY, windowHeight - filmstripBottom - PIP_HEIGHT);
  const snapBoundary = windowWidth / 2;
  const bounds = useRef({ maxX, maxY, minY, snapBoundary });

  bounds.current = { maxX, maxY, minY, snapBoundary };
  onPressRef.current = onPress;

  useEffect(() => {
    const nextPosition = {
      x: clamp(currentPosition.current.x, PIP_MARGIN, maxX),
      y: clamp(currentPosition.current.y || maxY, minY, maxY),
    };
    currentPosition.current = nextPosition;
    position.setValue(nextPosition);
  }, [maxX, maxY, minY, position]);

  const panResponder = useRef(
    PanResponder.create({
      onMoveShouldSetPanResponder: (_event, gestureState) =>
        Math.abs(gestureState.dx) > 6 || Math.abs(gestureState.dy) > 6,
      onPanResponderGrant: () => {
        didDrag.current = false;
        dragStartPosition.current = currentPosition.current;
      },
      onPanResponderMove: (_event, gestureState) => {
        didDrag.current = true;
        const nextPosition = {
          x: clamp(dragStartPosition.current.x + gestureState.dx, PIP_MARGIN, bounds.current.maxX),
          y: clamp(
            dragStartPosition.current.y + gestureState.dy,
            bounds.current.minY,
            bounds.current.maxY,
          ),
        };
        currentPosition.current = nextPosition;
        position.setValue(nextPosition);
      },
      onPanResponderRelease: () => {
        if (!didDrag.current) {
          onPressRef.current();
          return;
        }

        const snapX =
          currentPosition.current.x + PIP_WIDTH / 2 < bounds.current.snapBoundary
            ? PIP_MARGIN
            : bounds.current.maxX;
        const nextPosition = {
          x: snapX,
          y: clamp(currentPosition.current.y, bounds.current.minY, bounds.current.maxY),
        };
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
        currentPosition.current = {
          x:
            currentPosition.current.x + PIP_WIDTH / 2 < bounds.current.snapBoundary
              ? PIP_MARGIN
              : bounds.current.maxX,
          y: clamp(currentPosition.current.y, bounds.current.minY, bounds.current.maxY),
        };
        position.setValue(currentPosition.current);
      },
      onStartShouldSetPanResponder: () => true,
    }),
  ).current;

  return (
    <Animated.View
      className="absolute z-10"
      style={{
        transform: [{ translateX: position.x }, { translateY: position.y }],
      }}
      {...panResponder.panHandlers}
    >
      <ParticipantTile
        containerStyle={styles.floatingPipTile}
        enableSystemPip={enableSystemPip}
        footerProgress={footerProgress}
        isSelected={isSelected}
        mirrorLocalCamera={mirrorLocalCamera}
        profilesByUserId={profilesByUserId}
        shouldHideBorder
        trackRef={trackRef}
      />
    </Animated.View>
  );
}

function GalleryStage({
  controlsBottom,
  mirrorLocalCamera,
  onSelect,
  profilesByUserId,
  selectedTrackKey,
  systemPipTrackKey,
  tracks,
  windowHeight,
  windowWidth,
}: {
  controlsBottom: number;
  mirrorLocalCamera: boolean;
  onSelect: (trackRef: TrackReferenceOrPlaceholder) => void;
  profilesByUserId: Map<string, CallProfile>;
  selectedTrackKey: string | null;
  systemPipTrackKey: string;
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
            mirrorLocalCamera={mirrorLocalCamera}
            profilesByUserId={profilesByUserId}
            trackRef={trackRef}
            enableSystemPip={trackKey === systemPipTrackKey}
            onPress={() => onSelect(trackRef)}
          />
        );
      })}
    </View>
  );
}

function VoiceStage({
  profilesByUserId,
  tracks,
}: {
  profilesByUserId: Map<string, CallProfile>;
  tracks: TrackReferenceOrPlaceholder[];
}) {
  return (
    <View className="flex-1 px-4 pb-36 pt-28">
      <View className="flex-1 justify-center">
        <View className="flex-row flex-wrap justify-center gap-3">
          {tracks.map((trackRef) => {
            const participant = trackRef.participant;
            if (!participant) {
              return null;
            }

            return (
              <VoiceParticipantCard
                key={getTrackKey(trackRef)}
                participant={participant}
                profilesByUserId={profilesByUserId}
              />
            );
          })}
        </View>
      </View>
    </View>
  );
}

function ParticipantTile({
  containerStyle,
  enableSystemPip,
  footerProgress,
  hideFooter,
  isLarge,
  isSelected,
  mirrorLocalCamera = true,
  onPress,
  profilesByUserId,
  shouldHideBorder,
  trackRef,
}: {
  containerStyle?: ViewStyle;
  enableSystemPip?: boolean;
  footerProgress?: Animated.Value;
  hideFooter?: boolean;
  isLarge?: boolean;
  isSelected?: boolean;
  mirrorLocalCamera?: boolean;
  onPress?: () => void;
  profilesByUserId: Map<string, CallProfile>;
  shouldHideBorder?: boolean;
  trackRef: TrackReferenceOrPlaceholder;
}) {
  const participant = trackRef.participant;
  const hasVideo = isTrackReference(trackRef);
  const profile = participant ? getParticipantProfile(participant, profilesByUserId) : undefined;
  const label = participant ? getParticipantLabel(participant, profile) : 'Joining';
  const isScreenShare = trackRef.source === Track.Source.ScreenShare;
  const isMicEnabled = participant?.isMicrophoneEnabled ?? true;
  const borderClass = shouldHideBorder
    ? ''
    : isSelected
      ? 'border border-foreground/90'
      : 'border border-white/10';
  const footerTranslateY = footerProgress?.interpolate({
    inputRange: [0, 1],
    outputRange: [10, 0],
  });
  const footerContent = (
    <>
      <View className="mr-2">
        <CallParticipantAvatar participant={participant} profile={profile} size={28} />
      </View>
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
    </>
  );

  return (
    <Pressable
      className={`overflow-hidden rounded-[30px] bg-[#121723] ${borderClass}`}
      disabled={!onPress}
      onPress={onPress}
      style={[isLarge ? styles.mainTile : undefined, containerStyle]}
    >
      {hasVideo ? (
        <VideoTrack
          mirror={
            Boolean(trackRef.participant?.isLocal) &&
            trackRef.source === Track.Source.Camera &&
            mirrorLocalCamera
          }
          objectFit="cover"
          iosPIP={
            enableSystemPip
              ? {
                  enabled: true,
                  preferredSize: { width: 9, height: 16 },
                  startAutomatically: true,
                  stopAutomatically: true,
                }
              : undefined
          }
          style={shouldHideBorder ? styles.videoOverscan : StyleSheet.absoluteFillObject}
          trackRef={trackRef}
        />
      ) : (
        <ParticipantPlaceholder isLarge={isLarge} participant={participant} profile={profile} />
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
      {hideFooter ? null : footerProgress && footerTranslateY ? (
        <Animated.View
          className="absolute bottom-3 left-3 right-3 flex-row items-center justify-between rounded-full bg-background/70 px-3 py-2"
          style={{
            opacity: footerProgress,
            transform: [{ translateY: footerTranslateY }],
          }}
        >
          {footerContent}
        </Animated.View>
      ) : (
        <View className="absolute bottom-3 left-3 right-3 flex-row items-center justify-between rounded-full bg-background/70 px-3 py-2">
          {footerContent}
        </View>
      )}
    </Pressable>
  );
}

function getSystemPipTrack(
  tracks: TrackReferenceOrPlaceholder[],
  preferredTrack: TrackReferenceOrPlaceholder | undefined,
): TrackReferenceOrPlaceholder | undefined {
  if (Platform.OS !== 'ios') {
    return undefined;
  }

  if (isRemoteCameraTrack(preferredTrack)) {
    return preferredTrack;
  }

  return tracks.find(isRemoteCameraTrack);
}

function isRemoteCameraTrack(
  trackRef: TrackReferenceOrPlaceholder | undefined,
): trackRef is TrackReferenceOrPlaceholder {
  return Boolean(
    trackRef &&
      isTrackReference(trackRef) &&
      !trackRef.participant.isLocal &&
      trackRef.source === Track.Source.Camera,
  );
}

function ParticipantPlaceholder({
  isLarge,
  participant,
  profile,
}: {
  isLarge?: boolean;
  participant: Participant | undefined;
  profile?: CallProfile;
}) {
  const avatarSize = isLarge ? 104 : 62;

  return (
    <View className="flex-1 items-center justify-center bg-[#101624]">
      <CallParticipantAvatar participant={participant} profile={profile} size={avatarSize} />
      <Text className="mt-4 text-center text-base font-semibold text-white/60">
        {participant?.isLocal ? 'Your camera is off' : 'Camera is off'}
      </Text>
    </View>
  );
}

function VoiceParticipantCard({
  participant,
  profilesByUserId,
}: {
  participant: Participant;
  profilesByUserId: Map<string, CallProfile>;
}) {
  const isMicEnabled = participant.isMicrophoneEnabled ?? true;
  const profile = getParticipantProfile(participant, profilesByUserId);

  return (
    <View className="w-[46%] items-center rounded-[30px] border border-white/10 bg-white/5 px-4 py-6">
      <View className={participant.isSpeaking ? 'rounded-full border-2 border-emerald-400' : ''}>
        <CallParticipantAvatar participant={participant} profile={profile} size={80} />
      </View>
      <Text className="mt-4 text-center text-base font-bold text-foreground" numberOfLines={1}>
        {getParticipantLabel(participant, profile)}
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
  isJoining,
  onClose,
}: {
  errorMessage: string;
  isJoining: boolean;
  onClose: () => void;
}) {
  return (
    <View className="flex-1 items-center justify-center bg-[#05070d] px-8">
      <View className="h-16 w-16 items-center justify-center rounded-[24px] bg-white/10">
        <Ionicons color="#f8fafc" name="call" size={28} />
      </View>
      <Text className="mt-6 text-center text-2xl font-bold text-foreground">
        {errorMessage || (isJoining ? 'Joining call' : 'Preparing call')}
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
  onLongPress,
  onPress,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  isActive?: boolean;
  isDanger?: boolean;
  label: string;
  onLongPress?: () => void;
  onPress: () => void;
}) {
  const scale = useRef(new Animated.Value(1)).current;
  const backgroundClass = isDanger ? 'bg-red-500' : isActive ? 'bg-foreground' : 'bg-white/10';
  const iconColor = isDanger || isActive ? '#080b12' : '#f8fafc';

  return (
    <View className="items-center">
      <AnimatedPressable
        className={`items-center justify-center rounded-full ${backgroundClass}`}
        onLongPress={onLongPress}
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

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), maximum);
}

function getPreferredAudioOutput(outputs: string[], shouldUseSpeaker: boolean): string | undefined {
  if (shouldUseSpeaker) {
    return outputs.find((output) => output === 'speaker' || output === 'force_speaker');
  }

  return outputs.find((output) => output === 'earpiece' || output === 'default');
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

function toCallProfile(profile: ProfileRecord, fileToken?: string): CallProfile {
  return {
    avatarUrl: getProfileAvatarUrl(pb, profile, fileToken),
    displayName: profile.display_name || profile.username,
    userId: profile.user,
    username: profile.username,
  };
}

function getParticipantProfile(
  participant: Participant,
  profilesByUserId: Map<string, CallProfile>,
): CallProfile | undefined {
  const metadata = getParticipantMetadata(participant);

  if (!metadata.userId) {
    return undefined;
  }

  return profilesByUserId.get(metadata.userId);
}

function CallParticipantAvatar({
  participant,
  profile,
  size,
}: {
  participant: Participant | undefined;
  profile?: CallProfile;
  size: number;
}) {
  const metadata = participant ? getParticipantMetadata(participant) : undefined;
  const userId = profile?.userId || metadata?.userId || participant?.identity || 'joining';
  const username = profile?.username || metadata?.username || participant?.name || userId;
  const name = profile?.displayName || metadata?.displayName || participant?.name || username;

  return (
    <ProfileAvatar
      avatarUrl={profile?.avatarUrl}
      name={name}
      size={size}
      userId={userId}
      username={username}
    />
  );
}

function getParticipantLabel(participant: Participant, profile?: CallProfile): string {
  if (participant.isLocal) {
    return 'You';
  }

  const metadata = getParticipantMetadata(participant);
  const userLabel =
    profile?.displayName ||
    participant.name ||
    metadata.displayName ||
    profile?.username ||
    metadata.username ||
    metadata.userId ||
    participant.identity;
  const deviceLabel = metadata.deviceId ? metadata.deviceId.slice(-4) : '';

  return deviceLabel ? `${shortenIdentity(userLabel)} #${deviceLabel}` : shortenIdentity(userLabel);
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
  floatingPipTile: {
    height: PIP_HEIGHT,
    width: PIP_WIDTH,
  } as ViewStyle,
  mainTile: {
    borderRadius: 0,
    flex: 1,
  } as ViewStyle,
  videoOverscan: {
    bottom: -1,
    left: -1,
    position: 'absolute',
    right: -1,
    top: -1,
  } as ViewStyle,
});
