import Ionicons from '@expo/vector-icons/Ionicons';
import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import {
  Animated,
  Easing,
  Keyboard,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  type ViewStyle,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import {
  findConversation,
  getConversationMessages,
  type ChatMessage,
  type Conversation,
} from '../../lib/mock-chats';

const HEADER_HEIGHT = 58;
const COMPOSER_HEIGHT = 50;
const COMPOSER_EXPANDED_HEIGHT = 92;
const JUMP_BUTTON_FAR_FROM_BOTTOM = 420;
const JUMP_BUTTON_NEAR_BOTTOM = 120;
const SCROLL_DIRECTION_THRESHOLD = 6;

export default function ChatDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const insets = useSafeAreaInsets();
  const conversation = findConversation(id);
  const messages = getConversationMessages(conversation);
  const scrollViewRef = useRef<ScrollView>(null);
  const didScrollToEnd = useRef(false);
  const isJumpButtonVisible = useRef(false);
  const lastScrollY = useRef(0);
  const composerProgress = useRef(new Animated.Value(0)).current;
  const jumpButtonProgress = useRef(new Animated.Value(0)).current;
  const [isComposerExpanded, setIsComposerExpanded] = useState(false);
  const [isJumpButtonTouchable, setIsJumpButtonTouchable] = useState(false);
  const syncMessagesToBottom = () => {
    requestAnimationFrame(() => scrollViewRef.current?.scrollToEnd({ animated: false }));
  };
  const setJumpButtonVisible = (visible: boolean) => {
    if (isJumpButtonVisible.current === visible) {
      return;
    }

    isJumpButtonVisible.current = visible;
    setIsJumpButtonTouchable(visible);
    Animated.spring(jumpButtonProgress, {
      toValue: visible ? 1 : 0,
      damping: 18,
      mass: 0.7,
      stiffness: 180,
      useNativeDriver: false,
    }).start();
  };
  const animateComposer = (toValue: number, duration = 240) => {
    Animated.timing(composerProgress, {
      toValue,
      duration,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: false,
    }).start();
  };

  useEffect(() => {
    const showEvent = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
    const hideEvent = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';
    const showSubscription = Keyboard.addListener(showEvent, (event) => {
      setIsComposerExpanded(true);
      syncMessagesToBottom();
      animateComposer(1, event.duration ?? 240);
    });
    const hideSubscription = Keyboard.addListener(hideEvent, (event) => {
      setIsComposerExpanded(false);
      animateComposer(0, event.duration ?? 220);
    });
    const changeFrameSubscription =
      Platform.OS === 'ios'
        ? Keyboard.addListener('keyboardWillChangeFrame', () => {
            syncMessagesToBottom();
          })
        : undefined;

    return () => {
      showSubscription.remove();
      hideSubscription.remove();
      changeFrameSubscription?.remove();
    };
  }, [composerProgress]);

  const composerHeight = composerProgress.interpolate({
    inputRange: [0, 1],
    outputRange: [COMPOSER_HEIGHT, COMPOSER_EXPANDED_HEIGHT],
  });
  const sideActionsOpacity = composerProgress.interpolate({
    inputRange: [0, 0.45],
    outputRange: [1, 0],
    extrapolate: 'clamp',
  });
  const lowerActionsOpacity = composerProgress.interpolate({
    inputRange: [0.45, 1],
    outputRange: [0, 1],
    extrapolate: 'clamp',
  });
  const addButtonWidth = composerProgress.interpolate({
    inputRange: [0, 1],
    outputRange: [46, 0],
  });
  const addButtonGap = composerProgress.interpolate({
    inputRange: [0, 1],
    outputRange: [8, 0],
  });
  const addButtonScale = composerProgress.interpolate({
    inputRange: [0, 1],
    outputRange: [1, 0.82],
  });
  const jumpButtonBottom = composerProgress.interpolate({
    inputRange: [0, 1],
    outputRange: [
      Math.max(insets.bottom, 10) + COMPOSER_HEIGHT + 18,
      Math.max(insets.bottom, 10) + COMPOSER_EXPANDED_HEIGHT + 18,
    ],
  });
  const jumpButtonTranslateY = jumpButtonProgress.interpolate({
    inputRange: [0, 1],
    outputRange: [10, 0],
  });
  const jumpButtonScale = jumpButtonProgress.interpolate({
    inputRange: [0, 1],
    outputRange: [0.88, 1],
  });

  const handleContentSizeChange = () => {
    if (didScrollToEnd.current) {
      return;
    }

    didScrollToEnd.current = true;
    requestAnimationFrame(() => scrollViewRef.current?.scrollToEnd({ animated: false }));
  };

  const handleJumpToBottom = () => {
    setJumpButtonVisible(false);
    scrollViewRef.current?.scrollToEnd({ animated: true });
  };

  const handleScroll = (event: NativeSyntheticEvent<NativeScrollEvent>) => {
    const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
    const y = contentOffset.y;
    const distanceFromBottom = contentSize.height - layoutMeasurement.height - y;
    const deltaY = y - lastScrollY.current;

    if (distanceFromBottom < JUMP_BUTTON_NEAR_BOTTOM) {
      setJumpButtonVisible(false);
    } else if (
      deltaY > SCROLL_DIRECTION_THRESHOLD &&
      distanceFromBottom > JUMP_BUTTON_FAR_FROM_BOTTOM
    ) {
      setJumpButtonVisible(true);
    } else if (deltaY < -SCROLL_DIRECTION_THRESHOLD) {
      setJumpButtonVisible(false);
    }

    lastScrollY.current = y;
  };

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      className="flex-1 bg-background"
    >
      <View className="flex-1">
        <View
          className="border-b border-border/60 bg-background/95 px-4"
          style={{ paddingTop: insets.top, height: insets.top + HEADER_HEIGHT }}
        >
          <View className="flex-1 flex-row items-center gap-3">
            <IconButton name="chevron-back" onPress={() => router.back()} />
            <ConversationIdentity conversation={conversation} />
            <View className="flex-row items-center gap-2">
              <IconButton name="call" />
              <IconButton name="videocam" />
              <IconButton
                name={conversation.kind === 'group' ? 'information-circle' : 'person-circle'}
              />
            </View>
          </View>
        </View>

        <ScrollView
          className="flex-1"
          contentContainerStyle={{
            flexGrow: 1,
            paddingBottom: Math.max(insets.bottom, 12) + 100,
            paddingHorizontal: 14,
            paddingTop: 14,
          }}
          keyboardShouldPersistTaps="handled"
          onContentSizeChange={handleContentSizeChange}
          onScroll={handleScroll}
          onScrollBeginDrag={Keyboard.dismiss}
          ref={scrollViewRef}
          scrollEventThrottle={16}
          showsVerticalScrollIndicator={false}
        >
          {messages.map((message, index) => (
            <MessageBubble
              conversation={conversation}
              index={index}
              key={message.id}
              message={message}
              totalMessages={messages.length}
            />
          ))}
        </ScrollView>

        <Animated.View
          className="absolute right-4"
          pointerEvents={isJumpButtonTouchable ? 'auto' : 'none'}
          style={{
            bottom: jumpButtonBottom,
            opacity: jumpButtonProgress,
            transform: [{ translateY: jumpButtonTranslateY }, { scale: jumpButtonScale }],
          }}
        >
          <Pressable
            className="h-11 w-11 items-center justify-center rounded-full border border-border bg-background/95"
            onPress={handleJumpToBottom}
            style={styles.jumpButton}
          >
            <Ionicons color="#f8fafc" name="chevron-down" size={20} />
          </Pressable>
        </Animated.View>

        <View
          className="absolute left-0 right-0 bg-background/95 px-3 pt-2"
          style={{ bottom: 0, paddingBottom: Math.max(insets.bottom, 10) }}
        >
          <View className="flex-row items-end">
            <Animated.View
              className="overflow-hidden"
              style={{
                marginRight: addButtonGap,
                opacity: sideActionsOpacity,
                transform: [{ scale: addButtonScale }],
                width: addButtonWidth,
              }}
            >
              <Pressable className="h-[46px] w-[46px] items-center justify-center rounded-full bg-muted">
                <Ionicons color="#f8fafc" name="add" size={22} />
              </Pressable>
            </Animated.View>
            <Animated.View
              className="min-w-0 flex-1 overflow-hidden rounded-[26px] border border-border bg-muted"
              style={{ height: composerHeight }}
            >
              <TextInput
                className="min-h-[50px] px-4 pt-[13px] text-[17px] text-foreground"
                multiline
                onBlur={() => {
                  setIsComposerExpanded(false);
                  animateComposer(0, 180);
                }}
                onFocus={() => {
                  setIsComposerExpanded(true);
                  syncMessagesToBottom();
                  animateComposer(1, 220);
                }}
                placeholder="Message"
                placeholderTextColor="#64748b"
                selectionColor="#f8fafc"
                style={{
                  paddingBottom: isComposerExpanded ? 42 : 13,
                  paddingRight: 56,
                }}
              />
              <Animated.View
                className="absolute bottom-2 left-3 flex-row items-center gap-2"
                style={{ opacity: lowerActionsOpacity }}
              >
                <ComposerTool name="image" />
                <ComposerTool name="document-text" />
              </Animated.View>
              <Pressable className="absolute bottom-2 right-2 h-9 w-9 items-center justify-center rounded-full bg-foreground">
                <Ionicons
                  color="#080b12"
                  name={isComposerExpanded ? 'arrow-up' : 'mic'}
                  size={18}
                />
              </Pressable>
            </Animated.View>
          </View>
        </View>
      </View>
    </KeyboardAvoidingView>
  );
}

function ConversationIdentity({ conversation }: { conversation: Conversation }) {
  return (
    <Pressable className="min-w-0 flex-1 flex-row items-center gap-3">
      <AvatarStack conversation={conversation} size="small" />
      <View className="min-w-0 flex-1">
        <Text className="text-lg font-bold text-foreground" numberOfLines={1}>
          {conversation.name}
        </Text>
        <Text className="text-xs font-medium text-muted-foreground" numberOfLines={1}>
          {conversation.subtitle}
        </Text>
      </View>
    </Pressable>
  );
}

function MessageBubble({
  conversation,
  index,
  message,
  totalMessages,
}: {
  conversation: Conversation;
  index: number;
  message: ChatMessage;
  totalMessages: number;
}) {
  const opacity = useRef(new Animated.Value(0)).current;
  const translateY = useRef(new Animated.Value(12)).current;
  const isMine = message.author === 'me';

  useEffect(() => {
    Animated.parallel([
      Animated.timing(opacity, {
        toValue: 1,
        duration: 260,
        delay: (totalMessages - 1 - index) * 40,
        useNativeDriver: true,
      }),
      Animated.timing(translateY, {
        toValue: 0,
        duration: 260,
        delay: (totalMessages - 1 - index) * 40,
        useNativeDriver: true,
      }),
    ]).start();
  }, [index, opacity, totalMessages, translateY]);

  return (
    <Animated.View
      className={`mb-2 max-w-[82%] ${isMine ? 'self-end' : 'self-start'}`}
      style={{ opacity, transform: [{ translateY }] }}
    >
      <View
        className={`rounded-[24px] px-4 py-3 ${isMine ? 'bg-foreground' : 'bg-muted'}`}
        style={styles.bubble}
      >
        {!isMine && conversation.kind === 'group' && message.sender ? (
          <Text className="mb-1 text-xs font-bold text-primary">{message.sender}</Text>
        ) : null}
        <Text className={`text-[16px] leading-5 ${isMine ? 'text-background' : 'text-foreground'}`}>
          {message.text}
          <Text style={styles.timestampPlaceholder}>{`      ${message.time}`}</Text>
        </Text>
        <Text
          className={`absolute bottom-3 right-4 text-[11px] font-medium ${
            isMine ? 'text-background/55' : 'text-muted-foreground'
          }`}
        >
          {message.time}
        </Text>
      </View>
    </Animated.View>
  );
}

function AvatarStack({
  conversation,
  size,
}: {
  conversation: Conversation;
  size: 'small' | 'large';
}) {
  const isLarge = size === 'large';
  const avatarSize = isLarge ? 82 : 40;
  const secondarySize = isLarge ? 34 : 18;

  if (conversation.kind === 'private') {
    return (
      <View
        className="items-center justify-center rounded-full"
        style={{
          backgroundColor: conversation.accent,
          height: avatarSize,
          width: avatarSize,
        }}
      >
        <Text className={`${isLarge ? 'text-3xl' : 'text-base'} font-bold text-background`}>
          {conversation.name.slice(0, 1)}
        </Text>
      </View>
    );
  }

  return (
    <View style={{ height: avatarSize, width: avatarSize }}>
      <View
        className="absolute left-0 top-0 items-center justify-center rounded-full"
        style={{
          backgroundColor: conversation.accent,
          height: avatarSize * 0.72,
          width: avatarSize * 0.72,
        }}
      >
        <Text className={`${isLarge ? 'text-2xl' : 'text-sm'} font-bold text-background`}>
          {conversation.name.slice(0, 1)}
        </Text>
      </View>
      {(conversation.members ?? []).slice(0, 2).map((member, index) => (
        <View
          className="absolute items-center justify-center rounded-full border-2 border-background"
          key={member}
          style={{
            backgroundColor: index === 0 ? '#a78bfa' : '#34d399',
            bottom: index === 0 ? secondarySize * 0.65 : 0,
            height: secondarySize,
            right: 0,
            width: secondarySize,
          }}
        >
          <Text className="text-[10px] font-bold text-background">{member.slice(0, 1)}</Text>
        </View>
      ))}
    </View>
  );
}

function IconButton({
  name,
  onPress,
}: {
  name: keyof typeof Ionicons.glyphMap;
  onPress?: () => void;
}) {
  return (
    <Pressable
      className="h-10 w-10 items-center justify-center rounded-full bg-muted"
      onPress={onPress}
    >
      <Ionicons color="#f8fafc" name={name} size={20} />
    </Pressable>
  );
}

function ComposerTool({
  isPrimary,
  name,
}: {
  isPrimary?: boolean;
  name: keyof typeof Ionicons.glyphMap;
}) {
  return (
    <Pressable
      className={`h-9 w-9 items-center justify-center rounded-full ${isPrimary ? 'bg-foreground' : 'bg-background/50'}`}
    >
      <Ionicons color={isPrimary ? '#080b12' : '#f8fafc'} name={name} size={18} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  bubble: {
    borderCurve: 'continuous',
  } as ViewStyle,
  timestampPlaceholder: {
    color: 'transparent',
    fontSize: 11,
    lineHeight: 20,
  },
  jumpButton: {
    shadowColor: '#000',
    shadowOffset: { height: 8, width: 0 },
    shadowOpacity: 0.24,
    shadowRadius: 18,
  },
});
