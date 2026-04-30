import Ionicons from '@expo/vector-icons/Ionicons';
import {
  getProfileAvatarUrl,
  startCall,
  startPrivateConversation,
  type CallKind,
} from '@infchat/pocketbase';
import { getAvatarColor, getAvatarInitial } from '@infchat/shared';
import MaskedView from '@react-native-masked-view/masked-view';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { BlurView } from 'expo-blur';
import * as Haptics from 'expo-haptics';
import { LinearGradient } from 'expo-linear-gradient';
import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import {
  Animated,
  Alert,
  Image,
  Pressable,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
  type ViewStyle,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useAuth } from '../../lib/auth-context';
import { getDeviceId } from '../../lib/device-id';
import {
  getCachedProfileByUserId,
  refreshCachedConversations,
  refreshCachedProfileByUserId,
  writeCachedConversation,
} from '../../lib/local-cache';
import { useCachedRemoteUri } from '../../lib/media-cache';
import { pb } from '../../lib/pocketbase';

const HEADER_SIDE_PADDING = 20;
const TOP_BAR_HEIGHT = 48;
const PROFILE_EXPAND_OFFSET = -22;
const PROFILE_COLLAPSE_OFFSET = -8;
const PROFILE_HERO_HEIGHT = 168;
const HERO_AVATAR_SIZE = 92;

export default function ProfileScreen() {
  const { userId } = useLocalSearchParams<{ userId: string }>();
  const profileUserId = userId ?? '';
  const insets = useSafeAreaInsets();
  const { width: windowWidth } = useWindowDimensions();
  const { authRecord } = useAuth();
  const queryClient = useQueryClient();
  const scrollY = useRef(new Animated.Value(0)).current;
  const profileExpansion = useRef(new Animated.Value(0)).current;
  const scrollYValue = useRef(0);
  const isDraggingRef = useRef(false);
  const isProfileExpandedRef = useRef(false);
  const [headerHeight, setHeaderHeight] = useState(0);

  const profileQuery = useQuery({
    queryKey: ['profile', 'user', profileUserId],
    queryFn: () => getCachedProfileByUserId(pb, profileUserId),
    enabled: Boolean(profileUserId),
    networkMode: 'always',
  });
  const fileTokenQuery = useQuery({
    queryKey: ['file-token', authRecord.id],
    queryFn: () => pb.files.getToken(),
    staleTime: 1000 * 60 * 5,
  });
  const profile = profileQuery.data;
  const canContactProfile = Boolean(profileUserId && profileUserId !== authRecord.id && profile);
  const displayName = profile?.display_name || profile?.username || 'Profile';
  const username = profile?.username || 'unknown';
  const bio = profile?.bio?.trim() || 'No bio yet';
  const avatarUrl = profile ? getProfileAvatarUrl(pb, profile, fileTokenQuery.data) : null;
  const cachedAvatarUrl = useCachedRemoteUri(
    avatarUrl,
    avatarUrl ? `profile-hero:${profileUserId}:${avatarUrl.split('?')[0]}` : undefined,
  );
  const normalHeroTop = Math.max(headerHeight, insets.top + TOP_BAR_HEIGHT);
  const pullAvatarSize = Math.max(HERO_AVATAR_SIZE, windowWidth);
  const heroHeight = profileExpansion.interpolate({
    inputRange: [0, 1],
    outputRange: [normalHeroTop + PROFILE_HERO_HEIGHT, pullAvatarSize],
  });
  const avatarSize = profileExpansion.interpolate({
    inputRange: [0, 1],
    outputRange: [HERO_AVATAR_SIZE, pullAvatarSize],
  });
  const avatarRadius = profileExpansion.interpolate({
    inputRange: [0, 1],
    outputRange: [HERO_AVATAR_SIZE / 2, 0],
  });
  const avatarTop = profileExpansion.interpolate({
    inputRange: [0, 1],
    outputRange: [normalHeroTop, 0],
  });
  const avatarInitialSize = profileExpansion.interpolate({
    inputRange: [0, 1],
    outputRange: [34, 96],
  });
  const centerIdentityOpacity = scrollY.interpolate({
    inputRange: [0, 96],
    outputRange: [1, 0.25],
    extrapolate: 'clamp',
  });
  const pulledIdentityOpacity = profileExpansion;
  const centeredIdentityOpacity = Animated.multiply(
    centerIdentityOpacity,
    profileExpansion.interpolate({ inputRange: [0, 1], outputRange: [1, 0] }),
  );
  const headerSurfaceOpacity = scrollY.interpolate({
    inputRange: [56, 96],
    outputRange: [0, 1],
    extrapolate: 'clamp',
  });
  const initial = getAvatarInitial(displayName, username);
  const fallbackAvatarColor = getAvatarColor(profile?.user || profileUserId || username);
  const startChatMutation = useMutation({
    mutationFn: () => startPrivateConversation(pb, profileUserId),
    onSuccess: (conversation) => {
      void writeCachedConversation(pb, conversation).then(() => {
        void refreshCachedConversations(pb).then((conversations) => {
          queryClient.setQueriesData({ queryKey: ['conversations'] }, conversations);
        });
      });
      router.push({ pathname: '/chat/[id]', params: { id: conversation.id } });
    },
    onError: (error) => {
      Alert.alert(
        'Could not open chat',
        getErrorMessage(error, 'Check your connection and try again.'),
      );
    },
  });
  const startCallMutation = useMutation({
    mutationFn: async (kind: CallKind) => {
      const conversation = await startPrivateConversation(pb, profileUserId);
      const deviceId = await getDeviceId();
      const call = await startCall(pb, conversation.id, kind, deviceId);

      return { call, conversation };
    },
    onSuccess: ({ call, conversation }) => {
      void writeCachedConversation(pb, conversation).then(() => {
        void refreshCachedConversations(pb).then((conversations) => {
          queryClient.setQueriesData({ queryKey: ['conversations'] }, conversations);
        });
      });
      queryClient.invalidateQueries({
        queryKey: ['active-call', conversation.id],
      });
      router.push({ pathname: '/call/[id]', params: { id: call.callRoom.id } });
    },
    onError: (error) => {
      Alert.alert(
        'Call unavailable',
        getErrorMessage(error, 'Check your connection and try again.'),
      );
    },
  });
  const isContactActionPending = startChatMutation.isPending || startCallMutation.isPending;

  useEffect(() => {
    if (!profileUserId) {
      return;
    }

    let isMounted = true;

    void refreshCachedProfileByUserId(pb, profileUserId)
      .then((nextProfile) => {
        if (isMounted) {
          queryClient.setQueryData(['profile', 'user', profileUserId], nextProfile);
        }
      })
      .catch(() => {
        // Keep the cached profile visible if this refresh fails.
      });

    return () => {
      isMounted = false;
    };
  }, [profileUserId, queryClient]);

  const handleOpenChat = () => {
    if (!canContactProfile || isContactActionPending) {
      return;
    }

    void Haptics.selectionAsync();
    startChatMutation.mutate();
  };

  const handleStartCall = (kind: CallKind) => {
    if (!canContactProfile || isContactActionPending) {
      return;
    }

    void Haptics.selectionAsync();
    startCallMutation.mutate(kind);
  };
  const animateProfileExpansion = (isExpanded: boolean) => {
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    Animated.timing(profileExpansion, {
      toValue: isExpanded ? 1 : 0,
      duration: 180,
      useNativeDriver: false,
    }).start();
  };
  const handleScroll = Animated.event([{ nativeEvent: { contentOffset: { y: scrollY } } }], {
    listener: ({ nativeEvent }: { nativeEvent: { contentOffset: { y: number } } }) => {
      const nextOffset = nativeEvent.contentOffset.y;
      scrollYValue.current = nextOffset;

      if (!isProfileExpandedRef.current && nextOffset <= PROFILE_EXPAND_OFFSET) {
        isProfileExpandedRef.current = true;
        animateProfileExpansion(true);
        return;
      }

      if (
        isProfileExpandedRef.current &&
        isDraggingRef.current &&
        nextOffset >= PROFILE_COLLAPSE_OFFSET
      ) {
        isProfileExpandedRef.current = false;
        animateProfileExpansion(false);
      }
    },
    useNativeDriver: false,
  });

  return (
    <View className="flex-1 bg-background">
      <Animated.View
        className="absolute left-0 right-0 z-10 pb-3"
        onLayout={({ nativeEvent }) => setHeaderHeight(nativeEvent.layout.height)}
        style={[styles.header, { paddingTop: insets.top }]}
      >
        <Animated.View
          className="absolute inset-0 bg-background/95"
          pointerEvents="none"
          style={{ opacity: headerSurfaceOpacity }}
        />
        <View className="flex-row items-center justify-between" style={{ height: TOP_BAR_HEIGHT }}>
          <Pressable
            className="h-10 w-10 items-center justify-center rounded-full bg-muted"
            onPress={router.back}
          >
            <Ionicons color="#f8fafc" name="chevron-back" size={22} />
          </Pressable>
          <Animated.Text
            className="mx-3 flex-1 text-center text-xl font-bold text-foreground"
            numberOfLines={1}
          >
            {displayName}
          </Animated.Text>
          <Pressable className="h-10 w-10 items-center justify-center rounded-full bg-muted">
            <Ionicons color="#f8fafc" name="ellipsis-horizontal" size={20} />
          </Pressable>
        </View>
      </Animated.View>

      <Animated.ScrollView
        className="flex-1"
        contentContainerStyle={{
          paddingBottom: Math.max(insets.bottom, 16) + 40,
        }}
        onScroll={handleScroll}
        onScrollBeginDrag={() => {
          isDraggingRef.current = true;
        }}
        onScrollEndDrag={() => {
          isDraggingRef.current = false;
        }}
        scrollEventThrottle={16}
        showsVerticalScrollIndicator={false}
      >
        <Animated.View className="bg-background" style={{ height: heroHeight }}>
          <View className="items-center">
            <Animated.View
              className="overflow-hidden"
              style={{
                alignItems: 'center',
                alignSelf: 'center',
                backgroundColor: fallbackAvatarColor,
                borderRadius: avatarRadius,
                height: avatarSize,
                justifyContent: 'center',
                marginTop: avatarTop,
                width: avatarSize,
              }}
            >
              {cachedAvatarUrl ? (
                <Image source={{ uri: cachedAvatarUrl }} style={StyleSheet.absoluteFillObject} />
              ) : (
                <Animated.Text
                  className="font-bold text-background"
                  style={{ fontSize: avatarInitialSize }}
                >
                  {initial}
                </Animated.Text>
              )}
              <Animated.View
                className="absolute bottom-0 left-0 right-0 overflow-hidden"
                style={{ height: 156, opacity: pulledIdentityOpacity }}
              >
                <MaskedView
                  maskElement={
                    <LinearGradient
                      colors={['transparent', 'rgba(0,0,0,0.65)', 'black']}
                      locations={[0, 0.42, 1]}
                      style={StyleSheet.absoluteFillObject}
                    />
                  }
                  style={StyleSheet.absoluteFillObject}
                >
                  <BlurView intensity={44} style={StyleSheet.absoluteFillObject} tint="dark" />
                </MaskedView>
                <LinearGradient
                  colors={['rgba(8,11,18,0)', 'rgba(8,11,18,0.42)', 'rgba(8,11,18,0.78)']}
                  locations={[0, 0.48, 1]}
                  style={StyleSheet.absoluteFillObject}
                />
                <View className="absolute bottom-0 left-0 right-0 px-5 pb-5">
                  <Text className="text-[34px] font-bold tracking-[-1.2px] text-foreground">
                    {displayName}
                  </Text>
                  <Text className="mt-1 text-base font-semibold text-foreground/75">
                    @{username}
                  </Text>
                </View>
              </Animated.View>
            </Animated.View>

            <Animated.View className="items-center" style={{ opacity: centeredIdentityOpacity }}>
              <Text
                className="mt-3 text-[32px] font-bold tracking-[-1.2px] text-foreground"
                numberOfLines={1}
              >
                {displayName}
              </Text>
              <Text
                className="mt-1 text-base font-semibold text-muted-foreground"
                numberOfLines={1}
              >
                @{username}
              </Text>
            </Animated.View>
          </View>
        </Animated.View>

        <View className="px-5 pt-5">
          <View className="mb-5 flex-row gap-3">
            <ProfileAction
              disabled={!canContactProfile || isContactActionPending}
              dimmed={!canContactProfile}
              icon="chatbubble"
              label="message"
              onPress={handleOpenChat}
            />
            <ProfileAction
              disabled={!canContactProfile || isContactActionPending}
              dimmed={!canContactProfile}
              icon="call"
              label="call"
              onPress={() => handleStartCall('voice')}
            />
            <ProfileAction
              disabled={!canContactProfile || isContactActionPending}
              dimmed={!canContactProfile}
              icon="videocam"
              label="video"
              onPress={() => handleStartCall('video')}
            />
            <ProfileAction icon="search" label="search" />
            <ProfileAction icon="ellipsis-horizontal" label="more" />
          </View>

          <View className="mb-5 overflow-hidden rounded-[24px] bg-muted" style={styles.section}>
            <InfoRow label="Username" value={`@${username}`} />
            <InfoRow label="Bio" value={bio} />
            <InfoRow label="Birthday" value="Unknown" />
            <InfoRow label="Member since" value="Unknown" isLast />
          </View>
        </View>
      </Animated.ScrollView>
    </View>
  );
}

function ProfileAction({
  disabled,
  dimmed,
  icon,
  label,
  onPress,
}: {
  disabled?: boolean;
  dimmed?: boolean;
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  onPress?: () => void;
}) {
  return (
    <Pressable
      className="h-[58px] flex-1 items-center justify-center rounded-[22px] bg-muted"
      disabled={disabled}
      onPress={onPress}
      style={dimmed ? styles.disabledAction : undefined}
    >
      <Ionicons color="#f8fafc" name={icon} size={18} />
      <Text className="mt-1.5 text-[10px] font-bold text-muted-foreground" numberOfLines={1}>
        {label}
      </Text>
    </Pressable>
  );
}

function InfoRow({ isLast, label, value }: { isLast?: boolean; label: string; value: string }) {
  return (
    <View className="min-h-[60px] px-4">
      <View className={`min-h-[60px] justify-center ${isLast ? '' : 'border-b border-border/70'}`}>
        <Text className="text-xs font-bold uppercase tracking-[0.8px] text-muted-foreground">
          {label}
        </Text>
        <Text className="mt-1 text-[14px] font-semibold text-foreground" numberOfLines={2}>
          {value}
        </Text>
      </View>
    </View>
  );
}

function getErrorMessage(error: unknown, fallback: string): string {
  if (error && typeof error === 'object' && 'message' in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === 'string' && message.trim()) {
      return message;
    }
  }

  return fallback;
}

const styles = StyleSheet.create({
  disabledAction: {
    opacity: 0.45,
  } as ViewStyle,
  header: {
    paddingHorizontal: HEADER_SIDE_PADDING,
  } as ViewStyle,
  section: {
    borderCurve: 'continuous',
  } as ViewStyle,
});
