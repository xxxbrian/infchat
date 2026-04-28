import Ionicons from '@expo/vector-icons/Ionicons';
import { useEffect, useRef, useState } from 'react';
import {
  Animated,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
  type ViewStyle,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

const SEARCH_HEIGHT = 40;
const SEARCH_MARGIN_MAX = 18;
const SEARCH_MARGIN_MIN = 8;
const HEADER_SIDE_PADDING = 20;
const TOP_BAR_HEIGHT = 48;
const TITLE_HEIGHT = 52;
const TITLE_MARGIN_BOTTOM = 12;

const conversations = [
  {
    id: '1',
    name: 'Mira Chen',
    message: 'Voice note sounds good. Send it over.',
    time: '9:42',
    unread: 2,
    accent: '#60a5fa',
  },
  {
    id: '2',
    name: 'Noah',
    message: 'I pushed the new mockups.',
    time: '9:18',
    unread: 0,
    accent: '#a78bfa',
  },
  {
    id: '3',
    name: 'Design Crit',
    message: 'Ari: the dark version is cleaner.',
    time: 'Yesterday',
    unread: 5,
    accent: '#f472b6',
  },
  {
    id: '4',
    name: 'Brian',
    message: 'Let’s keep this native, not webby.',
    time: 'Yesterday',
    unread: 0,
    accent: '#34d399',
  },
  {
    id: '5',
    name: 'Weekend',
    message: 'Dinner at 7?',
    time: 'Mon',
    unread: 0,
    accent: '#f59e0b',
  },
  {
    id: '6',
    name: 'Product',
    message: 'Native tabs landed.',
    time: 'Sun',
    unread: 1,
    accent: '#22d3ee',
  },
  {
    id: '7',
    name: 'Kai',
    message: 'Ship the skeleton first.',
    time: 'Sat',
    unread: 0,
    accent: '#fb7185',
  },
];

const filters = ['All', 'Unread', 'Groups'];

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

export default function ChatTab() {
  const insets = useSafeAreaInsets();
  const scrollY = useRef(new Animated.Value(0)).current;
  const [headerHeight, setHeaderHeight] = useState(0);

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
    useNativeDriver: false,
  });

  return (
    <View className="flex-1 bg-background">
      <Animated.View
        className="absolute left-0 right-0 z-10 border-border/60 bg-background/95"
        style={[
          styles.header,
          {
            paddingTop: insets.top,
          },
        ]}
        onLayout={({ nativeEvent }) =>
          setHeaderHeight((currentHeight) => Math.max(currentHeight, nativeEvent.layout.height))
        }
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
            />
            <RoundIcon isPrimary name="add" />
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
              placeholder="Search"
              placeholderTextColor="#64748b"
              selectionColor="#f8fafc"
            />
          </Animated.View>
        </Animated.View>

        <View className="flex-row items-center gap-2">
          {filters.map((filter, index) => (
            <Pressable
              className={`h-9 items-center justify-center rounded-full px-4 ${
                index === 0 ? 'bg-foreground' : 'bg-muted'
              }`}
              key={filter}
            >
              <Text
                className={`text-sm font-semibold ${index === 0 ? 'text-background' : 'text-muted-foreground'}`}
              >
                {filter}
              </Text>
            </Pressable>
          ))}
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
        scrollEventThrottle={16}
        showsVerticalScrollIndicator={false}
      >
        {conversations.map((conversation, index) => (
          <ConversationRow conversation={conversation} index={index} key={conversation.id} />
        ))}
      </Animated.ScrollView>
    </View>
  );
}

function RoundIcon({
  animatedStyle,
  isPrimary,
  name,
}: {
  animatedStyle?: Animated.WithAnimatedValue<ViewStyle>;
  isPrimary?: boolean;
  name: keyof typeof Ionicons.glyphMap;
}) {
  return (
    <AnimatedPressable
      className={`h-10 w-10 items-center justify-center rounded-full ${isPrimary ? 'bg-foreground' : 'bg-muted'}`}
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
  conversation: (typeof conversations)[number];
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
    <Animated.View
      className="mb-3 flex-row items-center gap-3"
      style={{ opacity, transform: [{ translateY }] }}
    >
      <View
        className="h-14 w-14 items-center justify-center rounded-full"
        style={{ backgroundColor: conversation.accent }}
      >
        <Text className="text-xl font-bold text-background">{conversation.name.slice(0, 1)}</Text>
      </View>

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
          {conversation.unread > 0 ? (
            <View className="h-6 min-w-6 items-center justify-center rounded-full bg-primary px-2">
              <Text className="text-xs font-bold text-primary-foreground">
                {conversation.unread}
              </Text>
            </View>
          ) : null}
        </View>
      </View>
    </Animated.View>
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
