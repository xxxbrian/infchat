import Ionicons from '@expo/vector-icons/Ionicons';
import {
  type CallRoomRecord,
  type ConversationMembershipRecord,
  type ConversationRecord,
  type FriendshipRecord,
  getProfileAvatarUrl,
  listActiveCalls,
  type ProfileRecord,
  startPrivateConversationCommand,
} from '@infchat/pocketbase';
import { useNetInfo } from '@react-native-community/netinfo';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { router } from 'expo-router';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  Animated,
  Keyboard,
  Modal,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  useWindowDimensions,
  View,
  type ViewStyle,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { ProfileAvatar } from '../../components/ProfileAvatar';
import { ConversationAvatar } from '../../components/ConversationAvatar';
import { useAuth } from '../../lib/auth-context';
import { useChatSyncService } from '../../lib/chat-sync-context';
import { listLocalConversations, listLocalMemberships } from '../../lib/chat-sync-store';
import {
  listCachedFriendships,
  listCachedProfilesByUserIds,
  refreshCachedFriendships,
  refreshCachedProfilesByUserIds,
} from '../../lib/local-cache';
import { pb } from '../../lib/pocketbase';

type ConversationView = {
  id: string;
  kind: ConversationRecord['kind'];
  conversation: ConversationRecord;
  name: string;
  message: string;
  time: string;
  unread: number;
  subtitle: string;
  avatarUrl?: string | null;
  avatarUserId: string;
  avatarUsername: string;
  activeCall?: CallRoomRecord;
};

type NewMessagePerson = {
  avatarUrl?: string | null;
  id: string;
  name: string;
  note: string;
  userId: string;
  username: string;
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
  const [isNewMessageSheetVisible, setIsNewMessageSheetVisible] = useState(false);
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
  const membershipsQuery = useQuery({
    queryKey: ['chat', authRecord.id, 'memberships'],
    queryFn: () => listLocalMemberships(authRecord.id),
  });
  const conversations = conversationsQuery.data ?? [];
  const memberships = membershipsQuery.data ?? [];
  const membershipsByConversation = useMemo(
    () => groupMembershipsByConversation(memberships),
    [memberships],
  );
  const unreadCounts = useMemo(() => {
    const counts: Record<string, number> = {};

    for (const conversation of conversations) {
      const currentMembership = membershipsByConversation
        .get(conversation.id)
        ?.find((membership) => membership.user === authRecord.id && membership.status === 'active');
      if (currentMembership) {
        counts[conversation.id] = Math.max(
          0,
          (conversation.last_message_seq ?? 0) - (currentMembership.last_read_message_seq ?? 0),
        );
      }
    }

    return counts;
  }, [authRecord.id, conversations, membershipsByConversation]);
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
      for (const membership of membershipsByConversation.get(conversation.id) ?? []) {
        if (membership.status === 'active' && membership.user !== authRecord.id) {
          ids.add(membership.user);
        }
      }
    }

    return [...ids].sort();
  }, [authRecord.id, conversations, membershipsByConversation]);
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
          membershipsByConversation.get(conversation.id) ?? [],
        ),
      ),
    [
      authRecord.id,
      activeCallByConversation,
      conversations,
      fileTokenQuery.data,
      profilesByUserId,
      unreadCounts,
      membershipsByConversation,
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
    if (!isOnline) {
      return;
    }

    let isMounted = true;

    void chatSyncService
      .syncNow('manual')
      .then(() => {
        if (isMounted) {
          void queryClient.invalidateQueries({
            queryKey: ['chat', authRecord.id],
          });
        }
      })
      .catch(() => {
        // Foreground/reconnect hints will retry if the initial list sync fails.
      });

    return () => {
      isMounted = false;
    };
  }, [authRecord.id, chatSyncService, isOnline, queryClient]);

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
            <RoundIcon isPrimary name="add" onPress={() => setIsNewMessageSheetVisible(true)} />
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
            <ConversationRow
              conversation={conversation}
              fileToken={fileTokenQuery.data}
              index={index}
              key={conversation.id}
            />
          ))
        ) : (
          <EmptyState icon="chatbubble-ellipses" title="No chats yet" />
        )}
      </Animated.ScrollView>

      <NewMessageSheet
        currentUserId={authRecord.id}
        onClose={() => setIsNewMessageSheetVisible(false)}
        visible={isNewMessageSheetVisible}
      />
    </View>
  );
}

function NewMessageSheet({
  currentUserId,
  onClose,
  visible,
}: {
  currentUserId: string;
  onClose: () => void;
  visible: boolean;
}) {
  const chatSyncService = useChatSyncService();
  const queryClient = useQueryClient();
  const netInfo = useNetInfo();
  const insets = useSafeAreaInsets();
  const { height: windowHeight } = useWindowDimensions();
  const searchRef = useRef<TextInput>(null);
  const [query, setQuery] = useState('');
  const isOnline = Boolean(netInfo.isConnected && netInfo.isInternetReachable !== false);

  const friendshipsQuery = useQuery({
    queryKey: ['friendships', currentUserId, 'new-message'],
    queryFn: () => listCachedFriendships(pb),
    enabled: visible,
    networkMode: 'always',
  });
  const fileTokenQuery = useQuery({
    queryKey: ['file-token', currentUserId],
    queryFn: () => pb.files.getToken(),
    staleTime: 1000 * 60 * 5,
  });
  const friendUserIds = useMemo(
    () => getAcceptedFriendUserIds(friendshipsQuery.data ?? [], currentUserId),
    [currentUserId, friendshipsQuery.data],
  );
  const profilesQuery = useQuery({
    queryKey: ['profiles', 'new-message-friends', friendUserIds],
    queryFn: () => listCachedProfilesByUserIds(pb, friendUserIds),
    enabled: visible && friendUserIds.length > 0,
    networkMode: 'always',
  });
  const people = useMemo(
    () => toNewMessagePeople(profilesQuery.data ?? [], fileTokenQuery.data),
    [fileTokenQuery.data, profilesQuery.data],
  );
  const visiblePeople = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    if (!normalizedQuery) {
      return people;
    }

    return people.filter(
      (person) =>
        person.name.toLowerCase().includes(normalizedQuery) ||
        person.username.toLowerCase().includes(normalizedQuery),
    );
  }, [people, query]);

  const startPrivateChatMutation = useMutation({
    mutationFn: (recipientUserId: string) => startPrivateConversationCommand(pb, recipientUserId),
    onSuccess: async (response) => {
      await chatSyncService.applyConversationStart(response);
      await chatSyncService.syncNow('manual');
      await queryClient.invalidateQueries({
        queryKey: ['chat', currentUserId],
      });
      onClose();
      router.push({
        pathname: '/chat/[id]',
        params: { id: response.conversation.id },
      });
    },
    onError: (error) => {
      Alert.alert(
        'Could not open chat',
        getErrorMessage(error, 'Check your connection and try again.'),
      );
    },
  });

  useEffect(() => {
    if (!visible) {
      setQuery('');
      return;
    }

    const focusTimer = setTimeout(() => searchRef.current?.focus(), 280);
    return () => clearTimeout(focusTimer);
  }, [visible]);

  useEffect(() => {
    if (!visible || !isOnline) {
      return;
    }

    let isMounted = true;
    void refreshCachedFriendships(pb)
      .then((friendships) => {
        if (isMounted) {
          queryClient.setQueryData(['friendships', currentUserId, 'new-message'], friendships);
        }
      })
      .catch(() => {
        // Cached friends stay usable while the network recovers.
      });

    return () => {
      isMounted = false;
    };
  }, [currentUserId, isOnline, queryClient, visible]);

  useEffect(() => {
    if (!visible || !isOnline || friendUserIds.length === 0) {
      return;
    }

    let isMounted = true;
    void refreshCachedProfilesByUserIds(pb, friendUserIds)
      .then((profiles) => {
        if (isMounted) {
          queryClient.setQueryData(['profiles', 'new-message-friends', friendUserIds], profiles);
        }
      })
      .catch(() => {
        // Local profile cache is enough for the compose sheet.
      });

    return () => {
      isMounted = false;
    };
  }, [friendUserIds, isOnline, queryClient, visible]);

  const handleClose = () => {
    Keyboard.dismiss();
    onClose();
  };

  const handleNewGroup = () => {
    handleClose();
    router.push('/chat/new-group');
  };

  const handleAddFriend = () => {
    handleClose();
    router.push('/friends');
  };

  return (
    <Modal
      animationType="slide"
      onRequestClose={handleClose}
      presentationStyle="overFullScreen"
      transparent
      visible={visible}
    >
      <Pressable className="flex-1 justify-end bg-black/45" onPress={handleClose}>
        <Pressable
          className="overflow-hidden rounded-t-[34px] bg-background"
          onPress={(event) => event.stopPropagation()}
          style={{
            maxHeight: windowHeight * 0.92,
            minHeight: windowHeight * 0.72,
          }}
        >
          <View className="px-5 pb-3" style={{ paddingTop: 16 }}>
            <View className="mb-5 h-1.5 w-12 self-center rounded-full bg-border" />
            <View className="h-12 flex-row items-center justify-center">
              <Pressable
                className="absolute left-0 h-12 w-12 items-center justify-center rounded-full bg-muted"
                onPress={handleClose}
              >
                <Ionicons color="#f8fafc" name="close" size={28} />
              </Pressable>
              <Text className="text-2xl font-black text-foreground">New Message</Text>
            </View>

            <View className="mt-5 h-12 flex-row items-center rounded-full bg-muted px-4">
              <Ionicons color="#64748b" name="search" size={20} />
              <TextInput
                autoCapitalize="none"
                autoCorrect={false}
                className="h-full min-w-0 flex-1 px-3 text-[17px] text-foreground"
                onChangeText={setQuery}
                placeholder="Search"
                placeholderTextColor="#64748b"
                ref={searchRef}
                returnKeyType="search"
                selectionColor="#f8fafc"
                value={query}
              />
              {query ? (
                <Pressable
                  className="h-7 w-7 items-center justify-center rounded-full bg-background/60"
                  onPress={() => setQuery('')}
                >
                  <Ionicons color="#94a3b8" name="close" size={16} />
                </Pressable>
              ) : null}
            </View>
          </View>

          <ScrollView
            contentContainerStyle={{
              paddingBottom: Math.max(insets.bottom, 16) + 16,
            }}
            keyboardDismissMode="on-drag"
            keyboardShouldPersistTaps="handled"
            onScrollBeginDrag={Keyboard.dismiss}
            showsVerticalScrollIndicator={false}
          >
            <View className="px-5">
              <ComposeAction icon="people-outline" label="New Group" onPress={handleNewGroup} />
              <ComposeAction
                icon="person-add-outline"
                label="Add Friend"
                onPress={handleAddFriend}
              />
            </View>

            <View className="mt-2 px-5">
              {friendshipsQuery.isLoading && people.length === 0 ? (
                <SheetEmptyState icon="people" title="Loading friends" />
              ) : visiblePeople.length ? (
                visiblePeople.map((person) => (
                  <NewMessagePersonRow
                    disabled={startPrivateChatMutation.isPending}
                    key={person.userId}
                    onPress={() => startPrivateChatMutation.mutate(person.userId)}
                    person={person}
                  />
                ))
              ) : (
                <SheetEmptyState
                  icon="search"
                  title={query ? 'No matching friends' : 'No friends yet'}
                />
              )}
            </View>
          </ScrollView>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

function ComposeAction({
  icon,
  label,
  onPress,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  onPress: () => void;
}) {
  return (
    <Pressable className="min-h-[58px] flex-row items-center gap-4" onPress={onPress}>
      <View className="h-11 w-11 items-center justify-center rounded-full bg-primary/15">
        <Ionicons color="#60a5fa" name={icon} size={25} />
      </View>
      <View className="min-h-[58px] min-w-0 flex-1 justify-center border-b border-border/60">
        <Text className="text-lg font-semibold text-primary">{label}</Text>
      </View>
    </Pressable>
  );
}

function NewMessagePersonRow({
  disabled,
  onPress,
  person,
}: {
  disabled: boolean;
  onPress: () => void;
  person: NewMessagePerson;
}) {
  return (
    <Pressable
      className="min-h-[66px] flex-row items-center gap-3"
      disabled={disabled}
      onPress={onPress}
    >
      <ProfileAvatar
        avatarUrl={person.avatarUrl}
        name={person.name}
        size={48}
        userId={person.userId}
        username={person.username}
      />
      <View className="min-h-[66px] min-w-0 flex-1 justify-center border-b border-border/60">
        <Text className="text-[17px] font-semibold text-foreground" numberOfLines={1}>
          {person.name}
        </Text>
        <Text className="mt-0.5 text-[14px] font-medium text-muted-foreground" numberOfLines={1}>
          {person.note}
        </Text>
      </View>
    </Pressable>
  );
}

function SheetEmptyState({ icon, title }: { icon: keyof typeof Ionicons.glyphMap; title: string }) {
  return (
    <View className="items-center py-14">
      <View className="h-14 w-14 items-center justify-center rounded-full bg-muted">
        <Ionicons color="#64748b" name={icon} size={25} />
      </View>
      <Text className="mt-3 text-base font-bold text-muted-foreground">{title}</Text>
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
  memberships: ConversationMembershipRecord[] = [],
): ConversationView {
  const activeMemberIds = memberships
    .filter((membership) => membership.status === 'active')
    .map((membership) => membership.user);
  const otherMemberIds = activeMemberIds.filter((memberId) => memberId !== currentUserId);
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
    conversation,
    name,
    message: conversation.last_message_text || 'No messages yet',
    time: formatConversationTime(conversation.last_message_at || conversation.updated),
    unread,
    subtitle:
      conversation.kind === 'group'
        ? `${conversation.member_count ?? activeMemberIds.length} members`
        : 'friend',
    avatarUrl: firstProfile ? getProfileAvatarUrl(pb, firstProfile, fileToken, 'thumb') : null,
    avatarUserId: firstProfile?.user || conversation.id,
    avatarUsername: firstProfile?.username || name,
    activeCall,
  };
}

function getAcceptedFriendUserIds(
  friendships: FriendshipRecord[],
  currentUserId: string,
): string[] {
  const ids = new Set<string>();

  for (const friendship of friendships) {
    if (friendship.status !== 'accepted') {
      continue;
    }

    ids.add(friendship.requester === currentUserId ? friendship.recipient : friendship.requester);
  }

  return [...ids].sort();
}

function toNewMessagePeople(profiles: ProfileRecord[], fileToken?: string): NewMessagePerson[] {
  return profiles
    .map((profile) => {
      const name = profile.display_name || profile.username;

      return {
        avatarUrl: getProfileAvatarUrl(pb, profile, fileToken, 'thumb'),
        id: profile.id,
        name,
        note: `@${profile.username}`,
        userId: profile.user,
        username: profile.username,
      };
    })
    .sort((left, right) => left.name.localeCompare(right.name));
}

function groupMembershipsByConversation(memberships: ConversationMembershipRecord[]) {
  const grouped = new Map<string, ConversationMembershipRecord[]>();
  for (const membership of memberships) {
    const current = grouped.get(membership.conversation) ?? [];
    current.push(membership);
    grouped.set(membership.conversation, current);
  }

  return grouped;
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

function getErrorMessage(error: unknown, fallback: string): string {
  if (error && typeof error === 'object' && 'message' in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === 'string' && message.trim()) {
      return message;
    }
  }

  return fallback;
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
  fileToken,
  index,
}: {
  conversation: ConversationView;
  fileToken?: string;
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
      <ConversationAvatar
        conversation={conversation.conversation}
        fileToken={fileToken}
        name={conversation.name}
        privateProfile={{
          avatarUrl: conversation.avatarUrl,
          name: conversation.name,
          userId: conversation.avatarUserId,
          username: conversation.avatarUsername,
        }}
        size={56}
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
