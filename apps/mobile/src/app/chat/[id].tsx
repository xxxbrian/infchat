import Ionicons from '@expo/vector-icons/Ionicons';
import { useNetInfo } from '@react-native-community/netinfo';
import {
  getConversation,
  listMessages,
  listProfilesByUserIds,
  sendTextMessage,
  type ConversationRecord,
  type MessageRecord,
  type ProfileRecord,
} from '@infchat/pocketbase';
import { getAvatarColor, getAvatarInitial } from '@infchat/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Animated,
  Easing,
  Keyboard,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  RefreshControl,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  type TextInputContentSizeChangeEventData,
  View,
  type ViewStyle,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useAuth } from '../../lib/auth-context';
import { pb } from '../../lib/pocketbase';

type ConversationView = {
  id: string;
  kind: ConversationRecord['kind'];
  name: string;
  subtitle: string;
  accent: string;
  members: string[];
};

type ChatMessage = {
  id: string;
  author: 'me' | 'them';
  sender?: string;
  text: string;
  time: string;
};

const HEADER_HEIGHT = 58;
const COMPOSER_HEIGHT = 50;
const COMPOSER_EXPANDED_HEIGHT = 92;
const COMPOSER_INPUT_LINE_HEIGHT = 22;
const COMPOSER_INPUT_MIN_CONTENT_HEIGHT = COMPOSER_INPUT_LINE_HEIGHT;
const COMPOSER_INPUT_MAX_CONTENT_HEIGHT = COMPOSER_INPUT_LINE_HEIGHT * 5;
const JUMP_BUTTON_FAR_FROM_BOTTOM = 420;
const JUMP_BUTTON_NEAR_BOTTOM = 120;
const SCROLL_DIRECTION_THRESHOLD = 6;

export default function ChatDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const conversationId = id ?? '';
  const { authRecord } = useAuth();
  const queryClient = useQueryClient();
  const netInfo = useNetInfo();
  const insets = useSafeAreaInsets();
  const scrollViewRef = useRef<ScrollView>(null);
  const didScrollToEnd = useRef(false);
  const isJumpButtonVisible = useRef(false);
  const lastScrollY = useRef(0);
  const composerProgress = useRef(new Animated.Value(0)).current;
  const composerInputExtraHeight = useRef(new Animated.Value(0)).current;
  const composerAttachmentProgress = useRef(new Animated.Value(1)).current;
  const jumpButtonProgress = useRef(new Animated.Value(0)).current;
  const composerInputExtraHeightValue = useRef(0);
  const [composerText, setComposerText] = useState('');
  const [isComposerExpanded, setIsComposerExpanded] = useState(false);
  const [isJumpButtonTouchable, setIsJumpButtonTouchable] = useState(false);
  const [isComposerInputScrollable, setIsComposerInputScrollable] = useState(false);
  const hasComposerText = composerText.trim().length > 0;
  const isOnline = Boolean(netInfo.isConnected && netInfo.isInternetReachable !== false);

  const conversationQuery = useQuery({
    queryKey: ['conversation', conversationId],
    queryFn: () => getConversation(pb, conversationId),
    enabled: Boolean(conversationId),
  });
  const messagesQuery = useQuery({
    queryKey: ['messages', conversationId],
    queryFn: () => listMessages(pb, conversationId),
    enabled: Boolean(conversationId),
  });
  const memberIds = useMemo(
    () =>
      (conversationQuery.data?.members ?? [])
        .filter((memberId) => memberId !== authRecord.id)
        .sort(),
    [authRecord.id, conversationQuery.data?.members],
  );
  const profilesQuery = useQuery({
    queryKey: ['profiles', 'conversation-members', conversationId, memberIds],
    queryFn: () => listProfilesByUserIds(pb, memberIds),
    enabled: memberIds.length > 0,
  });
  const profilesByUserId = useMemo(() => {
    const profiles = new Map<string, ProfileRecord>();

    for (const profile of profilesQuery.data ?? []) {
      profiles.set(profile.user, profile);
    }

    return profiles;
  }, [profilesQuery.data]);
  const conversation = useMemo(
    () => toConversationView(conversationQuery.data, profilesByUserId, authRecord.id),
    [authRecord.id, conversationQuery.data, profilesByUserId],
  );
  const messages = useMemo(
    () =>
      (messagesQuery.data ?? []).map((message) =>
        toChatMessage(message, profilesByUserId, authRecord.id),
      ),
    [authRecord.id, messagesQuery.data, profilesByUserId],
  );
  const sendMessageMutation = useMutation({
    mutationFn: (body: string) => sendTextMessage(pb, conversationId, body),
    onSuccess: () => {
      setComposerText('');
      didScrollToEnd.current = false;
      queryClient.invalidateQueries({ queryKey: ['messages', conversationId] });
      queryClient.invalidateQueries({ queryKey: ['conversations'] });
      queryClient.invalidateQueries({
        queryKey: ['conversation', conversationId],
      });
    },
  });
  const isRefreshing =
    conversationQuery.isRefetching || messagesQuery.isRefetching || profilesQuery.isRefetching;

  useEffect(() => {
    if (!conversationId || !isOnline) {
      return;
    }

    let isMounted = true;
    let unsubscribers: Array<() => void> = [];

    void Promise.all([
      pb.collection('conversations').subscribe('*', (event) => {
        if (event.record?.id !== conversationId) {
          return;
        }

        queryClient.invalidateQueries({
          queryKey: ['conversation', conversationId],
        });
        queryClient.invalidateQueries({ queryKey: ['conversations'] });
      }),
      pb.collection('messages').subscribe('*', (event) => {
        if (event.record?.conversation !== conversationId) {
          return;
        }

        didScrollToEnd.current = false;
        queryClient.invalidateQueries({
          queryKey: ['messages', conversationId],
        });
        queryClient.invalidateQueries({
          queryKey: ['conversation', conversationId],
        });
        queryClient.invalidateQueries({ queryKey: ['conversations'] });
      }),
      pb.collection('profiles').subscribe('*', () => {
        queryClient.invalidateQueries({ queryKey: ['profiles'] });
      }),
    ])
      .then((nextUnsubscribers) => {
        if (!isMounted) {
          nextUnsubscribers.forEach((unsubscribe) => unsubscribe());
          return;
        }

        unsubscribers = nextUnsubscribers;
      })
      .catch(() => {
        // Query refetch on reconnect covers temporary realtime connection failures.
      });

    return () => {
      isMounted = false;
      unsubscribers.forEach((unsubscribe) => unsubscribe());
    };
  }, [conversationId, isOnline, queryClient]);

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

  useEffect(() => {
    Animated.timing(composerAttachmentProgress, {
      toValue: hasComposerText ? 0 : 1,
      duration: hasComposerText ? 140 : 180,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: false,
    }).start();
  }, [composerAttachmentProgress, hasComposerText]);

  const composerBaseHeight = composerProgress.interpolate({
    inputRange: [0, 1],
    outputRange: [COMPOSER_HEIGHT, COMPOSER_EXPANDED_HEIGHT],
  });
  const composerHeight = Animated.add(composerBaseHeight, composerInputExtraHeight);
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
  const composerToolOpacity = Animated.multiply(lowerActionsOpacity, composerAttachmentProgress);
  const composerToolTranslateY = composerToolOpacity.interpolate({
    inputRange: [0, 1],
    outputRange: [6, 0],
  });
  const composerToolScale = composerAttachmentProgress.interpolate({
    inputRange: [0, 1],
    outputRange: [0.92, 1],
  });
  const composerPrimaryActionBottom = composerProgress.interpolate({
    inputRange: [0, 1],
    outputRange: [6, 8],
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
  const jumpButtonBaseBottom = composerProgress.interpolate({
    inputRange: [0, 1],
    outputRange: [
      Math.max(insets.bottom, 10) + COMPOSER_HEIGHT + 18,
      Math.max(insets.bottom, 10) + COMPOSER_EXPANDED_HEIGHT + 18,
    ],
  });
  const jumpButtonBottom = Animated.add(jumpButtonBaseBottom, composerInputExtraHeight);
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

  const handleRefresh = () => {
    queryClient.invalidateQueries({
      queryKey: ['conversation', conversationId],
    });
    queryClient.invalidateQueries({ queryKey: ['messages', conversationId] });
    queryClient.invalidateQueries({ queryKey: ['profiles'] });
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

  const handleComposerContentSizeChange = (
    event: NativeSyntheticEvent<TextInputContentSizeChangeEventData>,
  ) => {
    const contentHeight = event.nativeEvent.contentSize.height;
    if (composerText.length === 0) {
      if (composerInputExtraHeightValue.current === 0) {
        return;
      }

      composerInputExtraHeightValue.current = 0;
      setIsComposerInputScrollable(false);
      Animated.timing(composerInputExtraHeight, {
        toValue: 0,
        duration: 120,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: false,
      }).start(() => syncMessagesToBottom());
      return;
    }

    const clampedContentHeight = Math.min(
      Math.max(contentHeight, COMPOSER_INPUT_MIN_CONTENT_HEIGHT),
      COMPOSER_INPUT_MAX_CONTENT_HEIGHT,
    );
    const nextExtraHeight = clampedContentHeight - COMPOSER_INPUT_MIN_CONTENT_HEIGHT;

    if (Math.abs(nextExtraHeight - composerInputExtraHeightValue.current) < 1) {
      setIsComposerInputScrollable(contentHeight > COMPOSER_INPUT_MAX_CONTENT_HEIGHT);
      return;
    }

    composerInputExtraHeightValue.current = nextExtraHeight;
    setIsComposerInputScrollable(contentHeight > COMPOSER_INPUT_MAX_CONTENT_HEIGHT);
    Animated.timing(composerInputExtraHeight, {
      toValue: nextExtraHeight,
      duration: 120,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: false,
    }).start(() => syncMessagesToBottom());
  };

  const handleSendMessage = () => {
    const body = composerText.trim();
    if (!body || sendMessageMutation.isPending) {
      return;
    }

    sendMessageMutation.mutate(body);
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
            paddingBottom:
              Math.max(insets.bottom, 12) +
              COMPOSER_EXPANDED_HEIGHT +
              COMPOSER_INPUT_MAX_CONTENT_HEIGHT -
              COMPOSER_INPUT_MIN_CONTENT_HEIGHT +
              12,
            paddingHorizontal: 14,
            paddingTop: 14,
          }}
          keyboardShouldPersistTaps="handled"
          onContentSizeChange={handleContentSizeChange}
          onScroll={handleScroll}
          onScrollBeginDrag={Keyboard.dismiss}
          refreshControl={
            <RefreshControl
              colors={['#f8fafc']}
              onRefresh={handleRefresh}
              refreshing={isRefreshing}
              tintColor="#f8fafc"
            />
          }
          ref={scrollViewRef}
          scrollEventThrottle={16}
          showsVerticalScrollIndicator={false}
        >
          {conversationQuery.isLoading || messagesQuery.isLoading ? (
            <EmptyConversation label="Loading messages" />
          ) : conversationQuery.isError || messagesQuery.isError ? (
            <EmptyConversation label="Could not load messages" />
          ) : messages.length ? (
            messages.map((message, index) => (
              <MessageBubble
                conversation={conversation}
                index={index}
                key={message.id}
                message={message}
                totalMessages={messages.length}
              />
            ))
          ) : (
            <EmptyConversation label="No messages yet" />
          )}
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
                className="px-4 pt-[13px] text-[17px] text-foreground"
                multiline
                onBlur={() => {
                  setIsComposerExpanded(false);
                  animateComposer(0, 180);
                }}
                onChangeText={setComposerText}
                onContentSizeChange={handleComposerContentSizeChange}
                onFocus={() => {
                  setIsComposerExpanded(true);
                  syncMessagesToBottom();
                  animateComposer(1, 220);
                }}
                placeholder="Message"
                placeholderTextColor="#64748b"
                scrollEnabled={isComposerInputScrollable}
                selectionColor="#f8fafc"
                style={{
                  lineHeight: COMPOSER_INPUT_LINE_HEIGHT,
                  maxHeight: COMPOSER_INPUT_MAX_CONTENT_HEIGHT + 56,
                  minHeight: COMPOSER_HEIGHT,
                  paddingBottom: isComposerExpanded ? 42 : 13,
                  paddingRight: 56,
                  textAlignVertical: 'top',
                }}
                value={composerText}
              />
              <Animated.View
                className="absolute bottom-2 left-3 flex-row items-center gap-2"
                pointerEvents={hasComposerText ? 'none' : 'auto'}
                style={{
                  opacity: composerToolOpacity,
                  transform: [{ translateY: composerToolTranslateY }, { scale: composerToolScale }],
                }}
              >
                <ComposerTool name="image" />
                <ComposerTool name="document-text" />
              </Animated.View>
              <Animated.View
                className="absolute right-2 h-9 w-9 overflow-hidden rounded-full"
                style={{ bottom: composerPrimaryActionBottom }}
              >
                <Pressable
                  className="h-full w-full items-center justify-center bg-foreground"
                  onPress={hasComposerText ? handleSendMessage : undefined}
                >
                  <Ionicons
                    color="#080b12"
                    name={hasComposerText || isComposerExpanded ? 'arrow-up' : 'mic'}
                    size={18}
                  />
                </Pressable>
              </Animated.View>
            </Animated.View>
          </View>
        </View>
      </View>
    </KeyboardAvoidingView>
  );
}

function toConversationView(
  conversation: ConversationRecord | undefined,
  profilesByUserId: Map<string, ProfileRecord>,
  currentUserId: string,
): ConversationView {
  if (!conversation) {
    return {
      id: '',
      kind: 'private',
      name: 'Chat',
      subtitle: '',
      accent: '#64748b',
      members: [],
    };
  }

  const otherMemberIds = conversation.members.filter((memberId) => memberId !== currentUserId);
  const otherProfiles = otherMemberIds
    .map((memberId) => profilesByUserId.get(memberId))
    .filter((profile): profile is ProfileRecord => Boolean(profile));
  const firstProfile = otherProfiles[0];
  const name =
    conversation.kind === 'group'
      ? conversation.title ||
        otherProfiles.map((profile) => profile.display_name).join(', ') ||
        'Group chat'
      : firstProfile?.display_name || firstProfile?.username || 'Private chat';

  return {
    id: conversation.id,
    kind: conversation.kind,
    name,
    subtitle: conversation.kind === 'group' ? `${conversation.members.length} members` : 'friend',
    accent: getAvatarColor(firstProfile?.user || conversation.id),
    members: otherProfiles.map((profile) => profile.display_name || profile.username),
  };
}

function toChatMessage(
  message: MessageRecord,
  profilesByUserId: Map<string, ProfileRecord>,
  currentUserId: string,
): ChatMessage {
  const senderProfile = profilesByUserId.get(message.sender);

  return {
    id: message.id,
    author: message.sender === currentUserId ? 'me' : 'them',
    sender: senderProfile?.display_name || senderProfile?.username,
    text: message.body,
    time: formatMessageTime(message.created),
  };
}

function formatMessageTime(value: string): string {
  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return '';
  }

  return date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

function ConversationIdentity({ conversation }: { conversation: ConversationView }) {
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
  conversation: ConversationView;
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
  conversation: ConversationView;
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
          {getAvatarInitial(conversation.name, conversation.name)}
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
          {getAvatarInitial(conversation.name, conversation.name)}
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

function EmptyConversation({ label }: { label: string }) {
  return (
    <View className="flex-1 items-center justify-center py-20">
      <View className="h-16 w-16 items-center justify-center rounded-full bg-muted">
        <Ionicons color="#64748b" name="chatbubble-ellipses" size={28} />
      </View>
      <Text className="mt-4 text-lg font-bold text-foreground">{label}</Text>
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
