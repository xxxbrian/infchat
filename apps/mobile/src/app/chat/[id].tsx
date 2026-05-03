import Ionicons from '@expo/vector-icons/Ionicons';
import {
  type AttachmentVariantRecord,
  type CallKind,
  type CallRoomRecord,
  type ConversationMembershipRecord,
  type ConversationRecord,
  getActiveCallForConversation,
  getMessageAttachmentUrl,
  getProfileAvatarUrl,
  type MediaAttachmentKind,
  type MediaUploadVariant,
  type MessageAttachmentRecord,
  type MessageRecord,
  type PresenceRecord,
  type ProfileRecord,
  type SignedMediaURLItem,
  type SignedMediaURLRequestItem,
  signMediaURLs,
  startCall,
} from '@infchat/pocketbase';
import { useNetInfo } from '@react-native-community/netinfo';
import { FlashList, type FlashListRef, type ListRenderItemInfo } from '@shopify/flash-list';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import * as DocumentPicker from 'expo-document-picker';
import * as FileSystem from 'expo-file-system/legacy';
import { Image as ExpoImage } from 'expo-image';
import * as ImagePicker from 'expo-image-picker';
import { router, useLocalSearchParams } from 'expo-router';
import * as Sharing from 'expo-sharing';
import { useVideoPlayer, VideoView, type VideoSource } from 'expo-video';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Animated,
  Easing,
  Keyboard,
  KeyboardAvoidingView,
  Modal,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  Platform,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  TextInput,
  type TextInputContentSizeChangeEventData,
  useWindowDimensions,
  View,
  type ViewStyle,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { ConversationAvatar } from '../../components/ConversationAvatar';
import { useAuth } from '../../lib/auth-context';
import { useCallSession } from '../../lib/call-context';
import { useRingingSecondsLeft } from '../../lib/call-countdown';
import { useChatSyncService } from '../../lib/chat-sync-context';
import {
  getEarliestLocalMessageSeq,
  getLocalConversation,
  getPreferredMediaCacheEntryForAttachment,
  listAvailableMediaCacheEntriesForConversation,
  listLocalAttachmentVariants,
  type LocalMediaCacheEntry,
  type LocalMediaOutboxAttachment,
  type LocalMediaOutboxState,
  listLocalMessageAttachments,
  type OutboxMessageState,
  listLocalMessagesFromSeq,
  listLocalMessagesBeforeSeq,
  listLocalMembershipsForConversation,
  listMediaOutboxMessagesForConversation,
  listOutboxMessagesForConversation,
  listRecentLocalMessages,
  touchMediaCacheEntry,
  upsertMediaCacheEntry,
} from '../../lib/chat-sync-store';
import { logDebugEvent } from '../../lib/debug-log';
import { getDeviceId } from '../../lib/device-id';
import { listCachedProfilesByUserIds, refreshCachedProfilesByUserIds } from '../../lib/local-cache';
import {
  cacheRemoteMediaFile,
  downloadRemoteMediaFile,
  type ManagedMediaCacheRecordInput,
  type MediaCacheDownloadProgress,
  useCachedRemoteUri,
} from '../../lib/media-cache';
import InfchatMediaTransfer from '../../../modules/infchat-media-transfer';
import {
  preparePickedDocumentAttachments,
  preparePickedMediaAttachments,
} from '../../lib/media-outbox-files';
import { pb } from '../../lib/pocketbase';
import { formatPresenceLabel, usePresence } from '../../lib/presence';

type ConversationView = {
  id: string;
  kind: ConversationRecord['kind'];
  conversation?: ConversationRecord;
  name: string;
  subtitle: string;
  avatarUrl?: string | null;
  avatarUserId: string;
  avatarUsername: string;
  isOnline?: boolean;
};

type ChatMessage = {
  id: string;
  author: 'me' | 'them';
  attachments: MessageAttachment[];
  callRoomId?: string;
  created: string;
  deliveryStatus?: 'failed' | 'pending' | 'retrying' | 'sending';
  failedMessageId?: string;
  kind: MessageRecord['kind'];
  localOnly?: boolean;
  readLabel?: string;
  sender?: string;
  senderId: string;
  text: string;
  time: string;
};

type MediaViewerState = {
  index: number;
  visible: boolean;
};

type ChatRenderItem =
  | { id: string; label: string; type: 'date' }
  | { id: string; index: number; message: ChatMessage; type: 'message' };

type MessageAttachment = {
  attachmentId?: string;
  blurhash?: string | null;
  byteSize?: number | null;
  cacheVariant?: MediaUploadVariant | 'file' | 'voice';
  conversationId?: string;
  durationMs?: number | null;
  height?: number | null;
  kind?: MediaAttachmentKind;
  messageId?: string;
  mimeType?: string | null;
  name: string;
  objectKey?: string;
  originalByteSize?: number | null;
  originalCacheKey?: string;
  originalDurationMs?: number | null;
  originalHeight?: number | null;
  originalLocalUri?: string;
  originalMimeType?: string | null;
  originalSha256?: string | null;
  originalVariantId?: string;
  originalWidth?: number | null;
  ordinal?: number;
  posterCacheKey?: string;
  posterLocalUri?: string;
  posterUrl?: string;
  previewCacheKey?: string;
  previewLocalUri?: string;
  previewUrl?: string;
  processingError?: string | null;
  processingStatus?: MessageAttachmentRecord['processing_status'];
  sha256?: string | null;
  thumbnailCacheKey?: string;
  thumbnailLocalUri?: string;
  thumbnailUrl?: string;
  thumbUrl?: string;
  url: string;
  variantId?: string;
  variantObjectKey?: string;
  width?: number | null;
};

type MediaPlaceholder = {
  blurhash: string;
  height: number;
  width: number;
};

type LocalMediaReplica = {
  attachments: MessageAttachmentRecord[];
  cacheEntries: LocalMediaCacheEntry[];
  variants: AttachmentVariantRecord[];
};

type FileDownloadState = 'idle' | 'checking' | 'downloading' | 'downloaded';

type VideoDownloadState = {
  localUri: string | null;
  progress: MediaCacheDownloadProgress | null;
  status: 'idle' | 'checking' | 'downloading' | 'downloaded';
};

type MediaTileFrame = {
  height: number;
  left: number;
  top: number;
  width: number;
};

type MediaAlbumLayout = {
  height: number;
  overflowCount: number;
  tiles: MediaTileFrame[];
  visibleCount: number;
  width: number;
};

type FailedOutgoingMessage = {
  body: string;
  created: string;
  id: string;
};

type MessageActionTarget = ChatMessage;

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
const CHAT_MESSAGE_PAGE_SIZE = 100;
const MEDIA_PICKER_SELECTION_LIMIT = 10;

export default function ChatDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const conversationId = id ?? '';
  const { authRecord } = useAuth();
  const { activeSession } = useCallSession();
  const chatSyncService = useChatSyncService();
  const queryClient = useQueryClient();
  const netInfo = useNetInfo();
  const insets = useSafeAreaInsets();
  const listRef = useRef<FlashListRef<ChatRenderItem>>(null);
  const didScrollToEnd = useRef(false);
  const isJumpButtonVisible = useRef(false);
  const lastScrollY = useRef(0);
  const composerProgress = useRef(new Animated.Value(0)).current;
  const composerInputExtraHeight = useRef(new Animated.Value(0)).current;
  const composerAttachmentProgress = useRef(new Animated.Value(1)).current;
  const attachmentMenuProgress = useRef(new Animated.Value(0)).current;
  const jumpButtonProgress = useRef(new Animated.Value(0)).current;
  const composerInputExtraHeightValue = useRef(0);
  const isLoadingOlderMessagesRef = useRef(false);
  const [composerText, setComposerText] = useState('');
  const [isComposerExpanded, setIsComposerExpanded] = useState(false);
  const [isAttachmentMenuOpen, setIsAttachmentMenuOpen] = useState(false);
  const [isAttachmentMenuTouchable, setIsAttachmentMenuTouchable] = useState(false);
  const [isPullRefreshing, setIsPullRefreshing] = useState(false);
  const [isLoadingOlderMessages, setIsLoadingOlderMessages] = useState(false);
  const [hasMoreOlderMessages, setHasMoreOlderMessages] = useState(true);
  const [messageWindowStartSeq, setMessageWindowStartSeq] = useState<number | null>(null);
  const [isJumpButtonTouchable, setIsJumpButtonTouchable] = useState(false);
  const [isComposerInputScrollable, setIsComposerInputScrollable] = useState(false);
  const [composerInputExtraHeightState, setComposerInputExtraHeightState] = useState(0);
  const [messageActionTarget, setMessageActionTarget] = useState<MessageActionTarget | null>(null);
  const [failedOutgoingMessages, setFailedOutgoingMessages] = useState<FailedOutgoingMessage[]>([]);
  const hasComposerText = composerText.trim().length > 0;
  const isOnline = Boolean(netInfo.isConnected && netInfo.isInternetReachable !== false);
  const isNearBottomRef = useRef(true);
  const scrollYRef = useRef(0);
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
    queryKey: ['chat', authRecord.id, 'messages', conversationId, messageWindowStartSeq],
    queryFn: () =>
      messageWindowStartSeq === null
        ? listRecentLocalMessages(authRecord.id, conversationId, CHAT_MESSAGE_PAGE_SIZE)
        : listLocalMessagesFromSeq(authRecord.id, conversationId, messageWindowStartSeq),
    enabled: Boolean(conversationId),
  });
  const localAttachmentsQuery = useQuery({
    queryKey: ['chat', authRecord.id, 'attachments', conversationId],
    queryFn: () => listLocalMessageAttachments(authRecord.id, conversationId),
    enabled: Boolean(conversationId),
  });
  const localAttachmentVariantsQuery = useQuery({
    queryKey: ['chat', authRecord.id, 'attachment-variants', conversationId],
    queryFn: () => listLocalAttachmentVariants(authRecord.id, conversationId),
    enabled: Boolean(conversationId),
  });
  const mediaCacheEntriesQuery = useQuery({
    queryKey: ['chat', authRecord.id, 'media-cache', conversationId],
    queryFn: () => listAvailableMediaCacheEntriesForConversation(authRecord.id, conversationId),
    enabled: Boolean(conversationId),
  });
  const signedMediaUrlRequests = useMemo(
    () =>
      signedMediaURLRequests(
        localAttachmentVariantsQuery.data ?? [],
        messagesQuery.data ?? [],
        localAttachmentsQuery.data ?? [],
        mediaCacheEntriesQuery.data ?? [],
      ),
    [
      localAttachmentVariantsQuery.data,
      localAttachmentsQuery.data,
      mediaCacheEntriesQuery.data,
      messagesQuery.data,
    ],
  );
  const signedMediaUrlsQuery = useQuery({
    queryKey: ['chat', authRecord.id, 'signed-media-urls', conversationId, signedMediaUrlRequests],
    queryFn: () => signMediaURLs(pb, signedMediaUrlRequests),
    enabled:
      isOnline &&
      signedMediaUrlRequests.length > 0 &&
      (mediaCacheEntriesQuery.isFetched || mediaCacheEntriesQuery.isError),
    staleTime: 1000 * 60 * 5,
  });
  const outboxMessagesQuery = useQuery({
    queryKey: ['chat', authRecord.id, 'outbox', conversationId],
    queryFn: () => listOutboxMessagesForConversation(authRecord.id, conversationId),
    enabled: Boolean(conversationId),
  });
  const mediaOutboxMessagesQuery = useQuery({
    queryKey: ['chat', authRecord.id, 'media-outbox', conversationId],
    queryFn: () => listMediaOutboxMessagesForConversation(authRecord.id, conversationId),
    enabled: Boolean(conversationId),
  });
  const activeCallQuery = useQuery({
    queryKey: ['active-call', conversationId],
    queryFn: () => getActiveCallForConversation(pb, conversationId),
    enabled: Boolean(conversationId),
  });
  const membershipsQuery = useQuery({
    queryKey: ['chat', authRecord.id, 'memberships', conversationId],
    queryFn: () => listLocalMembershipsForConversation(authRecord.id, conversationId),
    enabled: Boolean(conversationId),
  });
  const conversationMemberships = membershipsQuery.data ?? [];
  const memberIds = useMemo(
    () =>
      conversationMemberships
        .filter((membership) => membership.status === 'active' && membership.user !== authRecord.id)
        .map((membership) => membership.user)
        .sort(),
    [authRecord.id, conversationMemberships],
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
  const presenceQuery = usePresence(memberIds);
  const conversation = useMemo(
    () =>
      toConversationView(
        conversationQuery.data,
        profilesByUserId,
        authRecord.id,
        fileTokenQuery.data,
        conversationMemberships,
        presenceQuery.byUserId,
      ),
    [
      authRecord.id,
      conversationMemberships,
      conversationQuery.data,
      fileTokenQuery.data,
      presenceQuery.byUserId,
      profilesByUserId,
    ],
  );
  const localMediaReplica = useMemo<LocalMediaReplica>(
    () => ({
      attachments: localAttachmentsQuery.data ?? [],
      cacheEntries: mediaCacheEntriesQuery.data ?? [],
      variants: localAttachmentVariantsQuery.data ?? [],
    }),
    [localAttachmentVariantsQuery.data, localAttachmentsQuery.data, mediaCacheEntriesQuery.data],
  );
  const signedMediaUrlsByVariantId = useMemo(
    () => signedMediaURLByVariantId(signedMediaUrlsQuery.data?.items ?? []),
    [signedMediaUrlsQuery.data],
  );
  const messages = useMemo(() => {
    const readMessageId = getLastReadOwnMessageId(
      messagesQuery.data ?? [],
      conversationMemberships,
      authRecord.id,
    );
    const cachedMessages = (messagesQuery.data ?? []).map((message) =>
      toChatMessage(
        message,
        profilesByUserId,
        authRecord.id,
        fileTokenQuery.data,
        message.id === readMessageId ? 'Read' : undefined,
        localMediaReplica,
        signedMediaUrlsByVariantId,
      ),
    );
    const outboxMessages = (outboxMessagesQuery.data ?? []).map(
      (message): ChatMessage => ({
        id: `outbox-${message.client_message_id}`,
        author: 'me' as const,
        attachments: [],
        created: message.client_created_at,
        deliveryStatus: toOutboxDeliveryStatus(message.state),
        failedMessageId:
          message.state === 'failed_terminal' ? message.client_message_id : undefined,
        kind: 'text' as const,
        localOnly: true,
        senderId: authRecord.id,
        text: message.body,
        time: formatMessageTime(message.client_created_at),
      }),
    );
    const mediaOutboxMessages = (mediaOutboxMessagesQuery.data ?? []).map(
      (message): ChatMessage => ({
        id: `media-outbox-${message.client_message_id}`,
        author: 'me' as const,
        attachments: message.attachments.map((attachment) =>
          toOutboxMessageAttachment(message.client_message_id, attachment),
        ),
        created: message.client_created_at,
        deliveryStatus: toOutboxDeliveryStatus(message.state),
        failedMessageId:
          message.state === 'failed_terminal' ? message.client_message_id : undefined,
        kind: message.kind,
        localOnly: true,
        senderId: authRecord.id,
        text: message.body,
        time: formatMessageTime(message.client_created_at),
      }),
    );
    const failedMessages = failedOutgoingMessages.map((message) =>
      toFailedChatMessage(message, authRecord.id),
    );

    return [...cachedMessages, ...outboxMessages, ...mediaOutboxMessages, ...failedMessages];
  }, [
    authRecord.id,
    failedOutgoingMessages,
    fileTokenQuery.data,
    localMediaReplica,
    mediaOutboxMessagesQuery.data,
    messagesQuery.data,
    outboxMessagesQuery.data,
    profilesByUserId,
    signedMediaUrlsByVariantId,
    conversationMemberships,
  ]);
  const activeCall = activeCallQuery.data;
  const oldestLoadedSeq = useMemo(
    () => getOldestMessageSeq(messagesQuery.data ?? []),
    [messagesQuery.data],
  );
  const renderItems = useMemo(() => toChatRenderItems(messages), [messages]);
  const stickyHeaderIndices = useMemo(
    () =>
      renderItems
        .map((item, index) => (item.type === 'date' ? index : null))
        .filter((index): index is number => index !== null),
    [renderItems],
  );
  const dateIndexById = useMemo(() => {
    const indexById = new Map<string, number>();

    renderItems.forEach((item, index) => {
      if (item.type === 'date') {
        indexById.set(item.id, index);
      }
    });

    return indexById;
  }, [renderItems]);
  const listContentContainerStyle = useMemo(
    () => ({
      flexGrow: 1,
      paddingBottom:
        Math.max(insets.bottom, 12) +
        (isComposerExpanded ? COMPOSER_EXPANDED_HEIGHT : COMPOSER_HEIGHT) +
        composerInputExtraHeightState +
        16,
      paddingHorizontal: 14,
      paddingTop: 14,
    }),
    [composerInputExtraHeightState, insets.bottom, isComposerExpanded],
  );
  const maintainVisibleContentPosition = useMemo(
    () => ({
      animateAutoScrollToBottom: false,
      autoscrollToBottomThreshold: 0.2,
      startRenderingFromBottom: true,
    }),
    [],
  );
  const stickyHeaderConfig = useMemo(
    () => ({
      hideRelatedCell: true,
      offset: 0,
      useNativeDriver: true,
    }),
    [],
  );
  const emptyConversationLabel = conversationQuery.isLoading
    ? 'Loading messages'
    : messagesQuery.isLoading
      ? 'Loading messages'
      : conversationQuery.isError || messagesQuery.isError
        ? 'Could not load messages'
        : 'No messages yet';
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
      listRef.current?.scrollToEnd({ animated: false });
      requestAnimationFrame(() => listRef.current?.scrollToEnd({ animated: false }));
    });
  };
  const syncMessagesToBottomIfNearBottom = () => {
    if (isNearBottomRef.current) {
      syncMessagesToBottom();
    }
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
      syncMessagesToBottomIfNearBottom();
      animateComposer(1, event.duration ?? 240);
    });
    const hideSubscription = Keyboard.addListener(hideEvent, (event) => {
      setIsComposerExpanded(false);
      animateComposer(0, event.duration ?? 220);
    });
    const changeFrameSubscription =
      Platform.OS === 'ios'
        ? Keyboard.addListener('keyboardWillChangeFrame', () => {
            syncMessagesToBottomIfNearBottom();
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
    isLoadingOlderMessagesRef.current = false;
    scrollYRef.current = 0;
    lastScrollY.current = 0;
    setHasMoreOlderMessages(true);
    setIsLoadingOlderMessages(false);
    setMessageWindowStartSeq(null);
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

    if (isNewConversation || isNearBottomRef.current || lastMessage.senderId === authRecord.id) {
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
  const handleLoad = () => {
    if (didScrollToEnd.current) {
      return;
    }

    didScrollToEnd.current = true;
    requestAnimationFrame(() => listRef.current?.scrollToEnd({ animated: false }));
  };

  const handleJumpToBottom = () => {
    setJumpButtonVisible(false);
    listRef.current?.scrollToEnd({ animated: true });
  };

  const handlePressDateSeparator = (id: string) => {
    const index = dateIndexById.get(id);
    if (typeof index !== 'number') {
      return;
    }

    void listRef.current?.scrollToIndex({
      animated: true,
      index,
      viewPosition: 0,
    });
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

  const handleLoadOlderMessages = async () => {
    if (
      isLoadingOlderMessagesRef.current ||
      !conversationId ||
      !hasMoreOlderMessages ||
      messagesQuery.isLoading ||
      messagesQuery.isFetching
    ) {
      return;
    }

    isLoadingOlderMessagesRef.current = true;
    setIsLoadingOlderMessages(true);

    try {
      const currentOldestSeq =
        oldestLoadedSeq ?? (await getEarliestLocalMessageSeq(authRecord.id, conversationId));
      if (!currentOldestSeq) {
        setHasMoreOlderMessages(false);
        return;
      }

      let olderMessages = await listLocalMessagesBeforeSeq(
        authRecord.id,
        conversationId,
        currentOldestSeq,
        CHAT_MESSAGE_PAGE_SIZE,
      );

      if (olderMessages.length === 0 && !isOnline) {
        return;
      }

      if (olderMessages.length === 0) {
        await chatSyncService.syncConversationHistory(conversationId, currentOldestSeq);
        olderMessages = await listLocalMessagesBeforeSeq(
          authRecord.id,
          conversationId,
          currentOldestSeq,
          CHAT_MESSAGE_PAGE_SIZE,
        );
      }

      if (olderMessages.length === 0) {
        setHasMoreOlderMessages(false);
        return;
      }

      const nextOldestSeq = getOldestMessageSeq(olderMessages);
      if (nextOldestSeq) {
        setMessageWindowStartSeq(nextOldestSeq);
      }
    } catch (error) {
      void logDebugEvent('warn', 'chat-history', 'Could not load older messages', {
        conversationId,
        error: getErrorMessage(error, 'Unknown error'),
        oldestLoadedSeq,
      });
    } finally {
      isLoadingOlderMessagesRef.current = false;
      setIsLoadingOlderMessages(false);
    }
  };

  const renderChatItem = ({ item, target }: ListRenderItemInfo<ChatRenderItem>) => {
    if (item.type === 'date') {
      return (
        <DateSeparator
          id={item.id}
          isSticky={target === 'StickyHeader'}
          label={item.label}
          onPress={handlePressDateSeparator}
        />
      );
    }

    return (
      <MessageBubble
        authId={authRecord.id}
        conversation={conversation}
        message={item.message}
        onLongPressMessage={setMessageActionTarget}
        onRetryFailedMessage={handleRetryFailedMessage}
      />
    );
  };

  const handleScroll = (event: NativeSyntheticEvent<NativeScrollEvent>) => {
    const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
    const y = contentOffset.y;
    const distanceFromBottom = contentSize.height - layoutMeasurement.height - y;
    const deltaY = y - lastScrollY.current;
    scrollYRef.current = y;
    isNearBottomRef.current = distanceFromBottom < JUMP_BUTTON_NEAR_BOTTOM;

    if (distanceFromBottom < JUMP_BUTTON_NEAR_BOTTOM) {
      setJumpButtonVisible(false);
    } else if (distanceFromBottom > JUMP_BUTTON_FAR_FROM_BOTTOM) {
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
      setComposerInputExtraHeightState(0);
      setIsComposerInputScrollable(false);
      Animated.timing(composerInputExtraHeight, {
        toValue: 0,
        duration: 120,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: false,
      }).start(syncMessagesToBottomIfNearBottom);
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
    setComposerInputExtraHeightState(nextExtraHeight);
    setIsComposerInputScrollable(contentHeight > COMPOSER_INPUT_MAX_CONTENT_HEIGHT);
    Animated.timing(composerInputExtraHeight, {
      toValue: nextExtraHeight,
      duration: 120,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: false,
    }).start(syncMessagesToBottomIfNearBottom);
  };

  const handleSendMessage = () => {
    const body = composerText.trim();
    if (!body) {
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
    const failedOutboxMessage = outboxMessagesQuery.data?.find(
      (message) => message.client_message_id === messageId && message.state === 'failed_terminal',
    );
    if (failedOutboxMessage) {
      if (!isOnline) {
        Alert.alert('Still offline', 'Reconnect, then tap the red alert to resend.');
        return;
      }

      try {
        await chatSyncService.retryOutboxMessage(
          conversationId,
          failedOutboxMessage.client_message_id,
        );
        didScrollToEnd.current = false;
      } catch {
        Alert.alert('Could not resend', 'Check your connection and tap the alert again.');
      }
      return;
    }

    const failedMediaOutboxMessage = mediaOutboxMessagesQuery.data?.find(
      (message) => message.client_message_id === messageId && message.state === 'failed_terminal',
    );
    if (failedMediaOutboxMessage) {
      if (!isOnline) {
        Alert.alert('Still offline', 'Reconnect, then tap the red alert to resend.');
        return;
      }

      try {
        await chatSyncService.retryMediaOutboxMessage(
          conversationId,
          failedMediaOutboxMessage.client_message_id,
        );
        didScrollToEnd.current = false;
      } catch {
        Alert.alert('Could not resend', 'Check your connection and tap the alert again.');
      }
      return;
    }

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

  const handleDeleteMessage = async (message: ChatMessage) => {
    setMessageActionTarget(null);
    if (message.localOnly) {
      if (!message.failedMessageId) {
        return;
      }

      const failedMediaOutboxMessage = mediaOutboxMessagesQuery.data?.find(
        (mediaMessage) => mediaMessage.client_message_id === message.failedMessageId,
      );
      if (failedMediaOutboxMessage) {
        await chatSyncService.cancelFailedMediaOutboxMessage(
          conversationId,
          message.failedMessageId,
        );
        return;
      }

      await chatSyncService.cancelFailedOutboxMessage(conversationId, message.failedMessageId);
      return;
    }

    try {
      await chatSyncService.deleteMessages(conversationId, [message.id]);
      if (isNearBottomRef.current) {
        syncMessagesToBottom();
      }
    } catch (error) {
      Alert.alert(
        'Could not delete message',
        getErrorMessage(error, 'Check your connection and try again.'),
      );
    }
  };

  const confirmDeleteMessage = (message: ChatMessage) => {
    if (message.localOnly) {
      Alert.alert('Delete message?', 'This will remove the failed message from this device.', [
        { style: 'cancel', text: 'Cancel' },
        {
          onPress: () => void handleDeleteMessage(message),
          style: 'destructive',
          text: 'Delete',
        },
      ]);
      return;
    }

    Alert.alert('Delete for everyone?', 'This message will disappear for everyone in the chat.', [
      { style: 'cancel', text: 'Cancel' },
      {
        onPress: () => void handleDeleteMessage(message),
        style: 'destructive',
        text: 'Delete',
      },
    ]);
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
    setAttachmentMenuVisible(false);
    try {
      const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!permission.granted) {
        Alert.alert('Photos access needed', 'Allow photos access to send photos and videos.');
        return;
      }

      const result = await ImagePicker.launchImageLibraryAsync({
        allowsMultipleSelection: true,
        mediaTypes: ['images', 'videos'],
        orderedSelection: true,
        quality: 1,
        selectionLimit: MEDIA_PICKER_SELECTION_LIMIT,
        shouldDownloadFromNetwork: true,
      });

      if (result.canceled || result.assets.length === 0) {
        return;
      }

      const attachments = await preparePickedMediaAttachments(result.assets);
      if (attachments.length === 0) {
        Alert.alert('Could not send media', 'The selected media type is not supported yet.');
        return;
      }

      didScrollToEnd.current = false;
      await chatSyncService.enqueueMediaMessage({
        attachments,
        body: composerText.trim(),
        conversationId,
        kind: 'media',
      });
      setComposerText('');
      syncMessagesToBottom();
    } catch (error) {
      Alert.alert(
        'Could not send media',
        getErrorMessage(error, 'The selected media could not be prepared. Try again.'),
      );
    }
  };

  const handlePickFile = async () => {
    setAttachmentMenuVisible(false);
    try {
      const result = await DocumentPicker.getDocumentAsync({
        copyToCacheDirectory: true,
        multiple: false,
        type: '*/*',
      });

      if (result.canceled || result.assets.length === 0) {
        return;
      }

      const attachments = await preparePickedDocumentAttachments(result.assets.slice(0, 1));
      const attachment = attachments[0];
      if (!attachment) {
        return;
      }

      didScrollToEnd.current = false;
      await chatSyncService.enqueueMediaMessage({
        attachments: [attachment],
        body: composerText.trim(),
        conversationId,
        kind: 'file',
      });
      setComposerText('');
      syncMessagesToBottom();
    } catch (error) {
      Alert.alert(
        'Could not send file',
        getErrorMessage(error, 'The selected file could not be prepared. Try again.'),
      );
    }
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
              {conversation.kind === 'group' ? (
                <IconButton
                  name="information-circle"
                  onPress={() =>
                    router.push({
                      pathname: '/chat/[id]/info',
                      params: { id: conversation.id },
                    })
                  }
                />
              ) : null}
            </View>
          </View>
        </View>

        {shouldShowActiveCallBanner && activeCall ? (
          <ActiveCallBanner callRoom={activeCall} onJoin={handleJoinActiveCall} />
        ) : null}

        <View className="flex-1">
          <FlashList
            contentContainerStyle={listContentContainerStyle}
            data={renderItems}
            extraData={{
              conversation,
              totalMessages: messages.length,
            }}
            getItemType={(item) => item.type}
            keyboardShouldPersistTaps="handled"
            keyExtractor={(item) => item.id}
            ListEmptyComponent={<EmptyConversation label={emptyConversationLabel} />}
            ListHeaderComponent={isLoadingOlderMessages ? <OlderMessagesSpinner /> : null}
            maintainVisibleContentPosition={maintainVisibleContentPosition}
            onLoad={handleLoad}
            onScroll={handleScroll}
            onScrollBeginDrag={() => {
              Keyboard.dismiss();
              setAttachmentMenuVisible(false);
            }}
            onStartReached={handleLoadOlderMessages}
            onStartReachedThreshold={0.1}
            refreshControl={
              <RefreshControl
                colorsClassName="accent-foreground"
                onRefresh={handleRefresh}
                refreshing={isPullRefreshing}
                tintColorClassName="accent-foreground"
              />
            }
            ref={listRef}
            renderItem={renderChatItem}
            scrollEventThrottle={16}
            showsVerticalScrollIndicator={false}
            stickyHeaderConfig={stickyHeaderConfig}
            stickyHeaderIndices={stickyHeaderIndices}
          />
        </View>

        <MessageActionSheet
          message={messageActionTarget}
          onClose={() => setMessageActionTarget(null)}
          onDelete={confirmDeleteMessage}
        />

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
                  syncMessagesToBottomIfNearBottom();
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
  memberships: ConversationMembershipRecord[] = [],
  presenceByUserId = new Map<string, PresenceRecord>(),
): ConversationView {
  if (!conversation) {
    return {
      id: '',
      kind: 'private',
      name: 'Chat',
      subtitle: '',
      avatarUrl: null,
      avatarUserId: '',
      avatarUsername: 'Chat',
    };
  }

  const activeMemberIds = memberships
    .filter((membership) => membership.status === 'active')
    .map((membership) => membership.user);
  const otherMemberIds = activeMemberIds.filter((memberId) => memberId !== currentUserId);
  const otherProfiles = otherMemberIds
    .map((memberId) => profilesByUserId.get(memberId))
    .filter((profile): profile is ProfileRecord => Boolean(profile));
  const firstProfile = otherProfiles[0];
  const firstPresence = firstProfile ? presenceByUserId.get(firstProfile.user) : undefined;
  const name =
    conversation.kind === 'group'
      ? conversation.title ||
        otherProfiles.map((profile) => profile.display_name).join(', ') ||
        'Group chat'
      : firstProfile?.display_name || firstProfile?.username || 'Private chat';

  return {
    id: conversation.id,
    kind: conversation.kind,
    conversation,
    name,
    subtitle:
      conversation.kind === 'group'
        ? `${conversation.member_count ?? activeMemberIds.length} members`
        : formatPresenceLabel(firstPresence) || 'friend',
    avatarUrl: firstProfile ? getProfileAvatarUrl(pb, firstProfile, fileToken, 'thumb') : null,
    avatarUserId: firstProfile?.user || conversation.id,
    avatarUsername: firstProfile?.username || name,
    isOnline: firstPresence?.isOnline,
  };
}

function toChatMessage(
  message: MessageRecord,
  profilesByUserId: Map<string, ProfileRecord>,
  currentUserId: string,
  fileToken?: string,
  readLabel?: string,
  localMedia?: LocalMediaReplica,
  signedMediaUrlsByVariantId?: Map<string, SignedMediaURLItem>,
): ChatMessage {
  const senderProfile = profilesByUserId.get(message.sender);
  const attachments = toMessageAttachments(
    message,
    fileToken,
    localMedia,
    signedMediaUrlsByVariantId,
  );

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

function toMessageAttachments(
  message: MessageRecord,
  fileToken?: string,
  localMedia?: LocalMediaReplica,
  signedMediaUrlsByVariantId?: Map<string, SignedMediaURLItem>,
): MessageAttachment[] {
  const normalizedAttachments = (localMedia?.attachments ?? []).filter(
    (attachment) => attachment.message === message.id,
  );
  if (normalizedAttachments.length > 0) {
    const variantsByAttachmentId = variantsByAttachmentIdForMessage(
      message.id,
      localMedia?.variants ?? [],
    );

    return normalizedAttachments
      .slice()
      .sort(
        (left, right) =>
          (left.ordinal ?? 0) - (right.ordinal ?? 0) || left.id.localeCompare(right.id),
      )
      .map((attachment) =>
        toNormalizedMessageAttachment(
          attachment,
          variantsByAttachmentId.get(attachment.id) ?? [],
          localMedia?.cacheEntries ?? [],
          signedMediaUrlsByVariantId,
        ),
      )
      .filter((attachment): attachment is MessageAttachment => !!attachment);
  }

  return (message.attachments ?? []).map((attachment) => ({
    name: attachment,
    thumbUrl:
      message.kind === 'media'
        ? getMessageAttachmentUrl(pb, message, attachment, fileToken, '720x720')
        : undefined,
    url: getMessageAttachmentUrl(pb, message, attachment, fileToken),
  }));
}

function toOutboxMessageAttachment(
  clientMessageId: string,
  attachment: LocalMediaOutboxAttachment,
): MessageAttachment {
  const previewLocalUri =
    attachment.kind === 'video'
      ? (attachment.poster_local_uri ?? attachment.thumbnail_local_uri ?? attachment.local_uri)
      : (attachment.thumbnail_local_uri ?? attachment.local_uri);
  const originalCacheKey = mediaCacheKeyForVariant(
    clientMessageId,
    attachment.client_attachment_id,
    'original',
  );
  const displayCacheVariant = attachment.kind === 'video' ? 'poster' : 'preview';

  return {
    attachmentId: attachment.client_attachment_id,
    blurhash: attachment.blurhash,
    byteSize: attachment.byte_size,
    cacheVariant: displayCacheVariant,
    conversationId: attachment.conversation_id,
    durationMs: attachment.duration_ms,
    height: attachment.height,
    kind: attachment.kind,
    messageId: clientMessageId,
    mimeType: attachment.mime_type,
    name: attachment.original_name,
    originalByteSize: attachment.byte_size,
    originalCacheKey,
    originalDurationMs: attachment.duration_ms,
    originalHeight: attachment.height,
    originalLocalUri: attachment.local_uri,
    originalMimeType: attachment.mime_type,
    originalSha256: attachment.sha256,
    originalWidth: attachment.width,
    ordinal: attachment.ordinal,
    posterCacheKey:
      attachment.kind === 'video'
        ? mediaCacheKeyForVariant(clientMessageId, attachment.client_attachment_id, 'poster')
        : undefined,
    posterLocalUri: attachment.poster_local_uri ?? undefined,
    posterUrl: attachment.poster_local_uri ?? undefined,
    previewCacheKey: mediaCacheKeyForVariant(
      clientMessageId,
      attachment.client_attachment_id,
      displayCacheVariant,
    ),
    previewLocalUri,
    previewUrl: previewLocalUri,
    processingStatus: 'ready',
    sha256: attachment.sha256,
    thumbnailCacheKey: mediaCacheKeyForVariant(
      clientMessageId,
      attachment.client_attachment_id,
      'thumbnail',
    ),
    thumbnailLocalUri: attachment.thumbnail_local_uri ?? undefined,
    thumbnailUrl: attachment.thumbnail_local_uri ?? undefined,
    thumbUrl: previewLocalUri,
    url: attachment.local_uri,
    width: attachment.width,
  };
}

function toNormalizedMessageAttachment(
  attachment: MessageAttachmentRecord,
  variants: AttachmentVariantRecord[],
  cacheEntries: LocalMediaCacheEntry[],
  signedMediaUrlsByVariantId?: Map<string, SignedMediaURLItem>,
): MessageAttachment | null {
  const originalVariant = chooseVariant(variants, ['original']);
  const thumbnailVariant = chooseVariant(variants, ['thumbnail']);
  const previewImageVariant = chooseVariant(variants, ['preview']);
  const posterVariant = chooseVariant(variants, ['poster']);
  const previewVariant = choosePreviewVariantForAttachment(attachment, variants);
  if (!originalVariant && !previewVariant) {
    return null;
  }

  const primaryVariant = originalVariant ?? previewVariant;
  if (!primaryVariant) {
    return null;
  }

  const displayVariant = previewVariant ?? primaryVariant;
  const displayCacheVariant = attachment.kind === 'file' ? 'file' : displayVariant.variant;
  const originalCacheVariant = attachment.kind === 'file' ? 'file' : 'original';
  const originalCacheEntry = originalVariant
    ? cacheEntryForVariant(cacheEntries, attachment.id, originalCacheVariant)
    : null;
  const thumbnailCacheEntry = cacheEntryForVariant(cacheEntries, attachment.id, 'thumbnail');
  const previewImageCacheEntry = cacheEntryForVariant(cacheEntries, attachment.id, 'preview');
  const posterCacheEntry = cacheEntryForVariant(cacheEntries, attachment.id, 'poster');
  const displayCacheEntry = cacheEntryForVariant(cacheEntries, attachment.id, displayCacheVariant);
  const originalUrl = originalCacheEntry?.local_uri
    ? originalCacheEntry.local_uri
    : primaryVariant.variant === 'original'
      ? signedUrlForVariant(primaryVariant, signedMediaUrlsByVariantId)
      : null;
  const thumbnailUrl = thumbnailVariant
    ? thumbnailCacheEntry?.local_uri ||
      signedUrlForVariant(thumbnailVariant, signedMediaUrlsByVariantId)
    : null;
  const previewImageUrl = previewImageVariant
    ? previewImageCacheEntry?.local_uri ||
      signedUrlForVariant(previewImageVariant, signedMediaUrlsByVariantId)
    : null;
  const posterUrl = posterVariant
    ? posterCacheEntry?.local_uri || signedUrlForVariant(posterVariant, signedMediaUrlsByVariantId)
    : null;
  const previewUrl = previewVariant
    ? displayCacheEntry?.local_uri ||
      signedUrlForVariant(previewVariant, signedMediaUrlsByVariantId)
    : originalUrl;
  const displayUrl =
    displayCacheEntry?.local_uri ||
    (displayVariant.id === primaryVariant.id ? originalUrl : previewUrl);
  const displayMimeType =
    displayVariant.mime_type || attachment.mime_type || primaryVariant.mime_type || null;

  return {
    attachmentId: attachment.id,
    blurhash: attachment.blurhash,
    byteSize: displayVariant.byte_size ?? attachment.byte_size ?? primaryVariant.byte_size ?? null,
    cacheVariant: displayCacheVariant,
    conversationId: attachment.conversation,
    durationMs:
      displayVariant.duration_ms ?? attachment.duration_ms ?? primaryVariant.duration_ms ?? null,
    height: displayVariant.height ?? attachment.height ?? primaryVariant.height ?? null,
    kind: attachment.kind,
    messageId: attachment.message,
    mimeType: displayMimeType,
    name: attachment.original_name || 'attachment',
    objectKey: originalVariant?.object_key ?? displayVariant.object_key,
    originalByteSize: originalVariant?.byte_size ?? attachment.byte_size ?? null,
    originalCacheKey: originalVariant
      ? mediaCacheKeyForVariant(attachment.message, attachment.id, originalCacheVariant)
      : undefined,
    originalDurationMs: originalVariant?.duration_ms ?? attachment.duration_ms ?? null,
    originalHeight: originalVariant?.height ?? attachment.height ?? null,
    originalLocalUri: originalCacheEntry?.local_uri,
    originalMimeType: originalVariant?.mime_type || attachment.mime_type || null,
    originalSha256: originalVariant?.sha256 || attachment.sha256 || null,
    originalVariantId: originalVariant?.id,
    originalWidth: originalVariant?.width ?? attachment.width ?? null,
    ordinal: attachment.ordinal,
    posterCacheKey: posterVariant
      ? mediaCacheKeyForVariant(attachment.message, attachment.id, 'poster')
      : undefined,
    posterLocalUri: posterCacheEntry?.local_uri,
    posterUrl: posterUrl ?? undefined,
    previewCacheKey: mediaCacheKeyForVariant(
      attachment.message,
      attachment.id,
      displayCacheVariant,
    ),
    previewLocalUri: displayCacheEntry?.local_uri,
    previewUrl: previewImageUrl ?? previewUrl ?? undefined,
    processingError: attachment.processing_error,
    processingStatus: attachment.processing_status,
    sha256: displayVariant.sha256 || attachment.sha256 || primaryVariant.sha256 || null,
    thumbnailCacheKey: thumbnailVariant
      ? mediaCacheKeyForVariant(attachment.message, attachment.id, 'thumbnail')
      : undefined,
    thumbnailLocalUri: thumbnailCacheEntry?.local_uri,
    thumbnailUrl: thumbnailUrl ?? undefined,
    thumbUrl:
      attachment.kind === 'video' && displayVariant.variant === 'original'
        ? undefined
        : (displayUrl ?? undefined),
    url: originalUrl ?? displayUrl ?? '',
    variantId: primaryVariant.id,
    variantObjectKey:
      displayVariant.variant === displayCacheVariant ? displayVariant.object_key : undefined,
    width: displayVariant.width ?? attachment.width ?? primaryVariant.width ?? null,
  };
}

function choosePreviewVariantForAttachment(
  attachment: MessageAttachmentRecord,
  variants: AttachmentVariantRecord[],
): AttachmentVariantRecord | undefined {
  switch (attachment.kind) {
    case 'video':
      return chooseVariant(variants, ['poster', 'thumbnail', 'preview']);
    case 'image':
      return chooseVariant(variants, ['preview', 'thumbnail', 'original']);
    default:
      return chooseVariant(variants, ['original']);
  }
}

function variantsByAttachmentIdForMessage(
  messageId: string,
  variants: AttachmentVariantRecord[],
): Map<string, AttachmentVariantRecord[]> {
  const result = new Map<string, AttachmentVariantRecord[]>();
  for (const variant of variants) {
    if (variant.message !== messageId) {
      continue;
    }
    const attachmentVariants = result.get(variant.attachment) ?? [];
    attachmentVariants.push(variant);
    result.set(variant.attachment, attachmentVariants);
  }

  return result;
}

function chooseVariant(
  variants: AttachmentVariantRecord[],
  preference: MediaUploadVariant[],
): AttachmentVariantRecord | undefined {
  for (const variantName of preference) {
    const match = variants.find((variant) => variant.variant === variantName);
    if (match) {
      return match;
    }
  }

  return undefined;
}

function signedUrlForVariant(
  variant: AttachmentVariantRecord,
  signedMediaUrlsByVariantId?: Map<string, SignedMediaURLItem>,
): string | null {
  return signedMediaUrlsByVariantId?.get(variant.id)?.presigned.url ?? null;
}

function cacheEntryForVariant(
  entries: LocalMediaCacheEntry[],
  attachmentId: string,
  variant: MediaUploadVariant | 'file' | 'voice',
): LocalMediaCacheEntry | null {
  return (
    entries.find(
      (entry) =>
        entry.attachment_id === attachmentId &&
        entry.variant === variant &&
        entry.state === 'available' &&
        isLocalFileUri(entry.local_uri),
    ) ?? null
  );
}

function mediaCacheKeyForVariant(
  messageId: string,
  attachmentId: string,
  variant: MediaUploadVariant | 'file' | 'voice',
): string {
  return `message-media:${messageId}:${attachmentId}:${variant}`;
}

function signedMediaURLByVariantId(items: SignedMediaURLItem[]): Map<string, SignedMediaURLItem> {
  return new Map(items.map((item) => [item.variantId, item]));
}

function signedMediaURLRequests(
  variants: AttachmentVariantRecord[],
  messages: MessageRecord[],
  attachments: MessageAttachmentRecord[],
  cacheEntries: LocalMediaCacheEntry[],
): SignedMediaURLRequestItem[] {
  const visibleMessageIds = new Set(messages.map((message) => message.id));
  const attachmentById = new Map(attachments.map((attachment) => [attachment.id, attachment]));
  const variantsByAttachmentId = new Map<string, AttachmentVariantRecord[]>();
  for (const variant of variants) {
    if (!variant.message || !visibleMessageIds.has(variant.message)) {
      continue;
    }
    const attachmentVariants = variantsByAttachmentId.get(variant.attachment) ?? [];
    attachmentVariants.push(variant);
    variantsByAttachmentId.set(variant.attachment, attachmentVariants);
  }

  const requestedVariantIds = new Set<string>();
  const requests: SignedMediaURLRequestItem[] = [];
  for (const [attachmentId, attachmentVariants] of variantsByAttachmentId) {
    const attachment = attachmentById.get(attachmentId);
    if (!attachment || (attachment.kind !== 'image' && attachment.kind !== 'video')) {
      continue;
    }
    const variant = choosePreviewVariantForAttachment(attachment, attachmentVariants);
    if (!variant || !shouldPrefetchAttachmentVariant(attachment.kind, variant.variant)) {
      continue;
    }
    if (
      cacheEntryForVariant(cacheEntries, attachment.id, variant.variant) ||
      requestedVariantIds.has(variant.id)
    ) {
      continue;
    }
    requestedVariantIds.add(variant.id);
    requests.push({ variantId: variant.id });
  }

  return requests;
}

function shouldPrefetchAttachmentVariant(
  kind: MediaAttachmentKind,
  variant: MediaUploadVariant,
): boolean {
  if (kind === 'image') {
    return variant === 'preview';
  }
  if (kind === 'video') {
    return variant === 'poster' || variant === 'thumbnail';
  }

  return false;
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

function toOutboxDeliveryStatus(
  state: LocalMediaOutboxState | OutboxMessageState,
): ChatMessage['deliveryStatus'] {
  switch (state) {
    case 'queued':
    case 'starting_uploads':
      return 'pending';
    case 'uploading':
    case 'ready_to_send':
    case 'sending_create':
      return 'sending';
    case 'retry_wait':
      return 'retrying';
    case 'failed_terminal':
      return 'failed';
    default:
      return undefined;
  }
}

function toChatRenderItems(messages: ChatMessage[]): ChatRenderItem[] {
  const items: ChatRenderItem[] = [];
  let lastDateKey = '';

  messages.forEach((message, index) => {
    const dateKey = getMessageDateKey(message.created);
    if (dateKey && dateKey !== lastDateKey) {
      items.push({
        id: `date-${dateKey}`,
        label: formatMessageDate(message.created),
        type: 'date',
      });
      lastDateKey = dateKey;
    }

    items.push({
      id: message.id,
      index,
      message,
      type: 'message',
    });
  });

  return items;
}

function getOldestMessageSeq(messages: MessageRecord[]): number | null {
  for (const message of messages) {
    const seq = message.message_seq ?? 0;
    if (seq > 0) {
      return seq;
    }
  }

  return null;
}

function getMessageDateKey(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return '';
  }

  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

function formatMessageDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return '';
  }

  const today = new Date();
  const yesterday = new Date();
  yesterday.setDate(today.getDate() - 1);
  const dateKey = getMessageDateKey(value);

  if (dateKey === getMessageDateKey(today.toISOString())) {
    return 'Today';
  }

  if (dateKey === getMessageDateKey(yesterday.toISOString())) {
    return 'Yesterday';
  }

  const options: Intl.DateTimeFormatOptions = {
    day: 'numeric',
    month: 'short',
  };

  if (today.getFullYear() !== date.getFullYear()) {
    options.year = 'numeric';
  }

  return date.toLocaleDateString([], options);
}

function getLastReadOwnMessageId(
  messages: MessageRecord[],
  memberships: ConversationMembershipRecord[],
  currentUserId: string,
): string | null {
  const otherLastReadSeqs = memberships
    .filter((membership) => membership.status === 'active' && membership.user !== currentUserId)
    .map((membership) => membership.last_read_message_seq ?? 0)
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

function getAlbumLayout(attachments: MessageAttachment[], windowWidth: number): MediaAlbumLayout {
  const width = Math.round(Math.min(windowWidth * 0.78, 328));
  const gap = 2;
  const visibleCount = Math.min(attachments.length, 5);
  const overflowCount = Math.max(0, attachments.length - visibleCount);

  if (visibleCount <= 1) {
    const attachment = attachments[0];
    const aspectWidth = attachment?.width && attachment.width > 0 ? attachment.width : 4;
    const aspectHeight = attachment?.height && attachment.height > 0 ? attachment.height : 3;
    const ratio = Math.max(0.62, Math.min(1.35, aspectHeight / aspectWidth));
    const height = Math.round(Math.min(380, Math.max(190, width * ratio)));

    return {
      height,
      overflowCount,
      tiles: [{ height, left: 0, top: 0, width }],
      visibleCount,
      width,
    };
  }

  if (visibleCount === 2) {
    const tileWidth = Math.floor((width - gap) / 2);
    const height = Math.round(tileWidth * 1.18);

    return {
      height,
      overflowCount,
      tiles: [
        { height, left: 0, top: 0, width: tileWidth },
        {
          height,
          left: tileWidth + gap,
          top: 0,
          width: width - tileWidth - gap,
        },
      ],
      visibleCount,
      width,
    };
  }

  if (visibleCount === 3) {
    const largeWidth = Math.floor(width * 0.63);
    const smallWidth = width - largeWidth - gap;
    const height = Math.round(width * 0.78);
    const smallHeight = Math.floor((height - gap) / 2);

    return {
      height,
      overflowCount,
      tiles: [
        { height, left: 0, top: 0, width: largeWidth },
        {
          height: smallHeight,
          left: largeWidth + gap,
          top: 0,
          width: smallWidth,
        },
        {
          height: height - smallHeight - gap,
          left: largeWidth + gap,
          top: smallHeight + gap,
          width: smallWidth,
        },
      ],
      visibleCount,
      width,
    };
  }

  const tileWidth = Math.floor((width - gap) / 2);
  const height = visibleCount === 4 ? width : Math.round(width * 1.12);
  const rowHeight = Math.floor((height - gap) / 2);
  const bottomColumns = visibleCount === 5 ? 3 : 2;
  const bottomGapTotal = gap * (bottomColumns - 1);
  const bottomTileWidth = Math.floor((width - bottomGapTotal) / bottomColumns);
  const tiles: MediaTileFrame[] = [
    { height: rowHeight, left: 0, top: 0, width: tileWidth },
    {
      height: rowHeight,
      left: tileWidth + gap,
      top: 0,
      width: width - tileWidth - gap,
    },
  ];

  for (let index = 0; index < bottomColumns && tiles.length < visibleCount; index += 1) {
    const left = index * (bottomTileWidth + gap);
    const isLast = index === bottomColumns - 1;
    tiles.push({
      height: height - rowHeight - gap,
      left,
      top: rowHeight + gap,
      width: isLast ? width - left : bottomTileWidth,
    });
  }

  return { height, overflowCount, tiles, visibleCount, width };
}

function getMediaTileImageUrl(attachment: MessageAttachment): string | undefined {
  if (attachment.kind === 'video') {
    return attachment.posterUrl || attachment.thumbnailUrl || attachment.thumbUrl;
  }

  return (
    attachment.previewUrl ||
    attachment.thumbnailUrl ||
    attachment.thumbUrl ||
    attachment.url ||
    undefined
  );
}

function dominantMediaPlaceholder(attachment: MessageAttachment): MediaPlaceholder {
  return {
    blurhash: attachment.blurhash ?? 'L25OQ+xu00oL~qofD%j[4nay?bof',
    height: 16,
    width: 16,
  };
}

function mediaDisplayCacheKey(
  messageId: string,
  attachment: MessageAttachment,
): string | undefined {
  if (attachment.kind === 'video' && attachment.posterCacheKey) {
    return attachment.posterCacheKey;
  }
  if (attachment.previewCacheKey) {
    return attachment.previewCacheKey;
  }
  if (attachment.thumbnailCacheKey) {
    return attachment.thumbnailCacheKey;
  }
  const keyPart = attachment.attachmentId ?? attachment.name;
  if (!keyPart) {
    return undefined;
  }

  return mediaCacheKeyForVariant(messageId, keyPart, attachment.cacheVariant ?? 'preview');
}

function fileCacheKey(messageId: string, attachment: MessageAttachment): string {
  if (attachment.originalCacheKey) {
    return attachment.originalCacheKey;
  }
  if (attachment.attachmentId) {
    return mediaCacheKeyForVariant(messageId, attachment.attachmentId, 'file');
  }

  return `message-file:${messageId}:${attachment.name}`;
}

function mediaDisplayCacheRecord(authId: string, attachment: MessageAttachment) {
  if (
    !attachment.attachmentId ||
    !attachment.conversationId ||
    !attachment.messageId ||
    !attachment.objectKey ||
    !attachment.variantObjectKey
  ) {
    return undefined;
  }

  const variant = attachment.cacheVariant ?? (attachment.kind === 'video' ? 'poster' : 'preview');

  return {
    attachmentId: attachment.attachmentId,
    authId,
    byteSize: attachment.byteSize,
    conversationId: attachment.conversationId,
    durationMs: attachment.durationMs,
    height: attachment.height,
    fileName: attachment.name,
    messageId: attachment.messageId,
    mimeType: attachment.mimeType,
    protectedReason: attachment.kind === 'video' ? 'visible-video-poster' : 'visible-media-preview',
    remoteObjectKey: attachment.variantObjectKey,
    sha256: attachment.sha256,
    variant,
    width: attachment.width,
  } satisfies ManagedMediaCacheRecordInput;
}

function originalMediaCacheRecord(
  authId: string,
  attachment: MessageAttachment,
): ManagedMediaCacheRecordInput | undefined {
  if (
    !attachment.attachmentId ||
    !attachment.conversationId ||
    !attachment.messageId ||
    !attachment.objectKey
  ) {
    return undefined;
  }

  return {
    attachmentId: attachment.attachmentId,
    authId,
    byteSize: attachment.originalByteSize ?? attachment.byteSize,
    conversationId: attachment.conversationId,
    durationMs: attachment.originalDurationMs ?? attachment.durationMs,
    height: attachment.originalHeight ?? attachment.height,
    fileName: attachment.name,
    messageId: attachment.messageId,
    mimeType: attachment.originalMimeType ?? attachment.mimeType,
    protectedReason: 'opened-original',
    remoteObjectKey: attachment.objectKey,
    sha256: attachment.originalSha256 ?? attachment.sha256,
    variant: 'original',
    width: attachment.originalWidth ?? attachment.width,
  };
}

async function persistDownloadedAttachment(
  authId: string,
  attachment: MessageAttachment,
  localUri: string,
  cacheKey: string,
  localByteSize?: number,
  variant?: MediaUploadVariant | 'file' | 'voice',
) {
  if (
    !attachment.attachmentId ||
    !attachment.conversationId ||
    !attachment.messageId ||
    !attachment.objectKey
  ) {
    return;
  }

  const cacheVariant =
    variant ?? attachment.cacheVariant ?? (attachment.kind === 'file' ? 'file' : 'original');

  await upsertMediaCacheEntry(authId, {
    attachmentId: attachment.attachmentId,
    byteSize:
      cacheVariant === 'original'
        ? (attachment.originalByteSize ?? attachment.byteSize ?? localByteSize)
        : (attachment.byteSize ?? localByteSize),
    cacheKey,
    conversationId: attachment.conversationId,
    durationMs:
      cacheVariant === 'original'
        ? (attachment.originalDurationMs ?? attachment.durationMs)
        : attachment.durationMs,
    height:
      cacheVariant === 'original'
        ? (attachment.originalHeight ?? attachment.height)
        : attachment.height,
    localUri,
    messageId: attachment.messageId,
    mimeType:
      cacheVariant === 'original'
        ? (attachment.originalMimeType ?? attachment.mimeType)
        : attachment.mimeType,
    pinned: true,
    protectedReason: attachment.kind === 'file' ? 'downloaded-file' : 'downloaded-media',
    remoteObjectKey: attachment.objectKey,
    sha256:
      cacheVariant === 'original'
        ? (attachment.originalSha256 ?? attachment.sha256)
        : attachment.sha256,
    state: 'available',
    variant: cacheVariant,
    width:
      cacheVariant === 'original'
        ? (attachment.originalWidth ?? attachment.width)
        : attachment.width,
  });
  await touchMediaCacheEntry(authId, cacheKey);
}

async function resolveLocalAttachmentOriginalUri(
  authId: string,
  attachment: MessageAttachment,
): Promise<string | null> {
  if (attachment.originalLocalUri && (await localFileExists(attachment.originalLocalUri))) {
    return attachment.originalLocalUri;
  }
  if (attachment.attachmentId) {
    const cachedOriginal = await getPreferredMediaCacheEntryForAttachment(
      authId,
      attachment.attachmentId,
      [attachment.kind === 'file' ? 'file' : 'original'],
    );
    if (cachedOriginal?.local_uri && (await localFileExists(cachedOriginal.local_uri))) {
      await touchMediaCacheEntry(authId, cachedOriginal.cache_key);
      return cachedOriginal.local_uri;
    }
  }
  if (
    isLocalFileUri(attachment.url) &&
    attachmentUrlMayBeOriginal(attachment) &&
    (await localFileExists(attachment.url))
  ) {
    return attachment.url;
  }

  return null;
}

function attachmentUrlMayBeOriginal(attachment: MessageAttachment): boolean {
  if (!attachment.attachmentId) {
    return true;
  }
  if (attachment.kind === 'file') {
    return true;
  }

  return attachment.cacheVariant === 'original' || attachment.cacheVariant === 'voice';
}

async function downloadAttachmentOriginalFile(
  authId: string,
  attachment: MessageAttachment,
  onProgress?: (progress: MediaCacheDownloadProgress) => void,
): Promise<string> {
  const existingLocalUri = await resolveLocalAttachmentOriginalUri(authId, attachment);
  const cacheKey =
    attachment.originalCacheKey ??
    (attachment.attachmentId && attachment.messageId
      ? mediaCacheKeyForVariant(attachment.messageId, attachment.attachmentId, 'original')
      : null);

  if (existingLocalUri) {
    if (cacheKey) {
      const existingInfo = await FileSystem.getInfoAsync(existingLocalUri).catch(() => null);
      await persistDownloadedAttachment(
        authId,
        attachment,
        existingLocalUri,
        cacheKey,
        existingInfo?.exists && !existingInfo.isDirectory ? existingInfo.size : undefined,
        'original',
      );
    }
    return existingLocalUri;
  }

  const remoteUrl = await resolveAttachmentOriginalUrl(authId, attachment, {
    cache: false,
  });
  if (!remoteUrl) {
    throw new Error('Original media URL is not available.');
  }

  if (isLocalFileUri(remoteUrl)) {
    if (cacheKey) {
      const localInfo = await FileSystem.getInfoAsync(remoteUrl).catch(() => null);
      await persistDownloadedAttachment(
        authId,
        attachment,
        remoteUrl,
        cacheKey,
        localInfo?.exists && !localInfo.isDirectory ? localInfo.size : undefined,
        'original',
      );
    }
    return remoteUrl;
  }

  const cacheRecord = originalMediaCacheRecord(authId, attachment);
  if (!cacheKey || !cacheRecord) {
    throw new Error('Original media cache metadata is not available.');
  }

  const localUri = await downloadRemoteMediaFile(
    remoteUrl,
    cacheKey,
    {
      ...cacheRecord,
      pinned: true,
      protectedReason: 'downloaded-media',
    },
    onProgress,
  );
  if (!localUri) {
    throw new Error('Original media download failed.');
  }

  const downloadedInfo = await FileSystem.getInfoAsync(localUri).catch(() => null);
  await persistDownloadedAttachment(
    authId,
    attachment,
    localUri,
    cacheKey,
    downloadedInfo?.exists && !downloadedInfo.isDirectory ? downloadedInfo.size : undefined,
    'original',
  );

  return localUri;
}

async function openDocumentWithNativePreview(
  localUri: string,
  fileName: string,
  mimeType?: string | null,
) {
  try {
    await InfchatMediaTransfer.openDocumentAsync({
      fileName,
      localUri,
      mimeType,
      title: fileName,
    });
    return;
  } catch {
    const canShare = await Sharing.isAvailableAsync();
    if (!canShare) {
      throw new Error('No document preview is available.');
    }
    await Sharing.shareAsync(localUri, {
      dialogTitle: fileName,
      mimeType: mimeType ?? undefined,
    });
  }
}

async function resolveAttachmentOriginalUrl(
  authId: string,
  attachment: MessageAttachment,
  options?: { cache?: boolean },
): Promise<string | null> {
  const localUri = await resolveLocalAttachmentOriginalUri(authId, attachment);
  if (localUri) {
    return localUri;
  }
  const request: SignedMediaURLRequestItem | null = attachment.attachmentId
    ? { attachmentId: attachment.attachmentId, variant: 'original' }
    : attachment.variantId
      ? { variantId: attachment.variantId }
      : null;
  if (!request) {
    return null;
  }

  const response = await signMediaURLs(pb, [request]);

  const remoteUrl = response.items[0]?.presigned.url ?? null;
  if (options?.cache === false || attachment.kind !== 'image') {
    return remoteUrl;
  }
  const cacheKey =
    attachment.originalCacheKey ??
    (attachment.attachmentId && attachment.messageId
      ? mediaCacheKeyForVariant(attachment.messageId, attachment.attachmentId, 'original')
      : null);
  const cacheRecord = originalMediaCacheRecord(authId, attachment);
  if (remoteUrl && cacheKey && cacheRecord) {
    return (await cacheRemoteMediaFile(remoteUrl, cacheKey, cacheRecord)) ?? remoteUrl;
  }
  return remoteUrl;
}

function isLocalFileUri(uri?: string | null): boolean {
  return Boolean(uri && uri.startsWith('file://'));
}

async function localFileExists(uri: string): Promise<boolean> {
  if (!isLocalFileUri(uri)) {
    return true;
  }
  const info = await FileSystem.getInfoAsync(uri).catch(() => null);

  return Boolean(info?.exists && !info.isDirectory);
}

function formatDuration(durationMs: number | null | undefined): string {
  if (!durationMs || durationMs <= 0) {
    return '';
  }

  const totalSeconds = Math.max(0, Math.round(durationMs / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) {
    return `${hours}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
  }

  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}

function formatFileSize(byteSize: number | null | undefined): string {
  if (!byteSize || byteSize <= 0) {
    return '';
  }

  const units = ['B', 'KB', 'MB', 'GB'] as const;
  let size = byteSize;
  let unitIndex = 0;
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }

  const precision = unitIndex === 0 || size >= 10 ? 0 : 1;
  return `${size.toFixed(precision)} ${units[unitIndex]}`;
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
  authId,
  conversation,
  message,
  onLongPressMessage,
  onRetryFailedMessage,
}: {
  authId: string;
  conversation: ConversationView;
  message: ChatMessage;
  onLongPressMessage: (message: ChatMessage) => void;
  onRetryFailedMessage: (messageId: string) => void;
}) {
  const fileAttachment = message.kind === 'file' ? message.attachments[0] : undefined;
  const isMine = message.author === 'me';
  const hasText = message.text.trim().length > 0;
  const isFailed = message.deliveryStatus === 'failed';
  const deliveryLabel = getDeliveryLabel(message.deliveryStatus);

  if (message.kind === 'call') {
    const isVideo = message.text.toLowerCase().includes('video');
    const isUnanswered =
      message.text.toLowerCase().includes('missed') ||
      message.text.toLowerCase().includes('declined') ||
      message.text.toLowerCase().includes('canceled');

    return (
      <View className="my-3 self-center rounded-full border border-border/70 bg-muted/70 px-4 py-2">
        <Pressable
          className="flex-row items-center gap-2"
          onLongPress={() => onLongPressMessage(message)}
        >
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
        </Pressable>
      </View>
    );
  }

  if (message.kind === 'media' && message.attachments.length > 0) {
    return (
      <MediaAlbumBubble
        authId={authId}
        conversation={conversation}
        deliveryLabel={deliveryLabel}
        isFailed={isFailed}
        isMine={isMine}
        message={message}
        onLongPressMessage={onLongPressMessage}
        onRetryFailedMessage={onRetryFailedMessage}
      />
    );
  }

  if (fileAttachment) {
    return (
      <FileMessageBubble
        authId={authId}
        deliveryLabel={deliveryLabel}
        fileAttachment={fileAttachment}
        isFailed={isFailed}
        isMine={isMine}
        message={message}
        onLongPressMessage={onLongPressMessage}
        onRetryFailedMessage={onRetryFailedMessage}
      />
    );
  }

  return (
    <TextMessageBubble
      conversation={conversation}
      deliveryLabel={deliveryLabel}
      hasText={hasText}
      isFailed={isFailed}
      isMine={isMine}
      message={message}
      onLongPressMessage={onLongPressMessage}
      onRetryFailedMessage={onRetryFailedMessage}
    />
  );
}

function TextMessageBubble({
  conversation,
  deliveryLabel,
  hasText,
  isFailed,
  isMine,
  message,
  onLongPressMessage,
  onRetryFailedMessage,
}: {
  conversation: ConversationView;
  deliveryLabel?: string;
  hasText: boolean;
  isFailed: boolean;
  isMine: boolean;
  message: ChatMessage;
  onLongPressMessage: (message: ChatMessage) => void;
  onRetryFailedMessage: (messageId: string) => void;
}) {
  return (
    <View>
      <View className={`mb-2 flex-row items-end gap-2 ${isMine ? 'self-end' : 'self-start'}`}>
        <FailedRetryButton
          failedMessageId={message.failedMessageId}
          isFailed={isFailed}
          onRetryFailedMessage={onRetryFailedMessage}
        />
        <Pressable className="max-w-[82%]" onLongPress={() => onLongPressMessage(message)}>
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
          <BubbleDeliveryLabel deliveryLabel={deliveryLabel} message={message} />
        </Pressable>
      </View>
    </View>
  );
}

function MediaAlbumBubble({
  authId,
  conversation,
  deliveryLabel,
  isFailed,
  isMine,
  message,
  onLongPressMessage,
  onRetryFailedMessage,
}: {
  authId: string;
  conversation: ConversationView;
  deliveryLabel?: string;
  isFailed: boolean;
  isMine: boolean;
  message: ChatMessage;
  onLongPressMessage: (message: ChatMessage) => void;
  onRetryFailedMessage: (messageId: string) => void;
}) {
  const { width: windowWidth } = useWindowDimensions();
  const [viewer, setViewer] = useState<MediaViewerState>({
    index: 0,
    visible: false,
  });
  const hasText = message.text.trim().length > 0;
  const layout = getAlbumLayout(message.attachments, windowWidth);

  return (
    <View>
      <View className={`mb-2 flex-row items-end gap-2 ${isMine ? 'self-end' : 'self-start'}`}>
        <FailedRetryButton
          failedMessageId={message.failedMessageId}
          isFailed={isFailed}
          onRetryFailedMessage={onRetryFailedMessage}
        />
        <View
          className={`overflow-hidden rounded-[24px] ${isMine ? 'bg-foreground' : 'bg-muted'}`}
          style={[styles.bubble, { width: layout.width }]}
        >
          <Pressable onLongPress={() => onLongPressMessage(message)}>
            {!isMine && conversation.kind === 'group' && message.sender ? (
              <Text className="px-3 pt-2 text-xs font-bold text-primary">{message.sender}</Text>
            ) : null}
          </Pressable>
          <View style={{ height: layout.height, width: layout.width }}>
            {message.attachments.slice(0, layout.visibleCount).map((attachment, index) => {
              const frame = layout.tiles[index];
              if (!frame) {
                return null;
              }

              return (
                <MediaAlbumTile
                  attachment={attachment}
                  authId={authId}
                  frame={frame}
                  key={attachment.attachmentId ?? `${message.id}-${index}`}
                  messageId={message.id}
                  onPress={() => setViewer({ index, visible: true })}
                  overflowCount={index === layout.visibleCount - 1 ? layout.overflowCount : 0}
                />
              );
            })}
            {!hasText ? (
              <View className="absolute bottom-2 right-2 rounded-full bg-black/55 px-2 py-1">
                <Text className="text-[11px] font-semibold text-white/90">{message.time}</Text>
              </View>
            ) : null}
          </View>
          {hasText ? (
            <Pressable
              className="px-3 py-2"
              onLongPress={() => onLongPressMessage(message)}
              onPress={() => setViewer({ index: 0, visible: true })}
            >
              <Text
                className={`text-[15px] leading-5 ${isMine ? 'text-background' : 'text-foreground'}`}
              >
                {message.text}
                <Text style={styles.timestampPlaceholder}>{`      ${message.time}`}</Text>
              </Text>
              <Text
                className={`absolute bottom-2 right-3 text-[11px] font-medium ${
                  isMine ? 'text-background/55' : 'text-muted-foreground'
                }`}
              >
                {message.time}
              </Text>
            </Pressable>
          ) : null}
          <MediaGalleryModal
            attachments={message.attachments}
            authId={authId}
            initialIndex={viewer.index}
            onClose={() => setViewer((current) => ({ ...current, visible: false }))}
            visible={viewer.visible}
          />
        </View>
      </View>
      <BubbleDeliveryLabel deliveryLabel={deliveryLabel} message={message} />
    </View>
  );
}

function useVideoOriginalDownload(
  authId: string,
  attachment: MessageAttachment | null,
): VideoDownloadState & { downloadOriginal: () => Promise<string | null> } {
  const queryClient = useQueryClient();
  const [downloadState, setDownloadState] = useState<VideoDownloadState>({
    localUri: null,
    progress: null,
    status: 'idle',
  });

  useEffect(() => {
    let isMounted = true;
    if (!attachment || attachment.kind !== 'video') {
      setDownloadState({ localUri: null, progress: null, status: 'idle' });
      return;
    }

    setDownloadState((current) =>
      current.status === 'downloading'
        ? current
        : { localUri: current.localUri, progress: null, status: 'checking' },
    );

    resolveLocalAttachmentOriginalUri(authId, attachment)
      .then((localUri) => {
        if (!isMounted) {
          return;
        }
        setDownloadState((current) =>
          current.status === 'downloading'
            ? current
            : {
                localUri,
                progress: null,
                status: localUri ? 'downloaded' : 'idle',
              },
        );
      })
      .catch(() => {
        if (isMounted) {
          setDownloadState((current) =>
            current.status === 'downloading'
              ? current
              : { localUri: null, progress: null, status: 'idle' },
          );
        }
      });

    return () => {
      isMounted = false;
    };
  }, [
    attachment?.attachmentId,
    attachment?.kind,
    attachment?.originalCacheKey,
    attachment?.originalLocalUri,
    attachment?.url,
    authId,
  ]);

  const downloadOriginal = async () => {
    if (!attachment || attachment.kind !== 'video') {
      return null;
    }
    if (downloadState.status === 'downloading') {
      return downloadState.localUri;
    }
    if (downloadState.status === 'downloaded' && downloadState.localUri) {
      return downloadState.localUri;
    }

    try {
      setDownloadState({
        localUri: null,
        progress: {
          bytesExpected: attachment.originalByteSize ?? attachment.byteSize ?? null,
          bytesWritten: 0,
          progress: null,
        },
        status: 'downloading',
      });
      const localUri = await downloadAttachmentOriginalFile(authId, attachment, (progress) => {
        setDownloadState((current) => ({
          localUri: current.localUri,
          progress,
          status: 'downloading',
        }));
      });

      setDownloadState({ localUri, progress: null, status: 'downloaded' });
      if (attachment.conversationId) {
        void queryClient.invalidateQueries({
          queryKey: ['chat', authId, 'media-cache', attachment.conversationId],
        });
      }
      void queryClient.invalidateQueries({
        queryKey: ['media-cache-usage', authId],
      });

      return localUri;
    } catch {
      setDownloadState({ localUri: null, progress: null, status: 'idle' });
      Alert.alert(
        'Could not download video',
        'The video could not be downloaded. Try again later.',
      );
      return null;
    }
  };

  return { ...downloadState, downloadOriginal };
}

function MediaAlbumTile({
  attachment,
  authId,
  frame,
  messageId,
  onPress,
  overflowCount,
}: {
  attachment: MessageAttachment;
  authId: string;
  frame: MediaTileFrame;
  messageId: string;
  onPress: () => void;
  overflowCount: number;
}) {
  const videoDownload = useVideoOriginalDownload(
    authId,
    attachment.kind === 'video' ? attachment : null,
  );
  const sourceUrl = getMediaTileImageUrl(attachment);
  const knownPreviewUri =
    attachment.kind === 'video' ? attachment.posterLocalUri : attachment.previewLocalUri;
  const [validKnownPreviewUri, setValidKnownPreviewUri] = useState<string | null>(null);
  useEffect(() => {
    let isMounted = true;
    if (!knownPreviewUri) {
      setValidKnownPreviewUri(null);
      return;
    }
    void localFileExists(knownPreviewUri).then((exists) => {
      if (isMounted) {
        setValidKnownPreviewUri(exists ? knownPreviewUri : null);
      }
    });

    return () => {
      isMounted = false;
    };
  }, [knownPreviewUri]);
  const cacheRecord = mediaDisplayCacheRecord(authId, attachment);
  const cachedUri = useCachedRemoteUri(
    sourceUrl,
    sourceUrl ? mediaDisplayCacheKey(messageId, attachment) : undefined,
    sourceUrl ? cacheRecord : undefined,
    validKnownPreviewUri,
  );
  const isVideo = attachment.kind === 'video';
  const hasPreview = Boolean(cachedUri && sourceUrl);
  const needsSignedPreview = Boolean(
    cacheRecord &&
      !sourceUrl &&
      !validKnownPreviewUri &&
      !hasProcessingStatus(attachment.processingStatus),
  );
  const isProcessing = hasProcessingStatus(attachment.processingStatus) && !hasPreview;

  return (
    <Pressable
      className="overflow-hidden bg-background/55"
      onPress={onPress}
      style={{
        height: frame.height,
        left: frame.left,
        position: 'absolute',
        top: frame.top,
        width: frame.width,
      }}
    >
      {hasPreview ? (
        <ExpoImage
          cachePolicy="memory-disk"
          contentFit="cover"
          enforceEarlyResizing
          placeholder={dominantMediaPlaceholder(attachment)}
          placeholderContentFit="cover"
          priority={validKnownPreviewUri ? 'high' : 'normal'}
          recyclingKey={validKnownPreviewUri ?? cachedUri ?? sourceUrl}
          source={{ uri: cachedUri ?? sourceUrl }}
          style={{ height: frame.height, width: frame.width }}
          transition={validKnownPreviewUri ? 0 : 120}
        />
      ) : (
        <View className="h-full w-full items-center justify-center bg-muted">
          <Ionicons color="#94a3b8" name={isVideo ? 'videocam' : 'image'} size={26} />
          <Text className="mt-2 text-xs font-bold text-muted-foreground">
            {isProcessing
              ? 'Processing'
              : needsSignedPreview
                ? 'Loading'
                : isVideo
                  ? 'Video'
                  : 'Photo'}
          </Text>
        </View>
      )}
      {isVideo ? (
        <View className="absolute inset-0 items-center justify-center bg-black/12">
          <View className="h-12 w-12 items-center justify-center rounded-full bg-black/55">
            <Ionicons color="#fff" name="play" size={22} />
          </View>
          {attachment.durationMs ? (
            <View className="absolute bottom-2 left-2 rounded-full bg-black/55 px-2 py-1">
              <Text className="text-[11px] font-bold text-white/90">
                {formatDuration(attachment.durationMs)}
              </Text>
            </View>
          ) : null}
          <VideoDownloadBadge
            byteSize={attachment.originalByteSize ?? attachment.byteSize}
            onPress={videoDownload.downloadOriginal}
            progress={videoDownload.progress}
            status={videoDownload.status}
          />
        </View>
      ) : null}
      {overflowCount > 0 ? (
        <View className="absolute inset-0 items-center justify-center bg-black/55">
          <Text className="text-3xl font-black text-white">+{overflowCount}</Text>
        </View>
      ) : null}
    </Pressable>
  );
}

function VideoDownloadBadge({
  byteSize,
  onPress,
  progress,
  status,
}: {
  byteSize?: number | null;
  onPress: () => Promise<string | null>;
  progress: MediaCacheDownloadProgress | null;
  status: VideoDownloadState['status'];
}) {
  const isBusy = status === 'checking' || status === 'downloading';
  const isDownloaded = status === 'downloaded';
  const label = videoDownloadLabel(status, byteSize, progress);

  return (
    <Pressable
      className="absolute right-2 top-2 flex-row items-center rounded-full bg-black/65 px-2.5 py-1.5 active:bg-black/80"
      hitSlop={8}
      onPress={(event) => {
        event.stopPropagation();
        if (isBusy || isDownloaded) {
          return;
        }
        void onPress();
      }}
    >
      <View className="h-5 w-5 items-center justify-center">
        {status === 'downloading' ? (
          <ActivityIndicator colorClassName="accent-white" size="small" />
        ) : (
          <Ionicons
            color="#fff"
            name={
              isDownloaded
                ? 'checkmark'
                : status === 'checking'
                  ? 'ellipsis-horizontal'
                  : 'cloud-download-outline'
            }
            size={15}
          />
        )}
      </View>
      {label ? <Text className="ml-1.5 text-[11px] font-black text-white">{label}</Text> : null}
    </Pressable>
  );
}

function videoDownloadLabel(
  status: VideoDownloadState['status'],
  byteSize?: number | null,
  progress?: MediaCacheDownloadProgress | null,
): string {
  if (status === 'downloaded') {
    return 'Saved';
  }
  if (status === 'checking') {
    return 'Checking';
  }
  if (status === 'downloading') {
    if (progress?.progress !== null && progress?.progress !== undefined) {
      return `${Math.min(100, Math.max(0, Math.round(progress.progress * 100)))}%`;
    }
    if (progress?.bytesWritten) {
      return formatFileSize(progress.bytesWritten);
    }
    return 'Downloading';
  }

  return formatFileSize(byteSize) || 'Download';
}

function MediaGalleryModal({
  attachments,
  authId,
  initialIndex,
  onClose,
  visible,
}: {
  attachments: MessageAttachment[];
  authId: string;
  initialIndex: number;
  onClose: () => void;
  visible: boolean;
}) {
  const { height: windowHeight, width: windowWidth } = useWindowDimensions();
  const [currentIndex, setCurrentIndex] = useState(initialIndex);
  const [resolvedUrl, setResolvedUrl] = useState<string | null>(null);
  const selected = attachments[currentIndex] ?? attachments[0] ?? null;
  const videoDownload = useVideoOriginalDownload(
    authId,
    selected?.kind === 'video' ? selected : null,
  );

  useEffect(() => {
    if (visible) {
      setCurrentIndex(initialIndex);
    }
  }, [initialIndex, visible]);

  useEffect(() => {
    if (!visible || !selected) {
      setResolvedUrl(null);
      return;
    }

    let isMounted = true;
    void initialGalleryMediaUrl(selected).then((url) => {
      if (isMounted) {
        setResolvedUrl(url);
      }
    });
    resolveAttachmentOriginalUrl(authId, selected, {
      cache: selected.kind !== 'video',
    })
      .then((url) => {
        if (isMounted) {
          setResolvedUrl(url);
        }
      })
      .catch(() => {
        if (isMounted) {
          setResolvedUrl(fallbackGalleryMediaUrl(selected));
        }
      });

    return () => {
      isMounted = false;
    };
  }, [authId, selected, visible]);

  if (!visible || !selected) {
    return null;
  }

  const canGoBack = attachments.length > 1 && currentIndex > 0;
  const canGoForward = attachments.length > 1 && currentIndex < attachments.length - 1;
  const videoPosterUrl = selected.kind === 'video' ? galleryVideoPosterUrl(selected) : null;
  const handleDownloadVideo = async () => {
    const localUri = await videoDownload.downloadOriginal();
    if (localUri) {
      setResolvedUrl(localUri);
    }

    return localUri;
  };

  return (
    <Modal animationType="fade" onRequestClose={onClose} transparent visible={visible}>
      <View className="flex-1 bg-black">
        <View className="absolute left-5 right-5 top-14 z-10 flex-row items-center justify-between">
          <View className="rounded-full bg-white/10 px-3 py-2">
            <Text className="text-sm font-bold text-white">
              {currentIndex + 1} / {attachments.length}
            </Text>
          </View>
          <Pressable
            className="h-11 w-11 items-center justify-center rounded-full bg-white/10"
            onPress={onClose}
          >
            <Ionicons color="#fff" name="close" size={24} />
          </Pressable>
        </View>
        <View className="flex-1 items-center justify-center">
          {selected.kind === 'video' ? (
            resolvedUrl ? (
              <GalleryVideo
                attachment={selected}
                key={`${selected.attachmentId ?? selected.name}:${resolvedUrl}`}
                uri={resolvedUrl}
              />
            ) : (
              <GalleryVideoLoading attachment={selected} posterUrl={videoPosterUrl} />
            )
          ) : resolvedUrl ? (
            <ExpoImage
              cachePolicy="memory-disk"
              contentFit="contain"
              placeholder={dominantMediaPlaceholder(selected)}
              placeholderContentFit="contain"
              priority="high"
              recyclingKey={resolvedUrl}
              source={{ uri: resolvedUrl }}
              style={{ height: windowHeight, width: windowWidth }}
              transition={80}
            />
          ) : (
            <ActivityIndicator colorClassName="accent-white" size="large" />
          )}
        </View>
        {canGoBack ? (
          <Pressable
            className="absolute left-4 top-1/2 h-12 w-12 items-center justify-center rounded-full bg-white/10"
            onPress={() => setCurrentIndex((index) => Math.max(0, index - 1))}
          >
            <Ionicons color="#fff" name="chevron-back" size={26} />
          </Pressable>
        ) : null}
        {canGoForward ? (
          <Pressable
            className="absolute right-4 top-1/2 h-12 w-12 items-center justify-center rounded-full bg-white/10"
            onPress={() => setCurrentIndex((index) => Math.min(attachments.length - 1, index + 1))}
          >
            <Ionicons color="#fff" name="chevron-forward" size={26} />
          </Pressable>
        ) : null}
        <View className="absolute bottom-10 left-5 right-5 items-center">
          {selected.kind === 'video' ? (
            <GalleryVideoDownloadButton
              byteSize={selected.originalByteSize ?? selected.byteSize}
              onPress={handleDownloadVideo}
              progress={videoDownload.progress}
              status={videoDownload.status}
            />
          ) : null}
          <Text className="text-center text-sm font-semibold text-white/80" numberOfLines={2}>
            {selected.kind === 'video' && selected.durationMs
              ? `${selected.name} · ${formatDuration(selected.durationMs)}`
              : selected.name}
          </Text>
        </View>
      </View>
    </Modal>
  );
}

function GalleryVideo({ attachment, uri }: { attachment: MessageAttachment; uri: string }) {
  const source = useMemo<VideoSource>(
    () => ({
      contentType: 'progressive',
      metadata: {
        title: attachment.name,
      },
      uri,
      useCaching: false,
    }),
    [attachment.name, uri],
  );
  const player = useVideoPlayer(source, (createdPlayer) => {
    createdPlayer.loop = false;
    createdPlayer.muted = false;
    createdPlayer.staysActiveInBackground = false;
  });

  useEffect(() => {
    player.play();
  }, [player]);

  return (
    <VideoView
      allowsPictureInPicture={false}
      contentFit="contain"
      fullscreenOptions={{ enable: true }}
      nativeControls
      player={player}
      style={{ height: '100%', width: '100%' }}
    />
  );
}

function GalleryVideoDownloadButton({
  byteSize,
  onPress,
  progress,
  status,
}: {
  byteSize?: number | null;
  onPress: () => Promise<string | null>;
  progress: MediaCacheDownloadProgress | null;
  status: VideoDownloadState['status'];
}) {
  const isBusy = status === 'checking' || status === 'downloading';
  const isDownloaded = status === 'downloaded';
  const detailLabel = videoDownloadLabel(status, byteSize, progress);
  const label = isDownloaded
    ? 'Saved offline'
    : status === 'downloading'
      ? `Downloading${detailLabel ? ` · ${detailLabel}` : ''}`
      : status === 'checking'
        ? 'Checking download'
        : `Download video${detailLabel ? ` · ${detailLabel}` : ''}`;

  return (
    <Pressable
      className="mb-3 flex-row items-center rounded-full bg-white/15 px-4 py-2.5 active:bg-white/20 disabled:opacity-80"
      disabled={isBusy || isDownloaded}
      onPress={() => {
        void onPress();
      }}
    >
      <View className="h-5 w-5 items-center justify-center">
        {status === 'downloading' ? (
          <ActivityIndicator colorClassName="accent-white" size="small" />
        ) : (
          <Ionicons
            color="#fff"
            name={isDownloaded ? 'checkmark' : 'cloud-download-outline'}
            size={17}
          />
        )}
      </View>
      <Text className="ml-2 text-sm font-black text-white">{label}</Text>
    </Pressable>
  );
}

function GalleryVideoLoading({
  attachment,
  posterUrl,
}: {
  attachment: MessageAttachment;
  posterUrl: string | null;
}) {
  return (
    <View className="h-full w-full items-center justify-center bg-black">
      {posterUrl ? (
        <ExpoImage
          cachePolicy="memory-disk"
          contentFit="contain"
          placeholder={dominantMediaPlaceholder(attachment)}
          placeholderContentFit="contain"
          recyclingKey={posterUrl}
          source={{ uri: posterUrl }}
          style={StyleSheet.absoluteFillObject}
        />
      ) : null}
      <View className="absolute inset-0 items-center justify-center bg-black/35">
        <ActivityIndicator colorClassName="accent-white" size="large" />
      </View>
    </View>
  );
}

async function initialGalleryMediaUrl(attachment: MessageAttachment): Promise<string | null> {
  if (attachment.kind === 'video') {
    return attachment.originalLocalUri && (await localFileExists(attachment.originalLocalUri))
      ? attachment.originalLocalUri
      : null;
  }

  for (const uri of [
    attachment.originalLocalUri,
    attachment.previewLocalUri,
    attachment.previewUrl,
  ]) {
    if (!uri) {
      continue;
    }
    if (await localFileExists(uri)) {
      return uri;
    }
  }

  return null;
}

function fallbackGalleryMediaUrl(attachment: MessageAttachment): string | null {
  if (attachment.kind === 'video') {
    return attachment.originalLocalUri ?? null;
  }

  return attachment.url || attachment.previewUrl || attachment.thumbUrl || null;
}

function galleryVideoPosterUrl(attachment: MessageAttachment): string | null {
  return (
    attachment.posterLocalUri ??
    attachment.posterUrl ??
    attachment.thumbnailUrl ??
    attachment.thumbUrl ??
    null
  );
}

function hasProcessingStatus(status: MessageAttachment['processingStatus']): boolean {
  return status === 'pending' || status === 'processing';
}

function FileMessageBubble({
  authId,
  deliveryLabel,
  fileAttachment,
  isFailed,
  isMine,
  message,
  onLongPressMessage,
  onRetryFailedMessage,
}: {
  authId: string;
  deliveryLabel?: string;
  fileAttachment: MessageAttachment;
  isFailed: boolean;
  isMine: boolean;
  message: ChatMessage;
  onLongPressMessage: (message: ChatMessage) => void;
  onRetryFailedMessage: (messageId: string) => void;
}) {
  const fileName = formatAttachmentName(fileAttachment.name) || 'File';
  const localFileUri = getLocalMessageFileUri(message.id, fileName);
  const sourceLocalUri =
    fileAttachment.originalLocalUri ??
    (isLocalFileUri(fileAttachment.url) ? fileAttachment.url : localFileUri);
  const [isFilePreviewVisible, setIsFilePreviewVisible] = useState(false);
  const [fileDownloadState, setFileDownloadState] = useState<FileDownloadState>(
    fileAttachment.originalLocalUri || isLocalFileUri(fileAttachment.url) ? 'downloaded' : 'idle',
  );

  useEffect(() => {
    if (!sourceLocalUri) {
      setFileDownloadState('idle');
      return;
    }

    let isMounted = true;
    setFileDownloadState('checking');

    FileSystem.getInfoAsync(sourceLocalUri)
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
  }, [sourceLocalUri]);

  const handleOpenFile = async () => {
    if (!localFileUri && !sourceLocalUri) {
      Alert.alert('Could not download file', 'Local file storage is not available on this device.');
      return;
    }

    const cacheDirectory = getMessageFileCacheDirectory();
    if (!cacheDirectory && !isLocalFileUri(fileAttachment.url)) {
      Alert.alert('Could not download file', 'Local file storage is not available on this device.');
      return;
    }

    try {
      setFileDownloadState('downloading');

      let uriToOpen = sourceLocalUri ?? localFileUri ?? '';
      const info = uriToOpen ? await FileSystem.getInfoAsync(uriToOpen) : null;

      if (!info?.exists) {
        const fileUrl = await resolveAttachmentOriginalUrl(authId, fileAttachment);
        if (!fileUrl || !localFileUri || !cacheDirectory) {
          throw new Error('File URL is not available.');
        }
        if (isLocalFileUri(fileUrl)) {
          uriToOpen = fileUrl;
        } else {
          await FileSystem.makeDirectoryAsync(cacheDirectory, {
            intermediates: true,
          });
          const download = await FileSystem.downloadAsync(fileUrl, localFileUri);
          uriToOpen = download.uri;
        }
        const downloadedInfo = await FileSystem.getInfoAsync(uriToOpen);
        await persistDownloadedAttachment(
          authId,
          fileAttachment,
          uriToOpen,
          fileCacheKey(message.id, fileAttachment),
          downloadedInfo.exists && !downloadedInfo.isDirectory ? downloadedInfo.size : undefined,
        );
      }

      setFileDownloadState('downloaded');

      await openDocumentWithNativePreview(uriToOpen, fileName, fileAttachment.mimeType);
      setIsFilePreviewVisible(false);
    } catch {
      setFileDownloadState('idle');
      Alert.alert('Could not open file', 'The file could not be downloaded. Try again later.');
    }
  };

  const isFileActionBusy = fileDownloadState === 'checking' || fileDownloadState === 'downloading';
  const fileActionLabel =
    fileDownloadState === 'downloading'
      ? 'Downloading...'
      : fileDownloadState === 'downloaded'
        ? 'Open file'
        : 'Download file';
  const fileStatusLabel = fileDownloadState === 'downloaded' ? 'downloaded' : 'tap to download';
  const fileMetaLabel = [formatFileSize(fileAttachment.byteSize), fileStatusLabel, message.time]
    .filter(Boolean)
    .join(' · ');
  const caption = message.text.trim();

  return (
    <View>
      <View className={`mb-2 flex-row items-end gap-2 ${isMine ? 'self-end' : 'self-start'}`}>
        <FailedRetryButton
          failedMessageId={message.failedMessageId}
          isFailed={isFailed}
          onRetryFailedMessage={onRetryFailedMessage}
        />
        <View
          className={`max-w-[82%] overflow-hidden rounded-[24px] ${isMine ? 'bg-foreground' : 'bg-muted'}`}
          style={styles.bubble}
        >
          <Pressable
            className="flex-row items-center gap-3 px-3 py-2.5"
            onLongPress={() => onLongPressMessage(message)}
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
                {fileMetaLabel}
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
          {caption ? (
            <Text
              className={`px-4 pb-3 text-[15px] leading-5 ${isMine ? 'text-background' : 'text-foreground'}`}
            >
              {caption}
            </Text>
          ) : null}
        </View>
      </View>
      <BubbleDeliveryLabel deliveryLabel={deliveryLabel} message={message} />
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
                {formatFileSize(fileAttachment.byteSize) || 'Document'}
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
    </View>
  );
}

function FailedRetryButton({
  failedMessageId,
  isFailed,
  onRetryFailedMessage,
}: {
  failedMessageId?: string;
  isFailed: boolean;
  onRetryFailedMessage: (messageId: string) => void;
}) {
  if (!isFailed || !failedMessageId) {
    return null;
  }

  return (
    <Pressable
      className="mb-1 h-7 w-7 items-center justify-center rounded-full bg-red-500"
      onPress={() => onRetryFailedMessage(failedMessageId)}
    >
      <Ionicons color="#fff" name="alert" size={16} />
    </Pressable>
  );
}

function BubbleDeliveryLabel({
  deliveryLabel,
  message,
}: {
  deliveryLabel?: string;
  message: ChatMessage;
}) {
  if (!message.readLabel && !deliveryLabel) {
    return null;
  }

  return (
    <Text className="mt-1 self-end text-[11px] font-semibold text-muted-foreground">
      {deliveryLabel ?? message.readLabel}
    </Text>
  );
}

function MessageActionSheet({
  message,
  onClose,
  onDelete,
}: {
  message: MessageActionTarget | null;
  onClose: () => void;
  onDelete: (message: MessageActionTarget) => void;
}) {
  if (!message) {
    return null;
  }

  const canDelete = !message.localOnly || message.deliveryStatus === 'failed';

  return (
    <Modal animationType="fade" onRequestClose={onClose} transparent visible>
      <View className="flex-1 justify-end bg-black/55">
        <Pressable className="flex-1" onPress={onClose} />
        <View className="rounded-t-[30px] bg-background px-5 pb-8 pt-4">
          <View className="mx-auto mb-5 h-1.5 w-12 rounded-full bg-muted" />
          <Text className="mb-3 text-center text-sm font-semibold text-muted-foreground">
            Message actions
          </Text>
          {canDelete ? (
            <Pressable
              className="h-[52px] flex-row items-center justify-center rounded-full bg-red-500"
              onPress={() => onDelete(message)}
            >
              <Ionicons color="#fff" name="trash" size={18} />
              <Text className="ml-2 text-base font-black text-white">
                {message.localOnly ? 'Delete' : 'Delete for everyone'}
              </Text>
            </Pressable>
          ) : null}
          <Pressable
            className="mt-3 h-[52px] items-center justify-center rounded-full bg-muted"
            onPress={onClose}
          >
            <Text className="text-base font-bold text-foreground">Cancel</Text>
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}

function getDeliveryLabel(status: ChatMessage['deliveryStatus']): string | undefined {
  switch (status) {
    case 'pending':
      return 'Pending';
    case 'sending':
      return 'Sending...';
    case 'retrying':
      return 'Retrying...';
    case 'failed':
      return 'Not sent';
    default:
      return undefined;
  }
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

  return (
    <ConversationAvatar
      conversation={conversation.conversation}
      name={conversation.name}
      privateProfile={{
        avatarUrl: conversation.avatarUrl,
        isOnline: conversation.isOnline,
        name: conversation.name,
        userId: conversation.avatarUserId,
        username: conversation.avatarUsername,
      }}
      size={avatarSize}
      variant={isLarge ? 'large' : 'thumb'}
    />
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

function OlderMessagesSpinner() {
  return (
    <View className="items-center py-3">
      <ActivityIndicator colorClassName="accent-foreground" size="small" />
    </View>
  );
}

function DateSeparator({
  id,
  isSticky = false,
  label,
  onPress,
}: {
  id: string;
  isSticky?: boolean;
  label: string;
  onPress: (id: string) => void;
}) {
  return (
    <View className="items-center py-2" pointerEvents="box-none">
      <Pressable
        className={`rounded-full border border-border/60 bg-muted/95 px-3 py-1.5 ${isSticky ? 'shadow-lg' : ''}`}
        onPress={() => onPress(id)}
      >
        <Text className="text-xs font-bold text-muted-foreground">{label}</Text>
      </Pressable>
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
