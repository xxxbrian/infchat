import Ionicons from '@expo/vector-icons/Ionicons';
import { getProfileAvatarUrl } from '@infchat/pocketbase';
import { getAvatarColor, getAvatarInitial } from '@infchat/shared';
import MaskedView from '@react-native-masked-view/masked-view';
import { useQuery } from '@tanstack/react-query';
import { BlurView } from 'expo-blur';
import * as Haptics from 'expo-haptics';
import { LinearGradient } from 'expo-linear-gradient';
import { router } from 'expo-router';
import { useRef, useState } from 'react';
import {
  Animated,
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
import { getCachedCurrentProfile } from '../../lib/local-cache';
import { pb } from '../../lib/pocketbase';

type SettingsRowItem = {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  onPress?: () => void;
  value?: string;
  variant?: 'default' | 'danger';
};

const HEADER_SIDE_PADDING = 20;
const TOP_BAR_HEIGHT = 48;
const PROFILE_EXPAND_OFFSET = -22;
const PROFILE_COLLAPSE_OFFSET = -8;
const PROFILE_HERO_HEIGHT = 168;
const HERO_AVATAR_SIZE = 92;
const SETTINGS_SECTIONS: SettingsRowItem[][] = [
  [
    {
      icon: 'person-circle',
      label: 'Profile',
      onPress: () => router.push('/profile/edit'),
    },
  ],
  [
    { icon: 'bookmark', label: 'Saved Messages' },
    { icon: 'call', label: 'Recent Calls' },
    { icon: 'phone-portrait', label: 'Devices', value: '1' },
    { icon: 'folder', label: 'Chat Files' },
  ],
  [
    { icon: 'notifications', label: 'Notifications' },
    { icon: 'lock-closed', label: 'Privacy and Security' },
    { icon: 'server', label: 'Data and Storage' },
    { icon: 'color-palette', label: 'Appearance' },
    {
      icon: 'bug',
      label: 'Debug',
      onPress: () => router.push('/debug'),
      value: 'Env',
    },
  ],
];

export default function SettingsTab() {
  const insets = useSafeAreaInsets();
  const { width: windowWidth } = useWindowDimensions();
  const { authRecord, logout } = useAuth();
  const scrollY = useRef(new Animated.Value(0)).current;
  const profileExpansion = useRef(new Animated.Value(0)).current;
  const scrollYValue = useRef(0);
  const isDraggingRef = useRef(false);
  const isProfileExpandedRef = useRef(false);
  const [headerHeight, setHeaderHeight] = useState(0);
  const profileQuery = useQuery({
    queryKey: ['profile', 'current', authRecord.id],
    queryFn: () => getCachedCurrentProfile(pb),
  });
  const fileTokenQuery = useQuery({
    queryKey: ['file-token', authRecord.id],
    queryFn: () => pb.files.getToken(),
    staleTime: 1000 * 60 * 5,
  });
  const profile = profileQuery.data;
  const displayName = profile?.display_name || authRecord.username || 'user';
  const username = profile?.username || authRecord.username || 'user';
  const avatarUrl = profile ? getProfileAvatarUrl(pb, profile, fileTokenQuery.data) : null;
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
  const fallbackAvatarColor = getAvatarColor(profile?.user || authRecord.id || username);
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
          <Animated.Text className="text-xl font-bold text-foreground" numberOfLines={1}>
            Settings
          </Animated.Text>
          <Pressable
            className="h-10 items-center justify-center rounded-full bg-foreground px-4"
            onPress={() => router.push('/profile/edit')}
          >
            <Text className="text-sm font-bold text-background">Edit</Text>
          </Pressable>
        </View>
      </Animated.View>

      <Animated.ScrollView
        className="flex-1"
        contentContainerStyle={{
          paddingBottom: Math.max(insets.bottom, 16) + 40,
          paddingTop: 0,
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
          <Pressable className="items-center" onPress={() => router.push('/profile/edit')}>
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
              {avatarUrl ? (
                <Image source={{ uri: avatarUrl }} style={StyleSheet.absoluteFillObject} />
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
          </Pressable>
        </Animated.View>

        <View className="px-5 pt-5">
          {SETTINGS_SECTIONS.map((section, index) => (
            <SettingsSection items={section} key={index} />
          ))}

          <SettingsSection
            items={[
              {
                icon: 'log-out',
                label: 'Log Out',
                onPress: logout,
                variant: 'danger',
              },
            ]}
          />
        </View>
      </Animated.ScrollView>
    </View>
  );
}

function SettingsSection({ items }: { items: SettingsRowItem[] }) {
  return (
    <View className="mb-5 overflow-hidden rounded-[30px] bg-muted" style={styles.section}>
      {items.map((item, index) => (
        <SettingsRow hasDivider={index < items.length - 1} item={item} key={item.label} />
      ))}
    </View>
  );
}

function SettingsRow({ hasDivider, item }: { hasDivider: boolean; item: SettingsRowItem }) {
  const textColor = item.variant === 'danger' ? 'text-red-300' : 'text-foreground';

  return (
    <Pressable
      className="min-h-[62px] flex-row items-center pl-4 pr-3"
      disabled={!item.onPress}
      onPress={item.onPress}
    >
      <View className="h-9 w-9 items-center justify-center rounded-full bg-background/55">
        <Ionicons
          color={item.variant === 'danger' ? '#fca5a5' : '#f8fafc'}
          name={item.icon}
          size={19}
        />
      </View>
      <View
        className={`ml-4 min-h-[62px] min-w-0 flex-1 flex-row items-center ${hasDivider ? 'border-b border-border/70' : ''}`}
      >
        <Text className={`min-w-0 flex-1 text-[17px] font-semibold ${textColor}`} numberOfLines={1}>
          {item.label}
        </Text>
        {item.value ? (
          <Text className="mr-2 text-[16px] font-semibold text-muted-foreground">{item.value}</Text>
        ) : null}
        {item.onPress || item.variant !== 'danger' ? (
          <Ionicons color="#64748b" name="chevron-forward" size={19} />
        ) : null}
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  header: {
    paddingHorizontal: HEADER_SIDE_PADDING,
  } as ViewStyle,
  section: {
    borderCurve: 'continuous',
  } as ViewStyle,
});
