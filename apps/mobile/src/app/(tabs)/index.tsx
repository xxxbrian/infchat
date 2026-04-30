import Ionicons from '@expo/vector-icons/Ionicons';
import {
  type CallRoomRecord,
  type ConversationRecord,
  getProfileAvatarUrl,
  listActiveCalls,
  type ProfileRecord,
} from '@infchat/pocketbase';
import { useNetInfo } from '@react-native-community/netinfo';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { router } from 'expo-router';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Animated,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  type ViewStyle,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { ProfileAvatar } from '../../components/ProfileAvatar';
import { useAuth } from '../../lib/auth-context';
import { useChatSyncService } from '../../lib/chat-sync-context';
import { listLocalConversationStates, listLocalConversations } from '../../lib/chat-sync-store';
import { listCachedProfilesByUserIds, refreshCachedProfilesByUserIds } from '../../lib/local-cache';
import { pb } from '../../lib/pocketbase';

type ConversationView = {
  id: string;
  kind: ConversationRecord['kind'];
  name: string;
  message: string;
  time: string;
  unread: number;
  subtitle: string;
  avatarUrl?: string | null;
  avatarUserId: string;
  avatarUsername: string;
  activeCall?: CallRoomRecord;
  members?: string[];
};

const SEARCH_HEIGHT = 40;
const SEARCH_MARGIN_MAX = 18;
const SEARCH_MARGIN_MIN = 8;
const HEADER_SIDE_PADDING = 20;
const TOP_BAR_HEIGHT = 48;
const TITLE_HEIGHT = 52;
const TITLE_MARGIN_BOTTOM = 12;

const filters = ['All', 'Unread', 'Groups'];

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

export default function ChatTab() {
  const { authRecord } = useAuth();
  const chatSyncService = useChatSyncService();
  const queryClient = useQueryClient();
  const netInfo = useNetInfo();
  const insets = useSafeAreaInsets();
  const searchRef = useRef<TextInput>(null);
  const scrollViewRef = useRef<ScrollView>(null);
  const scrollY = useRef(new Animated.Value(0)).current;
  const scrollYValue = useRef(0);
  const [headerHeight, setHeaderHeight] = useState(0);
  const [query, setQuery] = useState('');
  const [activeFilter, setActiveFilter] = useState('All');
  const [isPullRefreshing, setIsPullRefreshing] = useState(false);
  const isOnline = Boolean(netInfo.isConnected && netInfo.isInternetReachable !== false);

  const conversationsQuery = useQuery({
    queryKey: ['chat', authRecord.id, 'conversations'],
    queryFn: () => listLocalConversations(authRecord.id),
  });
  const fileTokenQuery = useQuery({
    queryKey: ['file-token', authRecord.id],
    queryFn: () => pb.files.getToken(),
    staleTime: 1000 * 60 * 5,
  });
  const activeCallsQuery = useQuery({
    queryKey: ['active-calls', authRecord.id],
    queryFn: () => listActiveCalls(pb),
  });
  const readStatesQuery = useQuery({
    queryKey: ['chat', authRecord.id, 'conversation-states'],
    queryFn: () => listLocalConversationStates(authRecord.id),
  });
  const conversations = conversationsQuery.data ?? [];
  const readStates = readStatesQuery.data ?? [];
  const unreadCounts = useMemo(() => {
    const counts: Record<string, number> = {};

    for (const state of readStates) {
      if (state.user === authRecord.id) {
        counts[state.conversation] = state.unread_count ?? 0;
      }
    }

    return counts;
  }, [authRecord.id, readStates]);
  const activeCallByConversation = useMemo(() => {
    const calls = new Map<string, CallRoomRecord>();

    for (const callRoom of activeCallsQuery.data ?? []) {
      if (!calls.has(callRoom.conversation)) {
        calls.set(callRoom.conversation, callRoom);
      }
    }

    return calls;
  }, [activeCallsQuery.data]);
  const relatedUserIds = useMemo(() => {
    const ids = new Set<string>();

    for (const conversation of conversations) {
      for (const memberId of conversation.members) {
        if (memberId !== authRecord.id) {
          ids.add(memberId);
        }
      }
    }

    return [...ids].sort();
  }, [authRecord.id, conversations]);
  const profilesQuery = useQuery({
    queryKey: ['profiles', 'chat-members', relatedUserIds],
    queryFn: () => listCachedProfilesByUserIds(pb, relatedUserIds),
    enabled: relatedUserIds.length > 0,
    networkMode: 'always',
  });
  const profilesByUserId = useMemo(() => {
    const profiles = new Map<string, ProfileRecord>();

    for (const profile of profilesQuery.data ?? []) {
      profiles.set(profile.user, profile);
    }

    return profiles;
  }, [profilesQuery.data]);
  const conversationViews = useMemo(
    () =>
      conversations.map((conversation) =>
        toConversationView(
          conversation,
          profilesByUserId,
          authRecord.id,
          fileTokenQuery.data,
          activeCallByConversation.get(conversation.id),
          unreadCounts[conversation.id] ?? 0,
        ),
      ),
    [
      authRecord.id,
      activeCallByConversation,
      conversations,
      fileTokenQuery.data,
      profilesByUserId,
      unreadCounts,
    ],
  );
  const visibleConversations = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();

    return conversationViews.filter((conversation) => {
      if (activeFilter === 'Unread' && conversation.unread === 0) {
        return false;
      }
      if (activeFilter === 'Groups' && conversation.kind !== 'group') {
        return false;
      }
      if (!normalizedQuery) {
        return true;
      }

      return conversation.name.toLowerCase().includes(normalizedQuery);
    });
  }, [activeFilter, conversationViews, query]);
  const isLoading = conversationsQuery.isLoading && conversations.length === 0;
  const hasError = conversationsQuery.isError && conversations.length === 0;

  useEffect(() => {
    if (!isOnline || relatedUserIds.length === 0) {
      return;
    }

    let isMounted = true;

    void refreshCachedProfilesByUserIds(pb, relatedUserIds)
      .then((profiles) => {
        if (isMounted) {
          queryClient.setQueryData(['profiles', 'chat-members', relatedUserIds], profiles);
        }
      })
      .catch(() => {
        // Names and avatars from local cache stay visible until the next refresh.
      });

    return () => {
      isMounted = false;
    };
  }, [isOnline, queryClient, relatedUserIds]);

  const handleRefresh = async () => {
    if (isPullRefreshing) {
      return;
    }

    setIsPullRefreshing(true);
    try {
      const [, nextProfiles] = await Promise.all([
        chatSyncService.syncNow('manual'),
        relatedUserIds.length > 0
          ? refreshCachedProfilesByUserIds(pb, relatedUserIds)
          : Promise.resolve([]),
        queryClient.invalidateQueries({ queryKey: ['active-calls'] }),
      ]);

      await queryClient.invalidateQueries({
        queryKey: ['chat', authRecord.id],
      });
      if (relatedUserIds.length > 0) {
        queryClient.setQueryData(['profiles', 'chat-members', relatedUserIds], nextProfiles);
      }
    } finally {
      setIsPullRefreshing(false);
    }
  };

  const titleHeight = scrollY.interpolate({
    inputRange: [0, 84],
    outputRange: [TITLE_HEIGHT, 0],
    extrapolate: 'clamp',
  });
  const titleMarginBottom = scrollY.interpolate({
    inputRange: [0, 84],
    outputRange: [TITLE_MARGIN_BOTTOM, 0],
    extrapolate: 'clamp',
  });
  const searchHeight = scrollY.interpolate({
    inputRange: [0, SEARCH_HEIGHT],
    outputRange: [SEARCH_HEIGHT, 0],
    extrapolate: 'clamp',
  });
  const searchOpacity = scrollY.interpolate({
    inputRange: [0, SEARCH_HEIGHT / 2],
    outputRange: [1, 0],
    extrapolate: 'clamp',
  });
  const searchMarginBottom = scrollY.interpolate({
    inputRange: [0, SEARCH_HEIGHT, SEARCH_HEIGHT + SEARCH_MARGIN_MAX - SEARCH_MARGIN_MIN],
    outputRange: [SEARCH_MARGIN_MAX, SEARCH_MARGIN_MAX, SEARCH_MARGIN_MIN],
    extrapolate: 'clamp',
  });
  const titleScale = scrollY.interpolate({
    inputRange: [0, 84],
    outputRange: [1, 0.96],
    extrapolate: 'clamp',
  });
  const titleOpacity = scrollY.interpolate({
    inputRange: [0, 56],
    outputRange: [1, 0],
    extrapolate: 'clamp',
  });
  const compactTitleOpacity = scrollY.interpolate({
    inputRange: [52, 96],
    outputRange: [0, 1],
    extrapolate: 'clamp',
  });
  const topSearchOpacity = scrollY.interpolate({
    inputRange: [16, 64],
    outputRange: [0, 1],
    extrapolate: 'clamp',
  });
  const topSearchScale = scrollY.interpolate({
    inputRange: [16, 64],
    outputRange: [0.86, 1],
    extrapolate: 'clamp',
  });

  const handleScroll = Animated.event([{ nativeEvent: { contentOffset: { y: scrollY } } }], {
    listener: ({ nativeEvent }: { nativeEvent: { contentOffset: { y: number } } }) => {
      scrollYValue.current = nativeEvent.contentOffset.y;
    },
    useNativeDriver: false,
  });

  const revealSearch = () => {
    Animated.timing(scrollY, {
      toValue: 0,
      duration: 180,
      useNativeDriver: false,
    }).start(() => {
      scrollYValue.current = 0;
      searchRef.current?.focus();
    });
    scrollViewRef.current?.scrollTo({ animated: true, y: 0 });
  };

  return (
    <View className="flex-1 bg-background">
      <Animated.View
        className="absolute left-0 right-0 z-10 border-border/60 bg-background/95"
        onLayout={({ nativeEvent }) =>
          setHeaderHeight((currentHeight) => Math.max(currentHeight, nativeEvent.layout.height))
        }
        style={[styles.header, { paddingTop: insets.top }]}
      >
        <View className="flex-row items-center justify-between" style={{ height: TOP_BAR_HEIGHT }}>
          <Animated.Text
            className="text-xl font-bold text-foreground"
            style={{ opacity: compactTitleOpacity }}
          >
            Chat
          </Animated.Text>

          <View className="flex-row items-center gap-3">
            <RoundIcon
              animatedStyle={{
                opacity: topSearchOpacity,
                transform: [{ scale: topSearchScale }],
              }}
              name="search"
              onPress={revealSearch}
            />
            <RoundIcon isPrimary name="add" onPress={() => router.push('/friends')} />
          </View>
        </View>

        <Animated.View
          className="overflow-hidden"
          style={{ height: titleHeight, marginBottom: titleMarginBottom }}
        >
          <Animated.Text
            className="text-[40px] font-bold tracking-[-1.6px] text-foreground"
            style={{
              opacity: titleOpacity,
              transform: [{ scale: titleScale }],
              transformOrigin: 'left',
            }}
          >
            Chat
          </Animated.Text>
        </Animated.View>

        <Animated.View
          className="overflow-hidden rounded-full bg-muted"
          style={[styles.search, { height: searchHeight, marginBottom: searchMarginBottom }]}
        >
          <Animated.View className="h-full justify-center" style={{ opacity: searchOpacity }}>
            <Ionicons color="#64748b" name="search" size={18} style={styles.searchIcon} />
            <TextInput
              className="h-full px-11 text-[17px] text-foreground"
              onChangeText={setQuery}
              placeholder="Search"
              placeholderTextColor="#64748b"
              ref={searchRef}
              selectionColor="#f8fafc"
              value={query}
            />
          </Animated.View>
        </Animated.View>

        <View className="flex-row items-center gap-2">
          {filters.map((filter) => {
            const isActive = activeFilter === filter;

            return (
              <Pressable
                className={`h-9 items-center justify-center rounded-full px-4 ${
                  isActive ? 'bg-foreground' : 'bg-muted'
                }`}
                key={filter}
                onPress={() => setActiveFilter(filter)}
              >
                <Text
                  className={`text-sm font-semibold ${isActive ? 'text-background' : 'text-muted-foreground'}`}
                >
                  {filter}
                </Text>
              </Pressable>
            );
          })}
        </View>
      </Animated.View>

      <Animated.ScrollView
        className="flex-1"
        contentContainerStyle={{
          paddingTop: headerHeight + 8,
          paddingBottom: Math.max(insets.bottom, 16) + 48,
          paddingHorizontal: HEADER_SIDE_PADDING,
        }}
        onScroll={handleScroll}
        refreshControl={
          <RefreshControl
            colors={['#f8fafc']}
            onRefresh={handleRefresh}
            refreshing={isPullRefreshing}
            tintColor="#f8fafc"
          />
        }
        ref={scrollViewRef}
        scrollEventThrottle={16}
        showsVerticalScrollIndicator={false}
      >
        {hasError ? (
          <EmptyState icon="cloud-offline" title="Could not load chats" />
        ) : isLoading ? (
          <EmptyState icon="chatbubbles" title="Loading chats" />
        ) : visibleConversations.length ? (
          visibleConversations.map((conversation, index) => (
            <ConversationRow conversation={conversation} index={index} key={conversation.id} />
          ))
        ) : (
          <EmptyState icon="chatbubble-ellipses" title="No chats yet" />
        )}
      </Animated.ScrollView>
    </View>
  );
}

function toConversationView(
  conversation: ConversationRecord,
  profilesByUserId: Map<string, ProfileRecord>,
  currentUserId: string,
  fileToken?: string,
  activeCall?: CallRoomRecord,
  unread = 0,
): ConversationView {
  const otherMemberIds = conversation.members.filter((memberId) => memberId !== currentUserId);
  const otherProfiles = otherMemberIds
    .map((memberId) => profilesByUserId.get(memberId))
    .filter((profile): profile is ProfileRecord => Boolean(profile));
  const firstProfile = otherProfiles[0];
  const fallbackName =
    conversation.kind === 'group' ? conversation.title || 'Group chat' : 'Private chat';
  const name =
    conversation.kind === 'group'
      ? conversation.title ||
        otherProfiles.map((profile) => profile.display_name).join(', ') ||
        fallbackName
      : firstProfile?.display_name || firstProfile?.username || fallbackName;

  return {
    id: conversation.id,
    kind: conversation.kind,
    name,
    message: conversation.last_message_text || 'No messages yet',
    time: formatConversationTime(conversation.last_message_at || conversation.updated),
    unread,
    subtitle: conversation.kind === 'group' ? `${conversation.members.length} members` : 'friend',
    avatarUrl: firstProfile ? getProfileAvatarUrl(pb, firstProfile, fileToken) : null,
    avatarUserId: firstProfile?.user || conversation.id,
    avatarUsername: firstProfile?.username || name,
    activeCall,
    members: otherProfiles.map((profile) => profile.display_name || profile.username),
  };
}

function formatConversationTime(value?: string): string {
  if (!value) {
    return '';
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return '';
  }

  const now = new Date();
  const isToday = date.toDateString() === now.toDateString();
  if (isToday) {
    return date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  }

  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (date.toDateString() === yesterday.toDateString()) {
    return 'Yesterday';
  }

  return date.toLocaleDateString([], { weekday: 'short' });
}

function RoundIcon({
  animatedStyle,
  isPrimary,
  name,
  onPress,
}: {
  animatedStyle?: Animated.WithAnimatedValue<ViewStyle>;
  isPrimary?: boolean;
  name: keyof typeof Ionicons.glyphMap;
  onPress?: () => void;
}) {
  return (
    <AnimatedPressable
      className={`h-10 w-10 items-center justify-center rounded-full ${isPrimary ? 'bg-foreground' : 'bg-muted'}`}
      onPress={onPress}
      style={animatedStyle}
    >
      <Ionicons color={isPrimary ? '#080b12' : '#f8fafc'} name={name} size={22} />
    </AnimatedPressable>
  );
}

function ConversationRow({
  conversation,
  index,
}: {
  conversation: ConversationView;
  index: number;
}) {
  const opacity = useRef(new Animated.Value(0)).current;
  const translateY = useRef(new Animated.Value(14)).current;

  useEffect(() => {
    Animated.parallel([
      Animated.timing(opacity, {
        toValue: 1,
        duration: 280,
        delay: index * 35,
        useNativeDriver: true,
      }),
      Animated.timing(translateY, {
        toValue: 0,
        duration: 280,
        delay: index * 35,
        useNativeDriver: true,
      }),
    ]).start();
  }, [index, opacity, translateY]);

  return (
    <AnimatedPressable
      className="mb-3 flex-row items-center gap-3"
      onPress={() => router.push({ pathname: '/chat/[id]', params: { id: conversation.id } })}
      style={{ opacity, transform: [{ translateY }] }}
    >
      <ProfileAvatar
        avatarUrl={conversation.avatarUrl}
        name={conversation.name}
        size={56}
        userId={conversation.avatarUserId}
        username={conversation.avatarUsername}
      />

      <View className="min-w-0 flex-1 border-b border-border/60 pb-3">
        <View className="flex-row items-center justify-between gap-3">
          <Text className="flex-1 text-lg font-semibold text-foreground" numberOfLines={1}>
            {conversation.name}
          </Text>
          <Text className="text-xs font-medium text-muted-foreground">{conversation.time}</Text>
        </View>
        <View className="mt-1 flex-row items-center justify-between gap-3">
          <Text className="flex-1 text-[15px] text-muted-foreground" numberOfLines={1}>
            {conversation.message}
          </Text>
          {conversation.activeCall ? (
            <View
              className={`flex-row items-center gap-1 rounded-full px-2.5 py-1 ${
                conversation.activeCall.status === 'active'
                  ? 'bg-emerald-400/15'
                  : 'bg-amber-400/15'
              }`}
            >
              <Ionicons
                color={conversation.activeCall.status === 'active' ? '#34d399' : '#fbbf24'}
                name={conversation.activeCall.kind === 'video' ? 'videocam' : 'call'}
                size={12}
              />
              <Text
                className={`text-[11px] font-black ${
                  conversation.activeCall.status === 'active'
                    ? 'text-emerald-300'
                    : 'text-amber-300'
                }`}
              >
                {conversation.activeCall.status === 'active' ? 'In call' : 'Ringing'}
              </Text>
            </View>
          ) : conversation.unread > 0 ? (
            <View className="h-6 min-w-6 items-center justify-center rounded-full bg-primary px-2">
              <Text className="text-xs font-bold text-primary-foreground">
                {conversation.unread}
              </Text>
            </View>
          ) : null}
        </View>
      </View>
    </AnimatedPressable>
  );
}

function EmptyState({ icon, title }: { icon: keyof typeof Ionicons.glyphMap; title: string }) {
  return (
    <View className="mt-16 items-center">
      <View className="h-16 w-16 items-center justify-center rounded-full bg-muted">
        <Ionicons color="#64748b" name={icon} size={28} />
      </View>
      <Text className="mt-4 text-lg font-bold text-foreground">{title}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  header: {
    paddingHorizontal: HEADER_SIDE_PADDING,
    paddingBottom: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  search: {
    borderCurve: 'continuous',
  },
  searchIcon: {
    left: 16,
    position: 'absolute',
  },
});
