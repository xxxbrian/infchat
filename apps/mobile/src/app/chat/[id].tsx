import Ionicons from '@expo/vector-icons/Ionicons';
import {
  type CallKind,
  type CallRoomRecord,
  type ConversationRecord,
  type ConversationUserStateRecord,
  getActiveCallForConversation,
  getMessageAttachmentUrl,
  getProfileAvatarUrl,
  type MessageRecord,
  type MessageUploadFile,
  type ProfileRecord,
  sendFileMessage,
  sendImageMessage,
  startCall,
} from '@infchat/pocketbase';
import { getAvatarColor, getAvatarInitial } from '@infchat/shared';
import { useNetInfo } from '@react-native-community/netinfo';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import * as DocumentPicker from 'expo-document-picker';
import * as FileSystem from 'expo-file-system/legacy';
import * as ImagePicker from 'expo-image-picker';
import { router, useLocalSearchParams } from 'expo-router';
import * as Sharing from 'expo-sharing';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  Animated,
  Easing,
  Image,
  Keyboard,
  KeyboardAvoidingView,
  Modal,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  Platform,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  type TextInputContentSizeChangeEventData,
  useWindowDimensions,
  View,
  type ViewStyle,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { ProfileAvatar } from '../../components/ProfileAvatar';
import { useAuth } from '../../lib/auth-context';
import { useCallSession } from '../../lib/call-context';
import { useRingingSecondsLeft } from '../../lib/call-countdown';
import { useChatSyncService } from '../../lib/chat-sync-context';
import {
  getLocalConversation,
  listLocalConversationStatesForConversation,
  listLocalMessages,
  listOutboxMessagesForConversation,
} from '../../lib/chat-sync-store';
import { getDeviceId } from '../../lib/device-id';
import { listCachedProfilesByUserIds, refreshCachedProfilesByUserIds } from '../../lib/local-cache';
import { useCachedRemoteUri } from '../../lib/media-cache';
import { pb } from '../../lib/pocketbase';

type ConversationView = {
  id: string;
  kind: ConversationRecord['kind'];
  name: string;
  subtitle: string;
  accent: string;
  avatarUrl?: string | null;
  avatarUserId: string;
  avatarUsername: string;
  members: string[];
};

type ChatMessage = {
  id: string;
  author: 'me' | 'them';
  attachments: MessageAttachment[];
  callRoomId?: string;
  created: string;
  deliveryStatus?: 'failed';
  failedMessageId?: string;
  kind: MessageRecord['kind'];
  readLabel?: string;
  sender?: string;
  senderId: string;
  text: string;
  time: string;
};

type MessageAttachment = {
  name: string;
  thumbUrl?: string;
  url: string;
};

type FileDownloadState = 'idle' | 'checking' | 'downloading' | 'downloaded';

type FailedOutgoingMessage = {
  body: string;
  created: string;
  id: string;
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
const ATTACHMENT_MENU_ROW_HEIGHT = 54;
const ATTACHMENT_MENU_GAP = 10;

export default function ChatDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const conversationId = id ?? '';
  const { authRecord } = useAuth();
  const { activeSession } = useCallSession();
  const chatSyncService = useChatSyncService();
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
  const attachmentMenuProgress = useRef(new Animated.Value(0)).current;
  const jumpButtonProgress = useRef(new Animated.Value(0)).current;
  const composerInputExtraHeightValue = useRef(0);
  const [composerText, setComposerText] = useState('');
  const [isComposerExpanded, setIsComposerExpanded] = useState(false);
  const [isAttachmentMenuOpen, setIsAttachmentMenuOpen] = useState(false);
  const [isAttachmentMenuTouchable, setIsAttachmentMenuTouchable] = useState(false);
  const [isPullRefreshing, setIsPullRefreshing] = useState(false);
  const [isJumpButtonTouchable, setIsJumpButtonTouchable] = useState(false);
  const [isComposerInputScrollable, setIsComposerInputScrollable] = useState(false);
  const [failedOutgoingMessages, setFailedOutgoingMessages] = useState<FailedOutgoingMessage[]>([]);
  const hasComposerText = composerText.trim().length > 0;
  const isOnline = Boolean(netInfo.isConnected && netInfo.isInternetReachable !== false);
  const isNearBottomRef = useRef(true);
  const lastAutoScrolledConversationIdRef = useRef('');
  const lastAutoScrolledMessageIdRef = useRef('');

  const conversationQuery = useQuery({
    queryKey: ['chat', authRecord.id, 'conversation', conversationId],
    queryFn: () => getLocalConversation(authRecord.id, conversationId),
    enabled: Boolean(conversationId),
  });
  const fileTokenQuery = useQuery({
    queryKey: ['file-token', authRecord.id],
    queryFn: () => pb.files.getToken(),
    staleTime: 1000 * 60 * 5,
  });
  const messagesQuery = useQuery({
    queryKey: ['chat', authRecord.id, 'messages', conversationId],
    queryFn: () => listLocalMessages(authRecord.id, conversationId),
    enabled: Boolean(conversationId),
  });
  const outboxMessagesQuery = useQuery({
    queryKey: ['chat', authRecord.id, 'outbox', conversationId],
    queryFn: () => listOutboxMessagesForConversation(authRecord.id, conversationId),
    enabled: Boolean(conversationId),
  });
  const activeCallQuery = useQuery({
    queryKey: ['active-call', conversationId],
    queryFn: () => getActiveCallForConversation(pb, conversationId),
    enabled: Boolean(conversationId),
  });
  const readStatesQuery = useQuery({
    queryKey: ['chat', authRecord.id, 'conversation-states', conversationId],
    queryFn: () => listLocalConversationStatesForConversation(authRecord.id, conversationId),
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
    queryFn: () => listCachedProfilesByUserIds(pb, memberIds),
    enabled: memberIds.length > 0,
    networkMode: 'always',
  });
  const profilesByUserId = useMemo(() => {
    const profiles = new Map<string, ProfileRecord>();

    for (const profile of profilesQuery.data ?? []) {
      profiles.set(profile.user, profile);
    }

    return profiles;
  }, [profilesQuery.data]);
  const conversation = useMemo(
    () =>
      toConversationView(
        conversationQuery.data,
        profilesByUserId,
        authRecord.id,
        fileTokenQuery.data,
      ),
    [authRecord.id, conversationQuery.data, fileTokenQuery.data, profilesByUserId],
  );
  const messages = useMemo(() => {
    const readMessageId = getLastReadOwnMessageId(
      messagesQuery.data ?? [],
      readStatesQuery.data ?? [],
      authRecord.id,
    );
    const cachedMessages = (messagesQuery.data ?? []).map((message) =>
      toChatMessage(
        message,
        profilesByUserId,
        authRecord.id,
        fileTokenQuery.data,
        message.id === readMessageId ? 'Read' : undefined,
      ),
    );
    const outboxMessages = (outboxMessagesQuery.data ?? []).map(
      (message): ChatMessage => ({
        id: `outbox-${message.client_message_id}`,
        author: 'me' as const,
        attachments: [],
        created: message.client_created_at,
        deliveryStatus: message.state === 'failed_terminal' ? ('failed' as const) : undefined,
        failedMessageId:
          message.state === 'failed_terminal' ? message.client_message_id : undefined,
        kind: 'text' as const,
        senderId: authRecord.id,
        text: message.body,
        time: formatMessageTime(message.client_created_at),
      }),
    );
    const failedMessages = failedOutgoingMessages.map((message) =>
      toFailedChatMessage(message, authRecord.id),
    );

    return [...cachedMessages, ...outboxMessages, ...failedMessages];
  }, [
    authRecord.id,
    failedOutgoingMessages,
    fileTokenQuery.data,
    messagesQuery.data,
    outboxMessagesQuery.data,
    profilesByUserId,
    readStatesQuery.data,
  ]);
  const activeCall = activeCallQuery.data;
  const activeSessionCallRoomId = activeSession?.callRoom.id;
  const shouldShowActiveCallBanner = Boolean(
    activeCall && activeSessionCallRoomId !== activeCall.id,
  );
  const addFailedOutgoingMessage = (body: string) => {
    setFailedOutgoingMessages((current) => [
      ...current,
      {
        body,
        created: new Date().toISOString(),
        id: `failed-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      },
    ]);
  };
  const removeFailedOutgoingMessage = (messageId: string) => {
    setFailedOutgoingMessages((current) => current.filter((message) => message.id !== messageId));
  };
  const sendAttachmentMutation = useMutation({
    mutationFn: ({
      file,
      kind,
    }: {
      file: MessageUploadFile;
      kind: Extract<MessageRecord['kind'], 'image' | 'file'>;
    }) =>
      kind === 'image'
        ? sendImageMessage(pb, conversationId, file)
        : sendFileMessage(pb, conversationId, file),
    onSuccess: (message) => {
      didScrollToEnd.current = false;
      void chatSyncService.syncNow('manual');
      queryClient.invalidateQueries({ queryKey: ['chat', authRecord.id] });
    },
    onError: () => {
      Alert.alert('Could not send attachment', 'Check your connection and try again.');
    },
  });
  const startCallMutation = useMutation({
    mutationFn: async (kind: CallKind) => {
      const deviceId = await getDeviceId();

      return startCall(pb, conversationId, kind, deviceId);
    },
    onSuccess: (response) => {
      queryClient.invalidateQueries({
        queryKey: ['active-call', conversationId],
      });
      router.push({
        pathname: '/call/[id]',
        params: { id: response.callRoom.id },
      });
    },
    onError: (error) => {
      Alert.alert(
        'Call unavailable',
        getErrorMessage(error, 'Check your connection and try again.'),
      );
    },
  });
  useEffect(() => {
    if (!conversationId || !isOnline) {
      return;
    }

    void chatSyncService.syncNow('manual').catch(() => {
      // The next hint or reconnect will retry the sync loop.
    });
    void chatSyncService.syncConversationHistory(conversationId).catch(() => {
      // The global sync queue remains the primary recovery path.
    });
  }, [chatSyncService, conversationId, isOnline]);

  useEffect(() => {
    if (!isOnline || memberIds.length === 0) {
      return;
    }

    let isMounted = true;

    void refreshCachedProfilesByUserIds(pb, memberIds)
      .then((profiles) => {
        if (isMounted) {
          queryClient.setQueryData(
            ['profiles', 'conversation-members', conversationId, memberIds],
            profiles,
          );
        }
      })
      .catch(() => {
        // Profile names from local cache are good enough until the next refresh.
      });

    return () => {
      isMounted = false;
    };
  }, [conversationId, isOnline, memberIds, queryClient]);

  useEffect(() => {
    const lastMessage = messagesQuery.data?.at(-1);
    const lastReadSeq = lastMessage?.message_seq ?? 0;
    if (!conversationId || !isOnline || lastReadSeq <= 0) {
      return;
    }

    void chatSyncService.markConversationRead(conversationId, lastReadSeq).catch(() => {
      // The server receipt is authoritative; do not queue read updates offline.
    });
  }, [chatSyncService, conversationId, isOnline, messagesQuery.data]);

  const syncMessagesToBottom = () => {
    requestAnimationFrame(() => {
      scrollViewRef.current?.scrollToEnd({ animated: false });
      requestAnimationFrame(() => scrollViewRef.current?.scrollToEnd({ animated: false }));
    });
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
  const setAttachmentMenuVisible = (visible: boolean) => {
    setIsAttachmentMenuOpen(visible);
    if (visible) {
      setIsAttachmentMenuTouchable(true);
    }

    Animated.spring(attachmentMenuProgress, {
      toValue: visible ? 1 : 0,
      damping: 22,
      mass: 0.72,
      stiffness: 230,
      useNativeDriver: true,
    }).start(() => {
      if (!visible) {
        setIsAttachmentMenuTouchable(false);
      }
    });
  };

  useEffect(() => {
    const showEvent = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
    const hideEvent = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';
    const showSubscription = Keyboard.addListener(showEvent, (event) => {
      setAttachmentMenuVisible(false);
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
  }, [attachmentMenuProgress, composerProgress]);

  useEffect(() => {
    Animated.timing(composerAttachmentProgress, {
      toValue: hasComposerText ? 0 : 1,
      duration: hasComposerText ? 140 : 180,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: false,
    }).start();
  }, [composerAttachmentProgress, hasComposerText]);

  useEffect(() => {
    lastAutoScrolledConversationIdRef.current = '';
    lastAutoScrolledMessageIdRef.current = '';
    isNearBottomRef.current = true;
    didScrollToEnd.current = false;
  }, [conversationId]);

  useEffect(() => {
    const lastMessage = messages.at(-1);
    if (!conversationId || !lastMessage) {
      return;
    }

    const isNewConversation = lastAutoScrolledConversationIdRef.current !== conversationId;
    const isNewLastMessage = lastAutoScrolledMessageIdRef.current !== lastMessage.id;
    if (!isNewConversation && !isNewLastMessage) {
      return;
    }

    lastAutoScrolledConversationIdRef.current = conversationId;
    lastAutoScrolledMessageIdRef.current = lastMessage.id;

    if (isNewConversation || isNearBottomRef.current || lastMessage.sender === authRecord.id) {
      syncMessagesToBottom();
    }
  }, [authRecord.id, conversationId, messages]);

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
  const addButtonRotate = attachmentMenuProgress.interpolate({
    inputRange: [0, 1],
    outputRange: ['0deg', '45deg'],
  });
  const attachmentBackdropOpacity = attachmentMenuProgress.interpolate({
    inputRange: [0, 1],
    outputRange: [0, 0.42],
  });
  const attachmentMenuOpacity = attachmentMenuProgress.interpolate({
    inputRange: [0, 0.3, 1],
    outputRange: [0, 1, 1],
  });
  const attachmentMenuScale = attachmentMenuProgress.interpolate({
    inputRange: [0, 1],
    outputRange: [0.88, 1],
  });
  const attachmentMenuTranslateX = attachmentMenuProgress.interpolate({
    inputRange: [0, 1],
    outputRange: [-18, 0],
  });
  const imageActionTranslateY = attachmentMenuProgress.interpolate({
    inputRange: [0, 1],
    outputRange: [ATTACHMENT_MENU_ROW_HEIGHT * 2 + ATTACHMENT_MENU_GAP, 0],
  });
  const fileActionTranslateY = attachmentMenuProgress.interpolate({
    inputRange: [0, 1],
    outputRange: [ATTACHMENT_MENU_ROW_HEIGHT + ATTACHMENT_MENU_GAP, 0],
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

  const handleRefresh = async () => {
    if (isPullRefreshing || !conversationId) {
      return;
    }

    setIsPullRefreshing(true);
    try {
      const [, , nextProfiles] = await Promise.all([
        chatSyncService.syncNow('manual'),
        chatSyncService.syncConversationHistory(conversationId),
        memberIds.length > 0 ? refreshCachedProfilesByUserIds(pb, memberIds) : Promise.resolve([]),
      ]);

      await queryClient.invalidateQueries({
        queryKey: ['chat', authRecord.id],
      });
      if (memberIds.length > 0) {
        queryClient.setQueryData(
          ['profiles', 'conversation-members', conversationId, memberIds],
          nextProfiles,
        );
      }
    } finally {
      setIsPullRefreshing(false);
    }
  };

  const handleScroll = (event: NativeSyntheticEvent<NativeScrollEvent>) => {
    const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
    const y = contentOffset.y;
    const distanceFromBottom = contentSize.height - layoutMeasurement.height - y;
    const deltaY = y - lastScrollY.current;
    isNearBottomRef.current = distanceFromBottom < JUMP_BUTTON_NEAR_BOTTOM;

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

  const handleToggleAttachmentMenu = () => {
    if (isComposerExpanded) {
      return;
    }

    Keyboard.dismiss();
    setAttachmentMenuVisible(!isAttachmentMenuOpen);
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
    if (!body || sendAttachmentMutation.isPending) {
      return;
    }

    setComposerText('');
    didScrollToEnd.current = false;
    void chatSyncService
      .enqueueTextMessage(conversationId, body)
      .then(() => {
        syncMessagesToBottom();
      })
      .catch(() => {
        addFailedOutgoingMessage(body);
        syncMessagesToBottom();
      });
  };

  const handleRetryFailedMessage = async (messageId: string) => {
    const failedMessage = failedOutgoingMessages.find((message) => message.id === messageId);
    if (!failedMessage) {
      return;
    }

    if (!isOnline) {
      Alert.alert('Still offline', 'Reconnect, then tap the red alert to resend.');
      return;
    }

    try {
      await chatSyncService.enqueueTextMessage(conversationId, failedMessage.body);
      removeFailedOutgoingMessage(messageId);
      didScrollToEnd.current = false;
    } catch {
      Alert.alert('Could not resend', 'Check your connection and tap the alert again.');
    }
  };

  const handleStartCall = (kind: CallKind) => {
    if (!conversationId || startCallMutation.isPending) {
      return;
    }

    if (activeSessionCallRoomId) {
      if (activeSession?.callRoom.conversation === conversationId) {
        router.push({
          pathname: '/call/[id]',
          params: { id: activeSessionCallRoomId },
        });
        return;
      }

      Alert.alert('Already in a call', 'Leave your current call before starting another one.');
      return;
    }

    if (activeCall) {
      router.push({ pathname: '/call/[id]', params: { id: activeCall.id } });
      return;
    }

    startCallMutation.mutate(kind);
  };

  const handleJoinActiveCall = async () => {
    if (activeSessionCallRoomId) {
      if (activeSessionCallRoomId === activeCall?.id) {
        router.push({
          pathname: '/call/[id]',
          params: { id: activeSessionCallRoomId },
        });
        return;
      }

      Alert.alert('Already in a call', 'Leave your current call before joining another one.');
      return;
    }

    const latest = await activeCallQuery.refetch();
    const latestCall = latest.data;
    if (!latestCall || (latestCall.status !== 'ringing' && latestCall.status !== 'active')) {
      Alert.alert('Call ended', 'This call is no longer available.');
      return;
    }

    router.push({ pathname: '/call/[id]', params: { id: latestCall.id } });
  };

  const handlePickImage = async () => {
    if (sendAttachmentMutation.isPending) {
      return;
    }

    setAttachmentMenuVisible(false);

    const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!permission.granted) {
      Alert.alert('Photos access needed', 'Allow photos access to send an image.');
      return;
    }

    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      quality: 0.9,
    });

    if (result.canceled) {
      return;
    }

    const asset = result.assets[0];
    if (!asset) {
      return;
    }

    sendAttachmentMutation.mutate({
      file: imageAssetToUploadFile(asset),
      kind: 'image',
    });
  };

  const handlePickFile = async () => {
    if (sendAttachmentMutation.isPending) {
      return;
    }

    setAttachmentMenuVisible(false);

    const result = await DocumentPicker.getDocumentAsync({
      copyToCacheDirectory: true,
      multiple: false,
      type: '*/*',
    });

    if (result.canceled) {
      return;
    }

    const asset = result.assets[0];
    if (!asset) {
      return;
    }

    sendAttachmentMutation.mutate({
      file: documentAssetToUploadFile(asset),
      kind: asset.mimeType?.startsWith('image/') ? 'image' : 'file',
    });
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
              <IconButton
                disabled={startCallMutation.isPending}
                name="call"
                onPress={() => handleStartCall('voice')}
              />
              <IconButton
                disabled={startCallMutation.isPending}
                name="videocam"
                onPress={() => handleStartCall('video')}
              />
              {/*<IconButton
                name={conversation.kind === 'group' ? 'information-circle' : 'person-circle'}
              />*/}
            </View>
          </View>
        </View>

        {shouldShowActiveCallBanner && activeCall ? (
          <ActiveCallBanner callRoom={activeCall} onJoin={handleJoinActiveCall} />
        ) : null}

        <ScrollView
          className="flex-1"
          contentContainerStyle={{
            flexGrow: 1,
            paddingBottom: Math.max(insets.bottom, 12) + COMPOSER_EXPANDED_HEIGHT + 16,
            paddingHorizontal: 14,
            paddingTop: 14,
          }}
          keyboardShouldPersistTaps="handled"
          onContentSizeChange={handleContentSizeChange}
          onScroll={handleScroll}
          onScrollBeginDrag={() => {
            Keyboard.dismiss();
            setAttachmentMenuVisible(false);
          }}
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
                onRetryFailedMessage={handleRetryFailedMessage}
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

        <Animated.View
          pointerEvents={isAttachmentMenuTouchable ? 'auto' : 'none'}
          style={[StyleSheet.absoluteFill, { opacity: attachmentBackdropOpacity }]}
        >
          <Pressable className="flex-1 bg-black" onPress={() => setAttachmentMenuVisible(false)} />
        </Animated.View>

        <Animated.View
          className="absolute left-4 gap-2"
          pointerEvents={isAttachmentMenuTouchable ? 'auto' : 'none'}
          style={{
            bottom: Math.max(insets.bottom, 10) + COMPOSER_HEIGHT + 14,
            opacity: attachmentMenuOpacity,
            transform: [{ translateX: attachmentMenuTranslateX }, { scale: attachmentMenuScale }],
          }}
        >
          <Animated.View style={{ transform: [{ translateY: imageActionTranslateY }] }}>
            <AttachmentMenuAction
              accent="#a78bfa"
              icon="image"
              label="Send image"
              onPress={handlePickImage}
            />
          </Animated.View>
          <Animated.View style={{ transform: [{ translateY: fileActionTranslateY }] }}>
            <AttachmentMenuAction
              accent="#38bdf8"
              icon="document-text"
              label="Send file"
              onPress={handlePickFile}
            />
          </Animated.View>
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
              <Pressable
                className="h-[46px] w-[46px] items-center justify-center rounded-full bg-muted"
                onPress={handleToggleAttachmentMenu}
                style={styles.addButton}
              >
                <Animated.View style={{ transform: [{ rotate: addButtonRotate }] }}>
                  <Ionicons color="#f8fafc" name="add" size={22} />
                </Animated.View>
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
                  setAttachmentMenuVisible(false);
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
                <ComposerTool name="image" onPress={handlePickImage} />
                <ComposerTool name="document-text" onPress={handlePickFile} />
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
  fileToken?: string,
): ConversationView {
  if (!conversation) {
    return {
      id: '',
      kind: 'private',
      name: 'Chat',
      subtitle: '',
      accent: '#64748b',
      avatarUrl: null,
      avatarUserId: '',
      avatarUsername: 'Chat',
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
    avatarUrl: firstProfile ? getProfileAvatarUrl(pb, firstProfile, fileToken) : null,
    avatarUserId: firstProfile?.user || conversation.id,
    avatarUsername: firstProfile?.username || name,
    members: otherProfiles.map((profile) => profile.display_name || profile.username),
  };
}

function toChatMessage(
  message: MessageRecord,
  profilesByUserId: Map<string, ProfileRecord>,
  currentUserId: string,
  fileToken?: string,
  readLabel?: string,
): ChatMessage {
  const senderProfile = profilesByUserId.get(message.sender);
  const attachments = (message.attachments ?? []).map((attachment) => ({
    name: attachment,
    thumbUrl:
      message.kind === 'image'
        ? getMessageAttachmentUrl(pb, message, attachment, fileToken, '720x720')
        : undefined,
    url: getMessageAttachmentUrl(pb, message, attachment, fileToken),
  }));

  return {
    id: message.id,
    author: message.sender === currentUserId ? 'me' : 'them',
    attachments,
    callRoomId: message.call_room,
    created: message.created,
    kind: message.kind,
    readLabel,
    sender: senderProfile?.display_name || senderProfile?.username,
    senderId: message.sender,
    text: message.body,
    time: formatMessageTime(message.created),
  };
}

function toFailedChatMessage(message: FailedOutgoingMessage, currentUserId: string): ChatMessage {
  return {
    id: message.id,
    author: 'me',
    attachments: [],
    created: message.created,
    deliveryStatus: 'failed',
    failedMessageId: message.id,
    kind: 'text',
    senderId: currentUserId,
    text: message.body,
    time: formatMessageTime(message.created),
  };
}

function getLastReadOwnMessageId(
  messages: MessageRecord[],
  states: ConversationUserStateRecord[],
  currentUserId: string,
): string | null {
  const otherLastReadSeqs = states
    .filter((state) => state.user !== currentUserId)
    .map((state) => state.last_read_seq ?? 0)
    .filter((lastReadSeq) => lastReadSeq > 0);

  if (otherLastReadSeqs.length === 0) {
    return null;
  }

  const latestReadSeq = Math.max(...otherLastReadSeqs);
  const readOwnMessages = messages.filter((message) => {
    if (message.sender !== currentUserId) {
      return false;
    }

    return (message.message_seq ?? 0) > 0 && (message.message_seq ?? 0) <= latestReadSeq;
  });

  return readOwnMessages.at(-1)?.id ?? null;
}

function formatMessageTime(value: string): string {
  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return '';
  }

  return date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
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

function formatAttachmentName(name: string): string {
  return name.replace(/^\w+_/, '');
}

function getMessageFileCacheDirectory(): string | null {
  return FileSystem.cacheDirectory ? `${FileSystem.cacheDirectory}infchat-message-files/` : null;
}

function getLocalMessageFileUri(messageId: string, fileName: string): string | null {
  const directory = getMessageFileCacheDirectory();

  if (!directory) {
    return null;
  }

  return `${directory}${messageId}-${sanitizeFileName(fileName)}`;
}

function sanitizeFileName(name: string): string {
  const safeName = name
    .trim()
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
    .replace(/\s+/g, ' ')
    .slice(0, 120);

  return safeName || 'file';
}

function fitImageSize(width: number, height: number, windowWidth: number) {
  const maxWidth = Math.min(windowWidth * 0.74, 300);
  const maxHeight = 380;
  const ratio = Math.min(maxWidth / width, maxHeight / height, 1);

  return {
    height: Math.max(1, Math.round(height * ratio)),
    width: Math.max(1, Math.round(width * ratio)),
  };
}

function imageAssetToUploadFile(asset: ImagePicker.ImagePickerAsset): MessageUploadFile {
  const type = asset.mimeType || 'image/jpeg';
  const extension = type.split('/')[1] || 'jpg';

  return {
    name: asset.fileName || `image.${extension}`,
    type,
    uri: asset.uri,
  };
}

function documentAssetToUploadFile(asset: DocumentPicker.DocumentPickerAsset): MessageUploadFile {
  return {
    name: asset.name,
    type: asset.mimeType || 'application/octet-stream',
    uri: asset.uri,
  };
}

function ConversationIdentity({ conversation }: { conversation: ConversationView }) {
  const canOpenProfile = conversation.kind === 'private' && Boolean(conversation.avatarUserId);

  return (
    <Pressable
      className="min-w-0 flex-1 flex-row items-center gap-3"
      onPress={
        canOpenProfile
          ? () =>
              router.push({
                pathname: '/profile/[userId]',
                params: { userId: conversation.avatarUserId },
              })
          : undefined
      }
    >
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

function ActiveCallBanner({ callRoom, onJoin }: { callRoom: CallRoomRecord; onJoin: () => void }) {
  const isVideo = callRoom.kind === 'video';
  const ringingSecondsLeft = useRingingSecondsLeft(callRoom);
  const statusLabel =
    callRoom.status === 'ringing'
      ? ringingSecondsLeft === null
        ? 'Ringing'
        : `Ringing · ${ringingSecondsLeft}s left`
      : 'In progress';
  const title = `${isVideo ? 'Video call' : 'Voice call'} ${
    callRoom.status === 'ringing' ? 'is ringing' : 'is active'
  }`;

  return (
    <Pressable
      className="mx-3 mt-3 flex-row items-center rounded-[24px] border border-emerald-400/25 bg-emerald-400/10 p-3"
      onPress={onJoin}
    >
      <View className="h-11 w-11 items-center justify-center rounded-full bg-emerald-400">
        <Ionicons color="#080b12" name={isVideo ? 'videocam' : 'call'} size={20} />
      </View>
      <View className="ml-3 min-w-0 flex-1">
        <Text className="text-base font-black text-foreground">{title}</Text>
        <Text className="mt-0.5 text-sm font-semibold text-emerald-100/70">{statusLabel}</Text>
      </View>
      <View className="ml-3 flex-row items-center rounded-full bg-foreground px-3 py-2">
        <Text className="text-sm font-black text-background">Join</Text>
        <Ionicons color="#080b12" name="chevron-forward" size={16} />
      </View>
    </Pressable>
  );
}

function MessageBubble({
  conversation,
  index,
  message,
  onRetryFailedMessage,
  totalMessages,
}: {
  conversation: ConversationView;
  index: number;
  message: ChatMessage;
  onRetryFailedMessage: (messageId: string) => void;
  totalMessages: number;
}) {
  const { height: windowHeight, width: windowWidth } = useWindowDimensions();
  const opacity = useRef(new Animated.Value(0)).current;
  const translateY = useRef(new Animated.Value(12)).current;
  const imageAttachment = message.kind === 'image' ? message.attachments[0] : undefined;
  const fileAttachment = message.kind === 'file' ? message.attachments[0] : undefined;
  const cachedImageUrl = useCachedRemoteUri(
    imageAttachment?.url,
    imageAttachment ? `message-image:${message.id}:${imageAttachment.name}` : undefined,
  );
  const isMine = message.author === 'me';
  const hasText = message.text.trim().length > 0;
  const isFailed = message.deliveryStatus === 'failed';
  const fileName = fileAttachment ? message.text || formatAttachmentName(fileAttachment.name) : '';
  const localFileUri = fileAttachment ? getLocalMessageFileUri(message.id, fileName) : null;
  const [imageSize, setImageSize] = useState({ height: 210, width: 250 });
  const [isImageViewerVisible, setIsImageViewerVisible] = useState(false);
  const [isFilePreviewVisible, setIsFilePreviewVisible] = useState(false);
  const [fileDownloadState, setFileDownloadState] = useState<FileDownloadState>('idle');

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

  useEffect(() => {
    const uri = cachedImageUrl;
    if (!uri) {
      return;
    }

    Image.getSize(
      uri,
      (width, height) => setImageSize(fitImageSize(width, height, windowWidth)),
      () => setImageSize(fitImageSize(250, 210, windowWidth)),
    );
  }, [cachedImageUrl, windowWidth]);

  useEffect(() => {
    if (!localFileUri) {
      setFileDownloadState('idle');
      return;
    }

    let isMounted = true;
    setFileDownloadState('checking');

    FileSystem.getInfoAsync(localFileUri)
      .then((info) => {
        if (!isMounted) {
          return;
        }

        setFileDownloadState(info.exists ? 'downloaded' : 'idle');
      })
      .catch(() => {
        if (isMounted) {
          setFileDownloadState('idle');
        }
      });

    return () => {
      isMounted = false;
    };
  }, [localFileUri]);

  if (message.kind === 'call') {
    const isVideo = message.text.toLowerCase().includes('video');
    const isUnanswered =
      message.text.toLowerCase().includes('missed') ||
      message.text.toLowerCase().includes('declined') ||
      message.text.toLowerCase().includes('canceled');

    return (
      <Animated.View
        className="my-3 self-center rounded-full border border-border/70 bg-muted/70 px-4 py-2"
        style={{ opacity, transform: [{ translateY }] }}
      >
        <View className="flex-row items-center gap-2">
          <View
            className={`h-7 w-7 items-center justify-center rounded-full ${isUnanswered ? 'bg-red-500/20' : 'bg-emerald-400/20'}`}
          >
            <Ionicons
              color={isUnanswered ? '#fb7185' : '#34d399'}
              name={isVideo ? 'videocam' : 'call'}
              size={14}
            />
          </View>
          <Text className="text-sm font-bold text-foreground">{message.text || 'Call'}</Text>
          <Text className="text-xs font-semibold text-muted-foreground">{message.time}</Text>
        </View>
      </Animated.View>
    );
  }

  const handleOpenFile = async () => {
    if (!fileAttachment || !localFileUri) {
      Alert.alert('Could not download file', 'Local file storage is not available on this device.');
      return;
    }

    const cacheDirectory = getMessageFileCacheDirectory();
    if (!cacheDirectory) {
      Alert.alert('Could not download file', 'Local file storage is not available on this device.');
      return;
    }

    try {
      setFileDownloadState('downloading');

      const info = await FileSystem.getInfoAsync(localFileUri);
      let uriToOpen = localFileUri;

      if (!info.exists) {
        await FileSystem.makeDirectoryAsync(cacheDirectory, {
          intermediates: true,
        });
        const download = await FileSystem.downloadAsync(fileAttachment.url, localFileUri);
        uriToOpen = download.uri;
      }

      setFileDownloadState('downloaded');

      const canShare = await Sharing.isAvailableAsync();
      if (!canShare) {
        Alert.alert('File downloaded', 'This device cannot open local files from InfChat yet.');
        return;
      }

      await Sharing.shareAsync(uriToOpen, { dialogTitle: fileName });
      setIsFilePreviewVisible(false);
    } catch {
      setFileDownloadState('idle');
      Alert.alert('Could not open file', 'The file could not be downloaded. Try again later.');
    }
  };

  if (imageAttachment) {
    return (
      <Animated.View
        className={`mb-2 overflow-hidden rounded-[24px] bg-muted ${isMine ? 'self-end' : 'self-start'}`}
        style={{ opacity, transform: [{ translateY }] }}
      >
        <Pressable onPress={() => setIsImageViewerVisible(true)}>
          <Image
            resizeMode="cover"
            source={{ uri: cachedImageUrl ?? imageAttachment.url }}
            style={{ height: imageSize.height, width: imageSize.width }}
          />
          <View className="absolute bottom-2 right-2 rounded-full bg-black/45 px-2 py-1">
            <Text className="text-[11px] font-semibold text-white/90">{message.time}</Text>
          </View>
        </Pressable>
        <Modal
          animationType="fade"
          onRequestClose={() => setIsImageViewerVisible(false)}
          transparent
          visible={isImageViewerVisible}
        >
          <View className="flex-1 bg-black">
            <Pressable
              className="absolute right-5 top-14 z-10 h-11 w-11 items-center justify-center rounded-full bg-white/10"
              onPress={() => setIsImageViewerVisible(false)}
            >
              <Ionicons color="#fff" name="close" size={24} />
            </Pressable>
            <Pressable
              className="flex-1 items-center justify-center"
              onPress={() => setIsImageViewerVisible(false)}
            >
              <Image
                resizeMode="contain"
                source={{ uri: cachedImageUrl ?? imageAttachment.url }}
                style={{ height: windowHeight, width: windowWidth }}
              />
            </Pressable>
          </View>
        </Modal>
      </Animated.View>
    );
  }

  if (fileAttachment) {
    const isFileActionBusy =
      fileDownloadState === 'checking' || fileDownloadState === 'downloading';
    const fileActionLabel =
      fileDownloadState === 'downloading'
        ? 'Downloading...'
        : fileDownloadState === 'downloaded'
          ? 'Open downloaded file'
          : 'Download file';
    const fileStatusLabel = fileDownloadState === 'downloaded' ? 'downloaded' : 'tap to download';

    return (
      <Animated.View
        className={`mb-2 max-w-[78%] overflow-hidden rounded-[24px] ${isMine ? 'self-end bg-foreground' : 'self-start bg-muted'}`}
        style={{ opacity, transform: [{ translateY }] }}
      >
        <Pressable
          className="flex-row items-center gap-3 px-3 py-2.5"
          onPress={() => setIsFilePreviewVisible(true)}
        >
          <View
            className={`h-11 w-11 items-center justify-center rounded-[16px] ${isMine ? 'bg-background/10' : 'bg-background/55'}`}
          >
            <Ionicons color={isMine ? '#080b12' : '#f8fafc'} name="document-text" size={21} />
          </View>
          <View className="min-w-0 flex-1 pr-2">
            <Text
              className={`text-[15px] font-bold leading-5 ${isMine ? 'text-background' : 'text-foreground'}`}
              numberOfLines={2}
            >
              {fileName}
            </Text>
            <Text
              className={`mt-0.5 text-[11px] font-semibold ${isMine ? 'text-background/55' : 'text-muted-foreground'}`}
            >
              {fileStatusLabel} · {message.time}
            </Text>
          </View>
          <View
            className={`h-8 w-8 items-center justify-center rounded-full ${isMine ? 'bg-background/10' : 'bg-background/55'}`}
          >
            <Ionicons
              color={isMine ? '#080b12' : '#f8fafc'}
              name={fileDownloadState === 'downloaded' ? 'open-outline' : 'download-outline'}
              size={17}
            />
          </View>
        </Pressable>
        <Modal
          animationType="fade"
          onRequestClose={() => setIsFilePreviewVisible(false)}
          transparent
          visible={isFilePreviewVisible}
        >
          <View className="flex-1 justify-end bg-black/70">
            <Pressable className="flex-1" onPress={() => setIsFilePreviewVisible(false)} />
            <View className="rounded-t-[34px] bg-background px-5 pb-8 pt-5">
              <View className="mx-auto mb-5 h-1.5 w-12 rounded-full bg-muted" />
              <View className="items-center">
                <View className="h-16 w-16 items-center justify-center rounded-[24px] bg-muted">
                  <Ionicons color="#f8fafc" name="document-text" size={30} />
                </View>
                <Text
                  className="mt-4 text-center text-xl font-bold text-foreground"
                  numberOfLines={3}
                >
                  {fileName}
                </Text>
                <Text className="mt-2 text-sm font-semibold text-muted-foreground">
                  File preview is not available yet.
                </Text>
              </View>
              <Pressable
                className={`mt-6 h-[52px] items-center justify-center rounded-full ${isFileActionBusy ? 'bg-foreground/65' : 'bg-foreground'}`}
                disabled={isFileActionBusy}
                onPress={handleOpenFile}
              >
                <Text className="text-base font-bold text-background">{fileActionLabel}</Text>
              </Pressable>
              <Pressable
                className="mt-3 h-[52px] items-center justify-center rounded-full bg-muted"
                onPress={() => setIsFilePreviewVisible(false)}
              >
                <Text className="text-base font-bold text-foreground">Close</Text>
              </Pressable>
            </View>
          </View>
        </Modal>
      </Animated.View>
    );
  }

  return (
    <Animated.View style={{ opacity, transform: [{ translateY }] }}>
      <View className={`mb-2 flex-row items-end gap-2 ${isMine ? 'self-end' : 'self-start'}`}>
        {isFailed && message.failedMessageId ? (
          <Pressable
            className="mb-1 h-7 w-7 items-center justify-center rounded-full bg-red-500"
            onPress={() => onRetryFailedMessage(message.failedMessageId ?? '')}
          >
            <Ionicons color="#fff" name="alert" size={16} />
          </Pressable>
        ) : null}
        <View className="max-w-[82%]">
          <View
            className={`rounded-[24px] px-4 py-3 ${isFailed ? 'bg-foreground/80' : isMine ? 'bg-foreground' : 'bg-muted'}`}
            style={styles.bubble}
          >
            {!isMine && conversation.kind === 'group' && message.sender ? (
              <Text className="mb-1 text-xs font-bold text-primary">{message.sender}</Text>
            ) : null}
            {hasText || message.kind === 'text' ? (
              <Text
                className={`text-[16px] leading-5 ${isMine ? 'text-background' : 'text-foreground'}`}
              >
                {message.text}
                <Text style={styles.timestampPlaceholder}>{`      ${message.time}`}</Text>
              </Text>
            ) : (
              <Text style={styles.timestampPlaceholder}>{`      ${message.time}`}</Text>
            )}
            <Text
              className={`absolute bottom-3 right-4 text-[11px] font-medium ${
                isMine ? 'text-background/55' : 'text-muted-foreground'
              }`}
            >
              {message.time}
            </Text>
          </View>
          {message.readLabel || isFailed ? (
            <Text className="mt-1 self-end text-[11px] font-semibold text-muted-foreground">
              {isFailed ? 'Not sent' : message.readLabel}
            </Text>
          ) : null}
        </View>
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
      <ProfileAvatar
        avatarUrl={conversation.avatarUrl}
        name={conversation.name}
        size={avatarSize}
        userId={conversation.avatarUserId}
        username={conversation.avatarUsername}
      />
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

function AttachmentMenuAction({
  accent,
  icon,
  label,
  onPress,
}: {
  accent: string;
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  onPress: () => void;
}) {
  return (
    <Pressable
      className="h-[54px] flex-row items-center rounded-full border border-white/10 bg-background/95 py-1 pl-1 pr-4"
      onPress={onPress}
      style={styles.attachmentMenuAction}
    >
      <View
        className="h-[46px] w-[46px] items-center justify-center rounded-full"
        style={{ backgroundColor: accent }}
      >
        <Ionicons color="#080b12" name={icon} size={21} />
      </View>
      <Text className="ml-3 text-base font-black text-foreground">{label}</Text>
    </Pressable>
  );
}

function IconButton({
  disabled,
  name,
  onPress,
}: {
  disabled?: boolean;
  name: keyof typeof Ionicons.glyphMap;
  onPress?: () => void;
}) {
  return (
    <Pressable
      className={`h-10 w-10 items-center justify-center rounded-full bg-muted ${disabled ? 'opacity-40' : ''}`}
      disabled={disabled}
      onPress={onPress}
    >
      <Ionicons color="#f8fafc" name={name} size={20} />
    </Pressable>
  );
}

function ComposerTool({
  isPrimary,
  name,
  onPress,
}: {
  isPrimary?: boolean;
  name: keyof typeof Ionicons.glyphMap;
  onPress?: () => void;
}) {
  return (
    <Pressable
      className={`h-9 w-9 items-center justify-center rounded-full ${isPrimary ? 'bg-foreground' : 'bg-background/50'}`}
      onPress={onPress}
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
  addButton: {
    borderCurve: 'continuous',
    shadowColor: '#000',
    shadowOffset: { height: 8, width: 0 },
    shadowOpacity: 0.2,
    shadowRadius: 16,
  } as ViewStyle,
  attachmentMenuAction: {
    borderCurve: 'continuous',
    shadowColor: '#000',
    shadowOffset: { height: 12, width: 0 },
    shadowOpacity: 0.28,
    shadowRadius: 26,
  } as ViewStyle,
});
