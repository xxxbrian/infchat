import Ionicons from '@expo/vector-icons/Ionicons';
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

type FriendStatus = 'friend' | 'incoming' | 'pending' | 'none';
type FriendFilter = 'Friends' | 'Requests' | 'Find';

type Person = {
  id: string;
  name: string;
  username: string;
  accent: string;
  status: FriendStatus;
  note: string;
  online?: boolean;
};

const HEADER_SIDE_PADDING = 20;
const TOP_BAR_HEIGHT = 48;
const TITLE_HEIGHT = 52;
const SEARCH_HEIGHT = 40;
const SEARCH_MARGIN_MAX = 14;
const SEARCH_MARGIN_MIN = 8;
const filters: FriendFilter[] = ['Friends', 'Requests', 'Find'];

const initialPeople: Person[] = [
  {
    id: 'mira',
    name: 'Mira Chen',
    username: 'mira',
    accent: '#60a5fa',
    status: 'friend',
    note: 'online',
    online: true,
  },
  {
    id: 'noah',
    name: 'Noah Kim',
    username: 'noah',
    accent: '#a78bfa',
    status: 'friend',
    note: 'last seen 9:20',
  },
  {
    id: 'ari',
    name: 'Ari Lane',
    username: 'ari',
    accent: '#f472b6',
    status: 'incoming',
    note: 'sent you a request',
  },
  {
    id: 'kai',
    name: 'Kai Morgan',
    username: 'kai',
    accent: '#fb7185',
    status: 'friend',
    note: 'last seen Sat',
  },
  {
    id: 'nora',
    name: 'Nora Patel',
    username: 'nora',
    accent: '#38bdf8',
    status: 'friend',
    note: 'online',
    online: true,
  },
  {
    id: 'mina',
    name: 'Mina Ito',
    username: 'mina',
    accent: '#f97316',
    status: 'friend',
    note: 'last seen Tue',
  },
  {
    id: 'owen',
    name: 'Owen Gray',
    username: 'owen',
    accent: '#4ade80',
    status: 'friend',
    note: 'available',
  },
  {
    id: 'sasha',
    name: 'Sasha Vale',
    username: 'sasha',
    accent: '#e879f9',
    status: 'friend',
    note: 'last seen 8:14',
  },
  {
    id: 'leo',
    name: 'Leo Martin',
    username: 'leo',
    accent: '#2dd4bf',
    status: 'friend',
    note: 'last seen Sun',
  },
  {
    id: 'tess',
    name: 'Tess Wong',
    username: 'tess',
    accent: '#facc15',
    status: 'incoming',
    note: 'sent you a request',
  },
  {
    id: 'jules',
    name: 'Jules Park',
    username: 'jules',
    accent: '#34d399',
    status: 'pending',
    note: 'request sent',
  },
  {
    id: 'rhea',
    name: 'Rhea Stone',
    username: 'rhea',
    accent: '#22d3ee',
    status: 'none',
    note: '3 mutual friends',
  },
  {
    id: 'sol',
    name: 'Sol Reyes',
    username: 'sol',
    accent: '#f59e0b',
    status: 'none',
    note: 'from Product',
  },
  {
    id: 'lina',
    name: 'Lina Torres',
    username: 'lina',
    accent: '#c084fc',
    status: 'none',
    note: 'new to InfChat',
  },
  {
    id: 'marc',
    name: 'Marc Bell',
    username: 'marc',
    accent: '#94a3b8',
    status: 'none',
    note: '2 mutual friends',
  },
  {
    id: 'ella',
    name: 'Ella Moon',
    username: 'ella',
    accent: '#fb7185',
    status: 'none',
    note: 'from Design Crit',
  },
];

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

export default function FriendsTab() {
  const insets = useSafeAreaInsets();
  const searchRef = useRef<TextInput>(null);
  const scrollViewRef = useRef<ScrollView>(null);
  const scrollY = useRef(new Animated.Value(0)).current;
  const scrollYValue = useRef(0);
  const [headerHeight, setHeaderHeight] = useState(0);
  const [people, setPeople] = useState(initialPeople);
  const [activeFilter, setActiveFilter] = useState<FriendFilter>('Friends');
  const [isSearchFocused, setIsSearchFocused] = useState(false);
  const [query, setQuery] = useState('');

  const friends = people.filter((person) => person.status === 'friend');
  const incoming = people.filter((person) => person.status === 'incoming');
  const searchablePeople =
    activeFilter === 'Find'
      ? people.filter((person) => person.status !== 'friend')
      : activeFilter === 'Requests'
        ? incoming
        : friends;
  const visiblePeople = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();

    if (!normalizedQuery) {
      return searchablePeople;
    }

    return searchablePeople.filter(
      (person) =>
        person.name.toLowerCase().includes(normalizedQuery) ||
        person.username.toLowerCase().includes(normalizedQuery),
    );
  }, [query, searchablePeople]);

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

  const updateStatus = (personId: string, status: FriendStatus) => {
    setPeople((currentPeople) =>
      currentPeople.map((person) => (person.id === personId ? { ...person, status } : person)),
    );
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

    return people.filter((person) => person.status === 'none' || person.status === 'pending')
      .length;
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
              className="h-full min-w-0 flex-1 px-3 text-[17px] text-foreground"
              onChangeText={setQuery}
              onBlur={() => setIsSearchFocused(false)}
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
        {activeFilter === 'Find' ? <FindNotice hasQuery={Boolean(query.trim())} /> : null}

        {visiblePeople.length ? (
          visiblePeople.map((person, index) => (
            <PersonRow
              key={person.id}
              index={index}
              onAccept={() => updateStatus(person.id, 'friend')}
              onAdd={() => updateStatus(person.id, 'pending')}
              onDismissKeyboard={Keyboard.dismiss}
              onDecline={() => updateStatus(person.id, 'none')}
              person={person}
            />
          ))
        ) : (
          <EmptyState
            icon={activeFilter === 'Find' ? 'person-add' : 'search'}
            title={activeFilter === 'Find' ? 'No one found' : 'No matches'}
          />
        )}
      </Animated.ScrollView>
    </View>
  );
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

function FindNotice({ hasQuery }: { hasQuery: boolean }) {
  return (
    <View className="mb-3 rounded-[20px] bg-muted px-4 py-3">
      <Text className="text-sm font-semibold text-foreground">
        {hasQuery ? 'Search results' : 'Find by username'}
      </Text>
      <Text className="mt-0.5 text-xs font-medium text-muted-foreground">
        {hasQuery
          ? 'People outside your friends list.'
          : 'Type a username or name to send a request.'}
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
  onAccept,
  onAdd,
  onDecline,
  onDismissKeyboard,
  person,
}: {
  index: number;
  onAccept: () => void;
  onAdd: () => void;
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
            onAccept={onAccept}
            onAdd={onAdd}
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
      <Text className="text-base font-bold text-background">{person.name.slice(0, 1)}</Text>
      {person.online ? (
        <View className="absolute bottom-0 right-0 h-3.5 w-3.5 rounded-full border-2 border-background bg-primary" />
      ) : null}
    </View>
  );
}

function FriendAction({
  onAccept,
  onAdd,
  onDecline,
  status,
}: {
  onAccept: () => void;
  onAdd: () => void;
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
      <View className="h-8 items-center justify-center rounded-full bg-muted px-3">
        <Text className="text-xs font-bold text-muted-foreground">Pending</Text>
      </View>
    );
  }

  if (status === 'incoming') {
    return (
      <View className="flex-row items-center gap-2">
        <Pressable
          className="h-8 w-8 items-center justify-center rounded-full bg-muted"
          onPress={onDecline}
        >
          <Ionicons color="#94a3b8" name="close" size={16} />
        </Pressable>
        <Pressable
          className="h-8 w-8 items-center justify-center rounded-full bg-foreground"
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
