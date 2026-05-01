import Ionicons from '@expo/vector-icons/Ionicons';
import {
  createGroupConversation,
  type FriendshipRecord,
  getProfileAvatarUrl,
  type ProfileRecord,
} from '@infchat/pocketbase';
import { useNetInfo } from '@react-native-community/netinfo';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { router } from 'expo-router';
import { useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import {
  Alert,
  Keyboard,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { ProfileAvatar } from '../../components/ProfileAvatar';
import { useAuth } from '../../lib/auth-context';
import { useChatSyncService } from '../../lib/chat-sync-context';
import {
  listCachedFriendships,
  listCachedProfilesByUserIds,
  refreshCachedFriendships,
  refreshCachedProfilesByUserIds,
} from '../../lib/local-cache';
import { pb } from '../../lib/pocketbase';

type GroupStep = 'members' | 'details';

type FriendPerson = {
  avatarUrl?: string | null;
  id: string;
  name: string;
  userId: string;
  username: string;
};

const HEADER_HEIGHT = 64;
const MAX_INVITED_MEMBERS = 49;

export default function NewGroupScreen() {
  const { authRecord } = useAuth();
  const chatSyncService = useChatSyncService();
  const queryClient = useQueryClient();
  const netInfo = useNetInfo();
  const insets = useSafeAreaInsets();
  const searchRef = useRef<TextInput>(null);
  const titleRef = useRef<TextInput>(null);
  const [step, setStep] = useState<GroupStep>('members');
  const [query, setQuery] = useState('');
  const [selectedUserIds, setSelectedUserIds] = useState<string[]>([]);
  const [title, setTitle] = useState('');
  const currentUserId = authRecord.id;
  const isOnline = Boolean(netInfo.isConnected && netInfo.isInternetReachable !== false);

  const friendshipsQuery = useQuery({
    queryKey: ['friendships', currentUserId, 'new-group'],
    queryFn: () => listCachedFriendships(pb),
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
    queryKey: ['profiles', 'new-group-friends', friendUserIds],
    queryFn: () => listCachedProfilesByUserIds(pb, friendUserIds),
    enabled: friendUserIds.length > 0,
    networkMode: 'always',
  });
  const friends = useMemo(
    () => toFriendPeople(profilesQuery.data ?? [], fileTokenQuery.data),
    [fileTokenQuery.data, profilesQuery.data],
  );
  const friendsByUserId = useMemo(() => {
    const byUserId = new Map<string, FriendPerson>();
    for (const friend of friends) {
      byUserId.set(friend.userId, friend);
    }

    return byUserId;
  }, [friends]);
  const selectedFriends = useMemo(
    () => selectedUserIds.flatMap((userId) => friendsByUserId.get(userId) ?? []),
    [friendsByUserId, selectedUserIds],
  );
  const visibleFriends = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    if (!normalizedQuery) {
      return friends;
    }

    return friends.filter(
      (friend) =>
        friend.name.toLowerCase().includes(normalizedQuery) ||
        friend.username.toLowerCase().includes(normalizedQuery),
    );
  }, [friends, query]);
  const trimmedTitle = title.trim();
  const canCreate = trimmedTitle.length > 0 && selectedUserIds.length > 0 && isOnline;

  const createGroupMutation = useMutation({
    mutationFn: () =>
      createGroupConversation(pb, {
        defaultHistoryPolicy: 'full',
        memberUserIds: selectedUserIds,
        title: trimmedTitle,
      }),
    onSuccess: async (response) => {
      await chatSyncService.applyConversationStart(response);
      await chatSyncService.syncNow('manual');
      await queryClient.invalidateQueries({
        queryKey: ['chat', currentUserId],
      });
      router.replace({
        pathname: '/chat/[id]',
        params: { id: response.conversation.id },
      });
    },
    onError: (error) => {
      Alert.alert(
        'Could not create group',
        getErrorMessage(error, 'Check your connection and try again.'),
      );
    },
  });

  useEffect(() => {
    if (!isOnline) {
      return;
    }

    let isMounted = true;
    void refreshCachedFriendships(pb)
      .then((friendships) => {
        if (isMounted) {
          queryClient.setQueryData(['friendships', currentUserId, 'new-group'], friendships);
        }
      })
      .catch(() => {
        // Cached friends remain selectable while offline.
      });

    return () => {
      isMounted = false;
    };
  }, [currentUserId, isOnline, queryClient]);

  useEffect(() => {
    if (!isOnline || friendUserIds.length === 0) {
      return;
    }

    let isMounted = true;
    void refreshCachedProfilesByUserIds(pb, friendUserIds)
      .then((profiles) => {
        if (isMounted) {
          queryClient.setQueryData(['profiles', 'new-group-friends', friendUserIds], profiles);
        }
      })
      .catch(() => {
        // Profile cache remains good enough for group selection.
      });

    return () => {
      isMounted = false;
    };
  }, [friendUserIds, isOnline, queryClient]);

  const toggleSelected = (userId: string) => {
    setSelectedUserIds((current) => {
      if (current.includes(userId)) {
        return current.filter((id) => id !== userId);
      }

      if (current.length >= MAX_INVITED_MEMBERS) {
        Alert.alert('Group is full', 'You can invite up to 49 friends.');
        return current;
      }

      return [...current, userId];
    });
  };

  const handleBack = () => {
    if (createGroupMutation.isPending) {
      return;
    }

    if (step === 'details') {
      setStep('members');
      return;
    }

    router.back();
  };

  const handleNext = () => {
    if (selectedUserIds.length === 0) {
      return;
    }

    Keyboard.dismiss();
    setStep('details');
  };

  const handleCreate = () => {
    if (!canCreate || createGroupMutation.isPending) {
      return;
    }

    createGroupMutation.mutate();
  };

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      className="flex-1 bg-background"
    >
      <View
        className="border-b border-border/60 bg-background/95 px-5"
        style={{ height: insets.top + HEADER_HEIGHT, paddingTop: insets.top }}
      >
        <View className="flex-1 flex-row items-center justify-center">
          <Pressable
            className="absolute left-0 h-12 w-12 items-center justify-center rounded-full bg-muted"
            disabled={createGroupMutation.isPending}
            onPress={handleBack}
          >
            <Ionicons color="#f8fafc" name="chevron-back" size={28} />
          </Pressable>

          <View className="items-center">
            <Text className="text-2xl font-black text-foreground">New Group</Text>
            {step === 'members' ? (
              <Text className="mt-0.5 text-sm font-bold text-muted-foreground">
                {selectedUserIds.length}/{MAX_INVITED_MEMBERS}
              </Text>
            ) : null}
          </View>

          {step === 'members' ? (
            <Pressable
              className={`absolute right-0 h-12 items-center justify-center rounded-full px-5 ${
                selectedUserIds.length > 0 ? 'bg-muted' : 'bg-muted/45'
              }`}
              disabled={selectedUserIds.length === 0}
              onPress={handleNext}
            >
              <Text
                className={`text-lg font-black ${
                  selectedUserIds.length > 0 ? 'text-foreground' : 'text-muted-foreground'
                }`}
              >
                Next
              </Text>
            </Pressable>
          ) : (
            <Pressable
              className={`absolute right-0 h-12 items-center justify-center rounded-full px-5 ${
                canCreate ? 'bg-foreground' : 'bg-muted/45'
              }`}
              disabled={!canCreate || createGroupMutation.isPending}
              onPress={handleCreate}
            >
              <Text
                className={`text-lg font-black ${canCreate ? 'text-background' : 'text-muted-foreground'}`}
              >
                {createGroupMutation.isPending ? 'Creating' : 'Create'}
              </Text>
            </Pressable>
          )}
        </View>
      </View>

      {step === 'members' ? (
        <MembersStep
          friends={visibleFriends}
          isLoading={friendshipsQuery.isLoading && friends.length === 0}
          onClearQuery={() => setQuery('')}
          onToggleSelected={toggleSelected}
          query={query}
          searchRef={searchRef}
          selectedUserIds={selectedUserIds}
          setQuery={setQuery}
        />
      ) : (
        <DetailsStep
          onRemoveMember={toggleSelected}
          selectedFriends={selectedFriends}
          setTitle={setTitle}
          title={title}
          titleRef={titleRef}
        />
      )}
    </KeyboardAvoidingView>
  );
}

function MembersStep({
  friends,
  isLoading,
  onClearQuery,
  onToggleSelected,
  query,
  searchRef,
  selectedUserIds,
  setQuery,
}: {
  friends: FriendPerson[];
  isLoading: boolean;
  onClearQuery: () => void;
  onToggleSelected: (userId: string) => void;
  query: string;
  searchRef: RefObject<TextInput | null>;
  selectedUserIds: string[];
  setQuery: (query: string) => void;
}) {
  const insets = useSafeAreaInsets();
  const selected = new Set(selectedUserIds);

  return (
    <ScrollView
      className="flex-1"
      contentContainerStyle={{
        paddingBottom: Math.max(insets.bottom, 16) + 24,
        paddingHorizontal: 20,
        paddingTop: 16,
      }}
      keyboardDismissMode="on-drag"
      keyboardShouldPersistTaps="handled"
      onScrollBeginDrag={Keyboard.dismiss}
      showsVerticalScrollIndicator={false}
    >
      <View className="mb-4 h-12 flex-row items-center rounded-full bg-muted px-4">
        <Ionicons color="#64748b" name="search" size={20} />
        <TextInput
          autoCapitalize="none"
          autoCorrect={false}
          className="h-full min-w-0 flex-1 px-3 text-[17px] text-foreground"
          onChangeText={setQuery}
          placeholder="Who would you like to add?"
          placeholderTextColor="#64748b"
          ref={searchRef}
          returnKeyType="search"
          selectionColor="#f8fafc"
          value={query}
        />
        {query ? (
          <Pressable
            className="h-7 w-7 items-center justify-center rounded-full bg-background/60"
            onPress={onClearQuery}
          >
            <Ionicons color="#94a3b8" name="close" size={16} />
          </Pressable>
        ) : null}
      </View>

      {isLoading ? (
        <EmptyState icon="people" title="Loading friends" />
      ) : friends.length ? (
        friends.map((friend) => (
          <SelectableFriendRow
            friend={friend}
            isSelected={selected.has(friend.userId)}
            key={friend.userId}
            onPress={() => onToggleSelected(friend.userId)}
          />
        ))
      ) : (
        <EmptyState icon="search" title={query ? 'No matching friends' : 'No friends yet'} />
      )}
    </ScrollView>
  );
}

function DetailsStep({
  onRemoveMember,
  selectedFriends,
  setTitle,
  title,
  titleRef,
}: {
  onRemoveMember: (userId: string) => void;
  selectedFriends: FriendPerson[];
  setTitle: (title: string) => void;
  title: string;
  titleRef: RefObject<TextInput | null>;
}) {
  const insets = useSafeAreaInsets();

  return (
    <ScrollView
      className="flex-1"
      contentContainerStyle={{
        paddingBottom: Math.max(insets.bottom, 16) + 28,
        paddingHorizontal: 20,
        paddingTop: 22,
      }}
      keyboardDismissMode="on-drag"
      keyboardShouldPersistTaps="handled"
      onScrollBeginDrag={Keyboard.dismiss}
      showsVerticalScrollIndicator={false}
    >
      <View className="rounded-[30px] bg-muted p-4">
        <View className="flex-row items-center gap-4">
          <GroupAvatar size={82} />
          <View className="min-w-0 flex-1">
            <TextInput
              autoCapitalize="sentences"
              className="h-12 text-2xl font-black text-foreground"
              maxLength={80}
              onChangeText={setTitle}
              placeholder="Group name"
              placeholderTextColor="#64748b"
              ref={titleRef}
              returnKeyType="done"
              selectionColor="#f8fafc"
              value={title}
            />
            <Text className="mt-1 text-sm font-semibold text-muted-foreground">
              You + {selectedFriends.length} {selectedFriends.length === 1 ? 'friend' : 'friends'}
            </Text>
          </View>
          {title ? (
            <Pressable
              className="h-8 w-8 items-center justify-center rounded-full bg-background/60"
              onPress={() => setTitle('')}
            >
              <Ionicons color="#94a3b8" name="close" size={16} />
            </Pressable>
          ) : null}
        </View>
      </View>

      <Text className="mb-2 mt-7 text-xs font-bold uppercase tracking-[1px] text-muted-foreground">
        Members
      </Text>
      <View className="overflow-hidden rounded-[26px] bg-muted px-4">
        {selectedFriends.map((friend, index) => (
          <SelectedMemberRow
            friend={friend}
            isLast={index === selectedFriends.length - 1}
            key={friend.userId}
            onRemove={() => onRemoveMember(friend.userId)}
          />
        ))}
      </View>
    </ScrollView>
  );
}

function SelectableFriendRow({
  friend,
  isSelected,
  onPress,
}: {
  friend: FriendPerson;
  isSelected: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable className="min-h-[70px] flex-row items-center gap-3" onPress={onPress}>
      <View
        className={`h-8 w-8 items-center justify-center rounded-full border ${
          isSelected ? 'border-primary bg-primary' : 'border-border bg-background'
        }`}
      >
        {isSelected ? <Ionicons color="#080b12" name="checkmark" size={20} /> : null}
      </View>
      <ProfileAvatar
        avatarUrl={friend.avatarUrl}
        name={friend.name}
        size={52}
        userId={friend.userId}
        username={friend.username}
      />
      <View className="min-h-[70px] min-w-0 flex-1 justify-center border-b border-border/60">
        <Text className="text-[18px] font-semibold text-foreground" numberOfLines={1}>
          {friend.name}
        </Text>
        <Text className="mt-0.5 text-[14px] font-medium text-muted-foreground" numberOfLines={1}>
          @{friend.username}
        </Text>
      </View>
    </Pressable>
  );
}

function SelectedMemberRow({
  friend,
  isLast,
  onRemove,
}: {
  friend: FriendPerson;
  isLast: boolean;
  onRemove: () => void;
}) {
  return (
    <View
      className={`min-h-[66px] flex-row items-center gap-3 ${isLast ? '' : 'border-b border-border/60'}`}
    >
      <ProfileAvatar
        avatarUrl={friend.avatarUrl}
        name={friend.name}
        size={44}
        userId={friend.userId}
        username={friend.username}
      />
      <View className="min-w-0 flex-1">
        <Text className="text-[17px] font-semibold text-foreground" numberOfLines={1}>
          {friend.name}
        </Text>
        <Text className="mt-0.5 text-sm font-medium text-muted-foreground" numberOfLines={1}>
          @{friend.username}
        </Text>
      </View>
      <Pressable
        className="h-8 w-8 items-center justify-center rounded-full bg-background/60"
        onPress={onRemove}
      >
        <Ionicons color="#94a3b8" name="close" size={16} />
      </Pressable>
    </View>
  );
}

function GroupAvatar({ size }: { size: number }) {
  return (
    <View
      className="items-center justify-center rounded-full bg-primary/15"
      style={{ height: size, width: size }}
    >
      <Ionicons color="#60a5fa" name="camera" size={Math.round(size * 0.38)} />
    </View>
  );
}

function EmptyState({ icon, title }: { icon: keyof typeof Ionicons.glyphMap; title: string }) {
  return (
    <View className="items-center py-20">
      <View className="h-16 w-16 items-center justify-center rounded-full bg-muted">
        <Ionicons color="#64748b" name={icon} size={28} />
      </View>
      <Text className="mt-4 text-lg font-bold text-muted-foreground">{title}</Text>
    </View>
  );
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

function toFriendPeople(profiles: ProfileRecord[], fileToken?: string): FriendPerson[] {
  return profiles
    .map((profile) => {
      const name = profile.display_name || profile.username;

      return {
        avatarUrl: getProfileAvatarUrl(pb, profile, fileToken, 'thumb'),
        id: profile.id,
        name,
        userId: profile.user,
        username: profile.username,
      };
    })
    .sort((left, right) => left.name.localeCompare(right.name));
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
