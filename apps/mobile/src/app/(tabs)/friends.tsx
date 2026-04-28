import Ionicons from '@expo/vector-icons/Ionicons';
import {
  acceptFriendRequest,
  cancelFriendRequest,
  declineFriendRequest,
  listFriendships,
  listProfilesByUserIds,
  searchProfilesByUsername,
  sendFriendRequest,
  type FriendshipRecord,
  type ProfileRecord,
} from '@infchat/pocketbase';
import { getAvatarColor, getAvatarInitial, normalizeUsername } from '@infchat/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Animated,
  Keyboard,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  type ViewStyle,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useAuth } from '../../lib/auth-context';
import { pb } from '../../lib/pocketbase';

type FriendStatus = 'friend' | 'incoming' | 'pending' | 'none';
type FriendFilter = 'Friends' | 'Requests' | 'Find';

type Person = {
  id: string;
  userId: string;
  friendshipId?: string;
  name: string;
  username: string;
  accent: string;
  status: FriendStatus;
  note: string;
};

const HEADER_SIDE_PADDING = 20;
const TOP_BAR_HEIGHT = 48;
const TITLE_HEIGHT = 52;
const SEARCH_HEIGHT = 40;
const SEARCH_MARGIN_MAX = 14;
const SEARCH_MARGIN_MIN = 8;
const filters: FriendFilter[] = ['Friends', 'Requests', 'Find'];

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

export default function FriendsTab() {
  const { authRecord } = useAuth();
  const queryClient = useQueryClient();
  const insets = useSafeAreaInsets();
  const searchRef = useRef<TextInput>(null);
  const scrollViewRef = useRef<ScrollView>(null);
  const scrollY = useRef(new Animated.Value(0)).current;
  const scrollYValue = useRef(0);
  const [headerHeight, setHeaderHeight] = useState(0);
  const [activeFilter, setActiveFilter] = useState<FriendFilter>('Friends');
  const [isSearchFocused, setIsSearchFocused] = useState(false);
  const [query, setQuery] = useState('');

  const currentUserId = authRecord.id;
  const normalizedQuery = normalizeUsername(query);
  const shouldSearchProfiles = activeFilter === 'Find' && normalizedQuery.length >= 3;

  const friendshipsQuery = useQuery({
    queryKey: ['friendships', currentUserId],
    queryFn: () => listFriendships(pb),
  });
  const friendships = friendshipsQuery.data ?? [];

  const relatedUserIds = useMemo(() => {
    const ids = new Set<string>();

    for (const friendship of friendships) {
      if (friendship.status !== 'accepted' && friendship.status !== 'pending') {
        continue;
      }

      ids.add(friendship.requester === currentUserId ? friendship.recipient : friendship.requester);
    }

    return [...ids].sort();
  }, [currentUserId, friendships]);

  const relatedProfilesQuery = useQuery({
    queryKey: ['profiles', 'related', relatedUserIds],
    queryFn: () => listProfilesByUserIds(pb, relatedUserIds),
    enabled: relatedUserIds.length > 0,
  });

  const searchProfilesQuery = useQuery({
    queryKey: ['profiles', 'search', normalizedQuery],
    queryFn: () => searchProfilesByUsername(pb, normalizedQuery),
    enabled: shouldSearchProfiles,
  });

  const activeFriendshipByUserId = useMemo(() => {
    const friendshipsByUserId = new Map<string, FriendshipRecord>();

    for (const friendship of friendships) {
      if (friendship.status !== 'accepted' && friendship.status !== 'pending') {
        continue;
      }

      const otherUserId =
        friendship.requester === currentUserId ? friendship.recipient : friendship.requester;
      if (!friendshipsByUserId.has(otherUserId)) {
        friendshipsByUserId.set(otherUserId, friendship);
      }
    }

    return friendshipsByUserId;
  }, [currentUserId, friendships]);

  const peopleByUserId = useMemo(() => {
    const people = new Map<string, Person>();

    for (const profile of relatedProfilesQuery.data ?? []) {
      people.set(
        profile.user,
        toPerson(profile, activeFriendshipByUserId.get(profile.user), currentUserId),
      );
    }

    return people;
  }, [activeFriendshipByUserId, currentUserId, relatedProfilesQuery.data]);

  const friends = useMemo(
    () => [...peopleByUserId.values()].filter((person) => person.status === 'friend'),
    [peopleByUserId],
  );
  const incoming = useMemo(
    () => [...peopleByUserId.values()].filter((person) => person.status === 'incoming'),
    [peopleByUserId],
  );
  const findPeople = useMemo(() => {
    if (!shouldSearchProfiles) {
      return [];
    }

    return (searchProfilesQuery.data ?? [])
      .map((profile) =>
        toPerson(profile, activeFriendshipByUserId.get(profile.user), currentUserId),
      )
      .filter((person) => person.status !== 'friend');
  }, [activeFriendshipByUserId, currentUserId, searchProfilesQuery.data, shouldSearchProfiles]);

  const searchablePeople = useMemo(() => {
    if (activeFilter === 'Find') {
      return findPeople;
    }

    if (activeFilter === 'Requests') {
      return incoming;
    }

    return friends;
  }, [activeFilter, findPeople, friends, incoming]);

  const visiblePeople = useMemo(() => {
    if (activeFilter === 'Find' || !normalizedQuery) {
      return searchablePeople;
    }

    return searchablePeople.filter(
      (person) =>
        person.name.toLowerCase().includes(normalizedQuery) ||
        person.username.includes(normalizedQuery),
    );
  }, [activeFilter, normalizedQuery, searchablePeople]);

  const refreshFriendships = () => {
    queryClient.invalidateQueries({ queryKey: ['friendships'] });
  };

  const sendRequestMutation = useMutation({
    mutationFn: (recipientUserId: string) => sendFriendRequest(pb, recipientUserId),
    onSuccess: refreshFriendships,
  });
  const acceptRequestMutation = useMutation({
    mutationFn: (friendshipId: string) => acceptFriendRequest(pb, friendshipId),
    onSuccess: refreshFriendships,
  });
  const declineRequestMutation = useMutation({
    mutationFn: (friendshipId: string) => declineFriendRequest(pb, friendshipId),
    onSuccess: refreshFriendships,
  });
  const cancelRequestMutation = useMutation({
    mutationFn: (friendshipId: string) => cancelFriendRequest(pb, friendshipId),
    onSuccess: refreshFriendships,
  });
  const isMutatingFriendship =
    sendRequestMutation.isPending ||
    acceptRequestMutation.isPending ||
    declineRequestMutation.isPending ||
    cancelRequestMutation.isPending;

  const titleHeight = scrollY.interpolate({
    inputRange: [0, 84],
    outputRange: [TITLE_HEIGHT, 0],
    extrapolate: 'clamp',
  });
  const titleOpacity = scrollY.interpolate({
    inputRange: [0, 52],
    outputRange: [1, 0],
    extrapolate: 'clamp',
  });
  const compactTitleOpacity = scrollY.interpolate({
    inputRange: [48, 88],
    outputRange: [0, 1],
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

  const setHeaderOffset = (nextOffset: number) => {
    scrollYValue.current = nextOffset;
    scrollY.setValue(nextOffset);
  };

  const handleScroll = ({
    nativeEvent,
  }: {
    nativeEvent: {
      contentOffset: { y: number };
      contentSize: { height: number };
      layoutMeasurement: { height: number };
    };
  }) => {
    const { contentOffset, contentSize, layoutMeasurement } = nativeEvent;
    const isScrollable = contentSize.height > layoutMeasurement.height + 1;

    if (!isScrollable && scrollYValue.current > 0) {
      return;
    }

    setHeaderOffset(contentOffset.y);
  };

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

  const openFind = () => {
    setActiveFilter('Find');
    setQuery('');
    requestAnimationFrame(() => searchRef.current?.focus());
  };

  const searchPlaceholder =
    activeFilter === 'Find'
      ? 'Search username'
      : activeFilter === 'Requests'
        ? 'Search requests'
        : 'Search friends';
  const getFilterCount = (filter: FriendFilter) => {
    if (filter === 'Friends') {
      return friends.length;
    }

    if (filter === 'Requests') {
      return incoming.length;
    }

    return findPeople.length;
  };
  const isLoading =
    friendshipsQuery.isLoading ||
    (relatedUserIds.length > 0 && relatedProfilesQuery.isLoading) ||
    (shouldSearchProfiles && searchProfilesQuery.isLoading);
  const hasError =
    friendshipsQuery.isError || relatedProfilesQuery.isError || searchProfilesQuery.isError;

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
            Friends
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
            <RoundIcon isPrimary name="person-add" onPress={openFind} />
          </View>
        </View>

        <Animated.View className="overflow-hidden" style={{ height: titleHeight }}>
          <Animated.Text
            className="text-[40px] font-bold tracking-[-1.6px] text-foreground"
            style={{ opacity: titleOpacity }}
          >
            Friends
          </Animated.Text>
        </Animated.View>

        <Animated.View
          className="overflow-hidden rounded-full bg-muted"
          style={[styles.search, { height: searchHeight, marginBottom: searchMarginBottom }]}
        >
          <Animated.View
            className="h-full flex-row items-center px-4"
            style={{ opacity: searchOpacity }}
          >
            <Ionicons color="#64748b" name="search" size={18} />
            <TextInput
              autoCapitalize="none"
              autoCorrect={false}
              className="h-full min-w-0 flex-1 px-3 text-[17px] text-foreground"
              onBlur={() => setIsSearchFocused(false)}
              onChangeText={setQuery}
              onFocus={() => setIsSearchFocused(true)}
              placeholder={searchPlaceholder}
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
          </Animated.View>
        </Animated.View>

        <View className="flex-row items-center gap-2">
          {filters.map((filter) => {
            const isActive = activeFilter === filter;
            const count = getFilterCount(filter);

            return (
              <Pressable
                className={`h-9 flex-row items-center justify-center gap-2 rounded-full pl-4 pr-2 ${isActive ? 'bg-foreground' : 'bg-muted'}`}
                key={filter}
                onPress={() => {
                  setActiveFilter(filter);
                  setQuery('');
                  if (filter === 'Find' || isSearchFocused) {
                    requestAnimationFrame(() => searchRef.current?.focus());
                  }
                }}
              >
                <Text
                  className={`text-sm font-semibold ${isActive ? 'text-background' : 'text-muted-foreground'}`}
                >
                  {filter}
                </Text>
                <View
                  className={`h-5 min-w-5 items-center justify-center rounded-full px-1.5 ${isActive ? 'bg-background/15' : 'bg-background/60'}`}
                >
                  <Text
                    className={`text-[11px] font-bold ${isActive ? 'text-background' : 'text-muted-foreground'}`}
                  >
                    {count}
                  </Text>
                </View>
              </Pressable>
            );
          })}
        </View>
      </Animated.View>

      <Animated.ScrollView
        className="flex-1"
        contentContainerStyle={{
          paddingBottom: Math.max(insets.bottom, 16) + 48,
          paddingHorizontal: HEADER_SIDE_PADDING,
          paddingTop: headerHeight + 8,
        }}
        keyboardDismissMode="on-drag"
        keyboardShouldPersistTaps="handled"
        onScroll={handleScroll}
        onScrollBeginDrag={Keyboard.dismiss}
        onTouchStart={Keyboard.dismiss}
        ref={scrollViewRef}
        scrollEventThrottle={16}
        showsVerticalScrollIndicator={false}
      >
        {activeFilter === 'Friends' ? (
          <SectionTitle label={query ? 'Matching friends' : 'Friends'} />
        ) : null}
        {activeFilter === 'Requests' ? (
          <SectionTitle label={query ? 'Matching requests' : 'Friend requests'} />
        ) : null}
        {activeFilter === 'Find' ? <FindNotice queryLength={normalizedQuery.length} /> : null}

        {hasError ? (
          <EmptyState icon="cloud-offline" title="Could not load friends" />
        ) : isLoading ? (
          <EmptyState icon="people" title="Loading friends" />
        ) : visiblePeople.length ? (
          visiblePeople.map((person, index) => (
            <PersonRow
              index={index}
              isBusy={isMutatingFriendship}
              key={person.id}
              onAccept={() => {
                if (person.friendshipId) {
                  acceptRequestMutation.mutate(person.friendshipId);
                }
              }}
              onAdd={() => sendRequestMutation.mutate(person.userId)}
              onCancel={() => {
                if (person.friendshipId) {
                  cancelRequestMutation.mutate(person.friendshipId);
                }
              }}
              onDecline={() => {
                if (person.friendshipId) {
                  declineRequestMutation.mutate(person.friendshipId);
                }
              }}
              onDismissKeyboard={Keyboard.dismiss}
              person={person}
            />
          ))
        ) : (
          <EmptyState
            icon={activeFilter === 'Find' ? 'person-add' : 'search'}
            title={getEmptyTitle(activeFilter, normalizedQuery.length)}
          />
        )}
      </Animated.ScrollView>
    </View>
  );
}

function toPerson(
  profile: ProfileRecord,
  friendship: FriendshipRecord | undefined,
  currentUserId: string,
): Person {
  const name = profile.display_name || profile.username;
  const status = getFriendStatus(friendship, currentUserId);

  return {
    id: profile.id,
    userId: profile.user,
    friendshipId: friendship?.id,
    name,
    username: profile.username,
    accent: getAvatarColor(profile.user),
    status,
    note: getFriendNote(status),
  };
}

function getFriendStatus(
  friendship: FriendshipRecord | undefined,
  currentUserId: string,
): FriendStatus {
  if (!friendship) {
    return 'none';
  }

  if (friendship.status === 'accepted') {
    return 'friend';
  }

  if (friendship.status === 'pending') {
    return friendship.recipient === currentUserId ? 'incoming' : 'pending';
  }

  return 'none';
}

function getFriendNote(status: FriendStatus): string {
  if (status === 'friend') {
    return 'friend';
  }

  if (status === 'incoming') {
    return 'sent you a request';
  }

  if (status === 'pending') {
    return 'request sent';
  }

  return 'tap to add';
}

function getEmptyTitle(activeFilter: FriendFilter, queryLength: number): string {
  if (activeFilter === 'Find' && queryLength < 3) {
    return 'Type 3 letters';
  }

  if (activeFilter === 'Find') {
    return 'No one found';
  }

  return 'No matches';
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
      <Ionicons color={isPrimary ? '#080b12' : '#f8fafc'} name={name} size={21} />
    </AnimatedPressable>
  );
}

function FindNotice({ queryLength }: { queryLength: number }) {
  return (
    <View className="mb-3 rounded-[20px] bg-muted px-4 py-3">
      <Text className="text-sm font-semibold text-foreground">
        {queryLength >= 3 ? 'Search results' : 'Find by username'}
      </Text>
      <Text className="mt-0.5 text-xs font-medium text-muted-foreground">
        {queryLength >= 3 ? 'People outside your friends list.' : 'Enter at least 3 characters.'}
      </Text>
    </View>
  );
}

function SectionTitle({ label }: { label: string }) {
  return (
    <Text className="mb-2 mt-1 text-xs font-bold uppercase tracking-[1px] text-muted-foreground">
      {label}
    </Text>
  );
}

function PersonRow({
  index,
  isBusy,
  onAccept,
  onAdd,
  onCancel,
  onDecline,
  onDismissKeyboard,
  person,
}: {
  index: number;
  isBusy: boolean;
  onAccept: () => void;
  onAdd: () => void;
  onCancel: () => void;
  onDecline: () => void;
  onDismissKeyboard: () => void;
  person: Person;
}) {
  const opacity = useRef(new Animated.Value(0)).current;
  const translateY = useRef(new Animated.Value(10)).current;

  useEffect(() => {
    Animated.parallel([
      Animated.timing(opacity, {
        toValue: 1,
        duration: 220,
        delay: index * 20,
        useNativeDriver: true,
      }),
      Animated.timing(translateY, {
        toValue: 0,
        duration: 220,
        delay: index * 20,
        useNativeDriver: true,
      }),
    ]).start();
  }, [index, opacity, translateY]);

  return (
    <AnimatedPressable
      className="flex-row items-center gap-3"
      onPress={onDismissKeyboard}
      style={{ opacity, transform: [{ translateY }] }}
    >
      <Avatar person={person} />
      <View className="min-w-0 flex-1 border-b border-border/60 py-2.5">
        <View className="flex-row items-center gap-2">
          <Text
            className="min-w-0 flex-1 text-[16px] font-semibold text-foreground"
            numberOfLines={1}
          >
            {person.name}
          </Text>
          <FriendAction
            isBusy={isBusy}
            onAccept={onAccept}
            onAdd={onAdd}
            onCancel={onCancel}
            onDecline={onDecline}
            status={person.status}
          />
        </View>
        <Text className="mt-0.5 text-[13px] font-medium text-muted-foreground" numberOfLines={1}>
          @{person.username} · {person.note}
        </Text>
      </View>
    </AnimatedPressable>
  );
}

function Avatar({ person }: { person: Person }) {
  return (
    <View
      className="h-11 w-11 items-center justify-center rounded-full"
      style={{ backgroundColor: person.accent }}
    >
      <Text className="text-base font-bold text-background">
        {getAvatarInitial(person.name, person.username)}
      </Text>
    </View>
  );
}

function FriendAction({
  isBusy,
  onAccept,
  onAdd,
  onCancel,
  onDecline,
  status,
}: {
  isBusy: boolean;
  onAccept: () => void;
  onAdd: () => void;
  onCancel: () => void;
  onDecline: () => void;
  status: FriendStatus;
}) {
  if (status === 'friend') {
    return (
      <View className="h-8 w-8 items-center justify-center rounded-full bg-muted">
        <Ionicons color="#f8fafc" name="chatbubble" size={15} />
      </View>
    );
  }

  if (status === 'pending') {
    return (
      <Pressable
        className="h-8 items-center justify-center rounded-full bg-muted px-3"
        disabled={isBusy}
        onPress={onCancel}
      >
        <Text className="text-xs font-bold text-muted-foreground">Pending</Text>
      </Pressable>
    );
  }

  if (status === 'incoming') {
    return (
      <View className="flex-row items-center gap-2">
        <Pressable
          className="h-8 w-8 items-center justify-center rounded-full bg-muted"
          disabled={isBusy}
          onPress={onDecline}
        >
          <Ionicons color="#94a3b8" name="close" size={16} />
        </Pressable>
        <Pressable
          className="h-8 w-8 items-center justify-center rounded-full bg-foreground"
          disabled={isBusy}
          onPress={onAccept}
        >
          <Ionicons color="#080b12" name="checkmark" size={16} />
        </Pressable>
      </View>
    );
  }

  return (
    <Pressable
      className="h-8 w-8 items-center justify-center rounded-full bg-foreground"
      disabled={isBusy}
      onPress={onAdd}
    >
      <Ionicons color="#080b12" name="add" size={18} />
    </Pressable>
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
    paddingBottom: 12,
    paddingHorizontal: HEADER_SIDE_PADDING,
    borderBottomWidth: StyleSheet.hairlineWidth,
  } as ViewStyle,
  search: {
    borderCurve: 'continuous',
  },
});
