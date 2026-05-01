import Ionicons from '@expo/vector-icons/Ionicons';
import {
  addGroupMembers,
  type ConversationMembershipRecord,
  type ConversationRecord,
  type ConversationAvatarUploadFile,
  type FriendshipRecord,
  type GroupHistoryPolicy,
  getProfileAvatarUrl,
  leaveGroupConversation,
  type ProfileRecord,
  removeGroupMember,
  updateGroupConversation,
} from '@infchat/pocketbase';
import { useNetInfo } from '@react-native-community/netinfo';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import * as ImagePicker from 'expo-image-picker';
import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import {
  Alert,
  Keyboard,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  Switch,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { ProfileAvatar } from '../../../components/ProfileAvatar';
import { ConversationAvatar } from '../../../components/ConversationAvatar';
import { useAuth } from '../../../lib/auth-context';
import { useChatSyncService } from '../../../lib/chat-sync-context';
import {
  applyLocalChatRecords,
  getLocalConversation,
  listLocalMembershipsForConversation,
} from '../../../lib/chat-sync-store';
import {
  listCachedFriendships,
  listCachedProfilesByUserIds,
  refreshCachedFriendships,
  refreshCachedProfilesByUserIds,
} from '../../../lib/local-cache';
import { pb } from '../../../lib/pocketbase';

type GroupMutationResponse = {
  conversation: ConversationRecord;
  membership?: ConversationMembershipRecord;
  memberships?: ConversationMembershipRecord[];
};

type GroupMutationContext = {
  authId: string;
  chatSyncService: ReturnType<typeof useChatSyncService>;
  conversationId: string;
  queryClient: ReturnType<typeof useQueryClient>;
};

type MemberView = {
  avatarUrl?: string | null;
  id: string;
  isCurrentUser: boolean;
  name: string;
  note: string;
  role: ConversationMembershipRecord['role'];
  userId: string;
  username: string;
};

type AddableFriend = {
  avatarUrl?: string | null;
  id: string;
  name: string;
  userId: string;
  username: string;
};

const HEADER_HEIGHT = 64;
const MAX_GROUP_MEMBERS = 50;

export default function GroupInfoScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const conversationId = id ?? '';
  const { authRecord } = useAuth();
  const chatSyncService = useChatSyncService();
  const queryClient = useQueryClient();
  const netInfo = useNetInfo();
  const insets = useSafeAreaInsets();
  const [isAddMembersVisible, setIsAddMembersVisible] = useState(false);
  const [isEditVisible, setIsEditVisible] = useState(false);
  const isOnline = Boolean(netInfo.isConnected && netInfo.isInternetReachable !== false);

  const conversationQuery = useQuery({
    queryKey: ['chat', authRecord.id, 'conversation', conversationId],
    queryFn: () => getLocalConversation(authRecord.id, conversationId),
    enabled: Boolean(conversationId),
  });
  const membershipsQuery = useQuery({
    queryKey: ['chat', authRecord.id, 'memberships', conversationId],
    queryFn: () => listLocalMembershipsForConversation(authRecord.id, conversationId),
    enabled: Boolean(conversationId),
  });
  const activeMemberships = useMemo(
    () => (membershipsQuery.data ?? []).filter((membership) => membership.status === 'active'),
    [membershipsQuery.data],
  );
  const memberUserIds = useMemo(
    () => activeMemberships.map((membership) => membership.user).sort(),
    [activeMemberships],
  );
  const fileTokenQuery = useQuery({
    queryKey: ['file-token', authRecord.id],
    queryFn: () => pb.files.getToken(),
    staleTime: 1000 * 60 * 5,
  });
  const profilesQuery = useQuery({
    queryKey: ['profiles', 'group-info-members', conversationId, memberUserIds],
    queryFn: () => listCachedProfilesByUserIds(pb, memberUserIds),
    enabled: memberUserIds.length > 0,
    networkMode: 'always',
  });
  const profilesByUserId = useMemo(() => {
    const profiles = new Map<string, ProfileRecord>();
    for (const profile of profilesQuery.data ?? []) {
      profiles.set(profile.user, profile);
    }

    return profiles;
  }, [profilesQuery.data]);
  const members = useMemo(
    () =>
      activeMemberships
        .map((membership) =>
          toMemberView(membership, profilesByUserId, authRecord.id, fileTokenQuery.data),
        )
        .sort((left, right) => {
          if (left.isCurrentUser) {
            return -1;
          }
          if (right.isCurrentUser) {
            return 1;
          }
          if (left.role === 'owner') {
            return -1;
          }
          if (right.role === 'owner') {
            return 1;
          }

          return left.name.localeCompare(right.name);
        }),
    [activeMemberships, authRecord.id, fileTokenQuery.data, profilesByUserId],
  );
  const conversation = conversationQuery.data;
  const title = conversation?.title || 'Group chat';
  const memberCount = conversation?.member_count ?? activeMemberships.length;
  const currentMembership = activeMemberships.find(
    (membership) => membership.user === authRecord.id,
  );
  const canManageGroup = currentMembership ? membershipCanManageGroup(currentMembership) : false;
  const canManageMembers = currentMembership
    ? membershipCanManageMembers(currentMembership)
    : false;
  const mutationContext = {
    authId: authRecord.id,
    chatSyncService,
    conversationId,
    queryClient,
  };

  const addMembersMutation = useMutation({
    mutationFn: (memberUserIds: string[]) => addGroupMembers(pb, conversationId, memberUserIds),
    onSuccess: async (response) => {
      await applyGroupMutationResponse(mutationContext, response);
      setIsAddMembersVisible(false);
    },
    onError: (error) => {
      Alert.alert(
        'Could not add members',
        getErrorMessage(error, 'Check your connection and try again.'),
      );
    },
  });
  const removeMemberMutation = useMutation({
    mutationFn: (userId: string) => removeGroupMember(pb, conversationId, userId),
    onSuccess: async (response) => {
      await applyGroupMutationResponse(mutationContext, response);
    },
    onError: (error) => {
      Alert.alert(
        'Could not remove member',
        getErrorMessage(error, 'Check your connection and try again.'),
      );
    },
  });
  const leaveGroupMutation = useMutation({
    mutationFn: () => leaveGroupConversation(pb, conversationId),
    onSuccess: async (response) => {
      await applyGroupMutationResponse(mutationContext, response);
      router.replace('/(tabs)');
    },
    onError: (error) => {
      Alert.alert(
        'Could not leave group',
        getErrorMessage(error, 'Check your connection and try again.'),
      );
    },
  });
  const updateGroupMutation = useMutation({
    mutationFn: (input: {
      avatar?: ConversationAvatarUploadFile;
      defaultHistoryPolicy: GroupHistoryPolicy;
      description: string;
      title: string;
    }) => updateGroupConversation(pb, conversationId, input),
    onSuccess: async (response) => {
      await applyGroupMutationResponse(mutationContext, response);
      setIsEditVisible(false);
    },
    onError: (error) => {
      Alert.alert(
        'Could not update group',
        getErrorMessage(error, 'Check your connection and try again.'),
      );
    },
  });

  useEffect(() => {
    if (!conversationId || !isOnline) {
      return;
    }

    void chatSyncService.syncNow('manual').catch(() => {
      // Realtime or reconnect will trigger the next sync if this one fails.
    });
  }, [chatSyncService, conversationId, isOnline]);

  useEffect(() => {
    if (!isOnline || memberUserIds.length === 0) {
      return;
    }

    let isMounted = true;
    void refreshCachedProfilesByUserIds(pb, memberUserIds)
      .then((profiles) => {
        if (isMounted) {
          queryClient.setQueryData(
            ['profiles', 'group-info-members', conversationId, memberUserIds],
            profiles,
          );
        }
      })
      .catch(() => {
        // Cached member names stay visible until the next refresh.
      });

    return () => {
      isMounted = false;
    };
  }, [conversationId, isOnline, memberUserIds, queryClient]);

  const confirmRemoveMember = (member: MemberView) => {
    if (!canManageMembers || member.isCurrentUser || member.role === 'owner') {
      return;
    }

    Alert.alert('Remove member?', `${member.name} will lose access to this group.`, [
      { style: 'cancel', text: 'Cancel' },
      {
        onPress: () => removeMemberMutation.mutate(member.userId),
        style: 'destructive',
        text: 'Remove',
      },
    ]);
  };

  const confirmLeaveGroup = () => {
    Alert.alert('Leave group?', 'You will stop receiving messages from this group.', [
      { style: 'cancel', text: 'Cancel' },
      {
        onPress: () => leaveGroupMutation.mutate(),
        style: 'destructive',
        text: 'Leave',
      },
    ]);
  };

  return (
    <View className="flex-1 bg-background">
      <View
        className="border-b border-border/60 bg-background/95 px-5"
        style={{ height: insets.top + HEADER_HEIGHT, paddingTop: insets.top }}
      >
        <View className="flex-1 flex-row items-center justify-between">
          <Pressable
            className="h-12 w-12 items-center justify-center rounded-full bg-muted"
            onPress={() => router.back()}
          >
            <Ionicons color="#f8fafc" name="chevron-back" size={28} />
          </Pressable>
          <Pressable
            className="h-12 items-center justify-center rounded-full bg-muted px-5"
            disabled={!canManageGroup || !conversation}
            onPress={() => setIsEditVisible(true)}
          >
            <Text
              className={`text-lg font-black ${canManageGroup ? 'text-foreground' : 'text-muted-foreground'}`}
            >
              Edit
            </Text>
          </Pressable>
        </View>
      </View>

      <ScrollView
        className="flex-1"
        contentContainerStyle={{
          paddingBottom: Math.max(insets.bottom, 20) + 24,
          paddingHorizontal: 20,
          paddingTop: 26,
        }}
        showsVerticalScrollIndicator={false}
      >
        <View className="items-center">
          <ConversationAvatar
            conversation={conversation}
            fileToken={fileTokenQuery.data}
            members={members}
            name={title}
            size={128}
            variant="large"
          />
          <Text
            className="mt-5 text-center text-[34px] font-black tracking-[-1px] text-foreground"
            numberOfLines={2}
          >
            {title}
          </Text>
          <Text className="mt-1 text-lg font-semibold text-muted-foreground">
            {memberCount} {memberCount === 1 ? 'member' : 'members'}
          </Text>
        </View>

        <View className="mt-8 flex-row gap-3">
          <InfoAction icon="videocam" label="video chat" />
          <InfoAction icon="notifications" label="mute" />
          <InfoAction icon="search" label="search" />
          <InfoAction icon="ellipsis-horizontal" label="more" />
        </View>

        <View className="mt-7 rounded-[26px] bg-muted px-4 py-4">
          <Text className="text-base font-semibold text-foreground">id: {conversationId}</Text>
        </View>

        <View className="mt-7 overflow-hidden rounded-[28px] bg-muted px-4">
          <Pressable
            className="min-h-[66px] flex-row items-center gap-3 border-b border-border/60"
            disabled={!canManageMembers || addMembersMutation.isPending}
            onPress={() => setIsAddMembersVisible(true)}
          >
            <View className="h-11 w-11 items-center justify-center rounded-full bg-primary/15">
              <Ionicons color="#60a5fa" name="person-add-outline" size={24} />
            </View>
            <Text
              className={`text-lg font-semibold ${canManageMembers ? 'text-primary' : 'text-muted-foreground'}`}
            >
              Add Members
            </Text>
          </Pressable>

          {conversationQuery.isLoading || membershipsQuery.isLoading ? (
            <View className="items-center py-10">
              <Text className="text-base font-bold text-muted-foreground">Loading members</Text>
            </View>
          ) : members.length ? (
            members.map((member, index) => (
              <MemberRow
                canRemove={canRemoveMember(currentMembership, member)}
                isLast={index === members.length - 1}
                isRemoving={removeMemberMutation.isPending}
                key={member.id}
                member={member}
                onRemove={() => confirmRemoveMember(member)}
              />
            ))
          ) : (
            <View className="items-center py-10">
              <Text className="text-base font-bold text-muted-foreground">No members found</Text>
            </View>
          )}
        </View>

        <Pressable
          className="mt-7 min-h-[58px] items-center justify-center rounded-[24px] bg-red-500/10"
          disabled={leaveGroupMutation.isPending}
          onPress={confirmLeaveGroup}
        >
          <Text className="text-lg font-black text-red-300">
            {leaveGroupMutation.isPending ? 'Leaving...' : 'Leave Group'}
          </Text>
        </Pressable>
      </ScrollView>

      <AddMembersModal
        activeMemberIds={memberUserIds}
        currentUserId={authRecord.id}
        isPending={addMembersMutation.isPending}
        memberSlotsRemaining={Math.max(0, MAX_GROUP_MEMBERS - activeMemberships.length)}
        onAdd={(memberUserIdsToAdd) => addMembersMutation.mutate(memberUserIdsToAdd)}
        onClose={() => setIsAddMembersVisible(false)}
        visible={isAddMembersVisible}
      />
      {conversation ? (
        <EditGroupModal
          conversation={conversation}
          isPending={updateGroupMutation.isPending}
          onClose={() => setIsEditVisible(false)}
          onSave={(input) => updateGroupMutation.mutate(input)}
          visible={isEditVisible}
        />
      ) : null}
    </View>
  );
}

function InfoAction({ icon, label }: { icon: keyof typeof Ionicons.glyphMap; label: string }) {
  return (
    <Pressable className="h-24 flex-1 items-center justify-center rounded-[22px] bg-muted" disabled>
      <Ionicons color="#60a5fa" name={icon} size={26} />
      <Text className="mt-2 text-center text-xs font-bold text-primary" numberOfLines={1}>
        {label}
      </Text>
    </Pressable>
  );
}

function MemberRow({
  canRemove,
  isLast,
  isRemoving,
  member,
  onRemove,
}: {
  canRemove: boolean;
  isLast: boolean;
  isRemoving: boolean;
  member: MemberView;
  onRemove: () => void;
}) {
  return (
    <Pressable
      className={`min-h-[72px] flex-row items-center gap-3 ${isLast ? '' : 'border-b border-border/60'}`}
      onLongPress={canRemove && !isRemoving ? onRemove : undefined}
      onPress={
        member.isCurrentUser
          ? undefined
          : () =>
              router.push({
                pathname: '/profile/[userId]',
                params: { userId: member.userId },
              })
      }
    >
      <ProfileAvatar
        avatarUrl={member.avatarUrl}
        name={member.name}
        size={48}
        userId={member.userId}
        username={member.username}
      />
      <View className="min-w-0 flex-1">
        <Text className="text-[17px] font-semibold text-foreground" numberOfLines={1}>
          {member.name}
        </Text>
        <Text className="mt-0.5 text-sm font-semibold text-muted-foreground" numberOfLines={1}>
          {member.note}
        </Text>
      </View>
      {member.role === 'owner' ? (
        <View className="rounded-full bg-primary/15 px-3 py-1.5">
          <Text className="text-xs font-black text-primary">owner</Text>
        </View>
      ) : canRemove ? (
        <Pressable
          className="h-9 w-9 items-center justify-center rounded-full bg-background/60"
          disabled={isRemoving}
          onPress={onRemove}
        >
          <Ionicons color="#fb7185" name="remove" size={18} />
        </Pressable>
      ) : null}
    </Pressable>
  );
}

function AddMembersModal({
  activeMemberIds,
  currentUserId,
  isPending,
  memberSlotsRemaining,
  onAdd,
  onClose,
  visible,
}: {
  activeMemberIds: string[];
  currentUserId: string;
  isPending: boolean;
  memberSlotsRemaining: number;
  onAdd: (memberUserIds: string[]) => void;
  onClose: () => void;
  visible: boolean;
}) {
  const insets = useSafeAreaInsets();
  const queryClient = useQueryClient();
  const netInfo = useNetInfo();
  const searchRef = useRef<TextInput>(null);
  const [query, setQuery] = useState('');
  const [selectedUserIds, setSelectedUserIds] = useState<string[]>([]);
  const activeMemberSet = useMemo(() => new Set(activeMemberIds), [activeMemberIds]);
  const isOnline = Boolean(netInfo.isConnected && netInfo.isInternetReachable !== false);

  const friendshipsQuery = useQuery({
    queryKey: ['friendships', currentUserId, 'group-add-members'],
    queryFn: () => listCachedFriendships(pb),
    enabled: visible,
    networkMode: 'always',
  });
  const fileTokenQuery = useQuery({
    queryKey: ['file-token', currentUserId],
    queryFn: () => pb.files.getToken(),
    staleTime: 1000 * 60 * 5,
  });
  const addableUserIds = useMemo(
    () =>
      getAcceptedFriendUserIds(friendshipsQuery.data ?? [], currentUserId).filter(
        (userId) => !activeMemberSet.has(userId),
      ),
    [activeMemberSet, currentUserId, friendshipsQuery.data],
  );
  const profilesQuery = useQuery({
    queryKey: ['profiles', 'group-addable-friends', addableUserIds],
    queryFn: () => listCachedProfilesByUserIds(pb, addableUserIds),
    enabled: visible && addableUserIds.length > 0,
    networkMode: 'always',
  });
  const friends = useMemo(
    () => toAddableFriends(profilesQuery.data ?? [], fileTokenQuery.data),
    [fileTokenQuery.data, profilesQuery.data],
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
  const selectedSet = useMemo(() => new Set(selectedUserIds), [selectedUserIds]);

  useEffect(() => {
    if (!visible) {
      setQuery('');
      setSelectedUserIds([]);
      return;
    }

    const focusTimer = setTimeout(() => searchRef.current?.focus(), 220);
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
          queryClient.setQueryData(
            ['friendships', currentUserId, 'group-add-members'],
            friendships,
          );
        }
      })
      .catch(() => {
        // Cached friend list remains usable while offline.
      });

    return () => {
      isMounted = false;
    };
  }, [currentUserId, isOnline, queryClient, visible]);

  useEffect(() => {
    if (!visible || !isOnline || addableUserIds.length === 0) {
      return;
    }

    let isMounted = true;
    void refreshCachedProfilesByUserIds(pb, addableUserIds)
      .then((profiles) => {
        if (isMounted) {
          queryClient.setQueryData(['profiles', 'group-addable-friends', addableUserIds], profiles);
        }
      })
      .catch(() => {
        // Profile cache is enough for add-member search.
      });

    return () => {
      isMounted = false;
    };
  }, [addableUserIds, isOnline, queryClient, visible]);

  const toggleSelected = (userId: string) => {
    setSelectedUserIds((current) => {
      if (current.includes(userId)) {
        return current.filter((id) => id !== userId);
      }

      if (current.length >= memberSlotsRemaining) {
        Alert.alert('Group is full', 'This group cannot add more members.');
        return current;
      }

      return [...current, userId];
    });
  };

  const close = () => {
    Keyboard.dismiss();
    onClose();
  };

  const canAdd = selectedUserIds.length > 0 && !isPending;

  return (
    <Modal
      animationType="slide"
      onRequestClose={close}
      presentationStyle="fullScreen"
      visible={visible}
    >
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        className="flex-1 bg-background"
      >
        <View
          className="border-b border-border/60 bg-background/95 px-5"
          style={{ height: insets.top + HEADER_HEIGHT, paddingTop: insets.top }}
        >
          <View className="flex-1 flex-row items-center justify-between">
            <Pressable className="h-12 justify-center" disabled={isPending} onPress={close}>
              <Text className="text-[17px] font-bold text-muted-foreground">Cancel</Text>
            </Pressable>
            <View className="items-center">
              <Text className="text-xl font-black text-foreground">Add Members</Text>
              <Text className="text-xs font-bold text-muted-foreground">
                {selectedUserIds.length}/{memberSlotsRemaining}
              </Text>
            </View>
            <Pressable disabled={!canAdd} onPress={() => onAdd(selectedUserIds)}>
              <Text
                className={`text-[17px] font-black ${canAdd ? 'text-primary' : 'text-muted-foreground'}`}
              >
                {isPending ? 'Adding' : 'Add'}
              </Text>
            </Pressable>
          </View>
        </View>

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
              placeholder="Search friends"
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

          {friendshipsQuery.isLoading && friends.length === 0 ? (
            <EmptyState icon="people" title="Loading friends" />
          ) : visibleFriends.length ? (
            visibleFriends.map((friend) => (
              <AddableFriendRow
                friend={friend}
                isSelected={selectedSet.has(friend.userId)}
                key={friend.userId}
                onPress={() => toggleSelected(friend.userId)}
              />
            ))
          ) : (
            <EmptyState icon="search" title={query ? 'No matching friends' : 'No friends to add'} />
          )}
        </ScrollView>
      </KeyboardAvoidingView>
    </Modal>
  );
}

function EditGroupModal({
  conversation,
  isPending,
  onClose,
  onSave,
  visible,
}: {
  conversation: ConversationRecord;
  isPending: boolean;
  onClose: () => void;
  onSave: (input: {
    avatar?: ConversationAvatarUploadFile;
    defaultHistoryPolicy: GroupHistoryPolicy;
    description: string;
    title: string;
  }) => void;
  visible: boolean;
}) {
  const insets = useSafeAreaInsets();
  const titleRef = useRef<TextInput>(null);
  const [title, setTitle] = useState(conversation.title || '');
  const [description, setDescription] = useState(conversation.description || '');
  const [selectedAvatar, setSelectedAvatar] = useState<ImagePicker.ImagePickerAsset | null>(null);
  const [historyPolicy, setHistoryPolicy] = useState<GroupHistoryPolicy>(
    conversation.default_history_policy || 'full',
  );

  useEffect(() => {
    if (!visible) {
      return;
    }

    setTitle(conversation.title || '');
    setDescription(conversation.description || '');
    setSelectedAvatar(null);
    setHistoryPolicy(conversation.default_history_policy || 'full');
    const focusTimer = setTimeout(() => titleRef.current?.focus(), 220);

    return () => clearTimeout(focusTimer);
  }, [conversation, visible]);

  const trimmedTitle = title.trim();
  const trimmedDescription = description.trim();
  const canSave =
    trimmedTitle.length > 0 &&
    !isPending &&
    (Boolean(selectedAvatar) ||
      trimmedTitle !== (conversation.title || '') ||
      trimmedDescription !== (conversation.description || '') ||
      historyPolicy !== (conversation.default_history_policy || 'full'));
  const uploadFile = selectedAvatar ? toConversationAvatarUploadFile(selectedAvatar) : undefined;
  const pickAvatar = async () => {
    const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!permission.granted) {
      Alert.alert('Photos access needed', 'Allow photos access to choose a group image.');
      return;
    }

    const result = await ImagePicker.launchImageLibraryAsync({
      allowsEditing: true,
      aspect: [1, 1],
      mediaTypes: ['images'],
      quality: 0.9,
    });

    if (!result.canceled) {
      setSelectedAvatar(result.assets[0] ?? null);
    }
  };
  const close = () => {
    Keyboard.dismiss();
    onClose();
  };

  return (
    <Modal
      animationType="slide"
      onRequestClose={close}
      presentationStyle="fullScreen"
      visible={visible}
    >
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        className="flex-1 bg-background"
      >
        <View
          className="border-b border-border/60 bg-background/95 px-5"
          style={{ height: insets.top + HEADER_HEIGHT, paddingTop: insets.top }}
        >
          <View className="flex-1 flex-row items-center justify-between">
            <Pressable className="h-12 justify-center" disabled={isPending} onPress={close}>
              <Text className="text-[17px] font-bold text-muted-foreground">Cancel</Text>
            </Pressable>
            <Text className="text-xl font-black text-foreground">Edit Group</Text>
            <Pressable
              disabled={!canSave}
              onPress={() =>
                onSave({
                  defaultHistoryPolicy: historyPolicy,
                  description: trimmedDescription,
                  title: trimmedTitle,
                  ...(uploadFile ? { avatar: uploadFile } : {}),
                })
              }
            >
              <Text
                className={`text-[17px] font-black ${canSave ? 'text-primary' : 'text-muted-foreground'}`}
              >
                {isPending ? 'Saving' : 'Done'}
              </Text>
            </Pressable>
          </View>
        </View>

        <ScrollView
          className="flex-1"
          contentContainerStyle={{
            paddingBottom: Math.max(insets.bottom, 20) + 24,
            paddingHorizontal: 20,
            paddingTop: 28,
          }}
          keyboardDismissMode="on-drag"
          keyboardShouldPersistTaps="handled"
          onScrollBeginDrag={Keyboard.dismiss}
          showsVerticalScrollIndicator={false}
        >
          <View className="items-center pb-7">
            <Pressable className="items-center" onPress={pickAvatar}>
              {selectedAvatar ? (
                <ProfileAvatar
                  avatarUrl={selectedAvatar.uri}
                  name={conversation.title || 'Group chat'}
                  size={116}
                  userId={conversation.id}
                  username={conversation.title || 'group'}
                />
              ) : (
                <ConversationAvatar
                  conversation={conversation}
                  members={[]}
                  name={conversation.title || 'Group chat'}
                  size={116}
                  variant="large"
                />
              )}
              <View className="absolute bottom-8 right-0 h-9 w-9 items-center justify-center rounded-full border-4 border-background bg-foreground">
                <Ionicons color="#080b12" name="camera" size={16} />
              </View>
            </Pressable>
            <Text className="mt-4 text-[17px] font-semibold text-primary">Set New Photo</Text>
          </View>

          <View className="overflow-hidden rounded-[28px] bg-muted">
            <View className="px-5 py-4">
              <Text className="text-xs font-bold uppercase tracking-[0.8px] text-muted-foreground">
                Group Name
              </Text>
              <TextInput
                autoCapitalize="sentences"
                className="mt-2 min-w-0 py-1 text-[19px] font-semibold text-foreground"
                maxLength={80}
                onChangeText={setTitle}
                placeholder="Group name"
                placeholderTextColor="#64748b"
                ref={titleRef}
                selectionColor="#f8fafc"
                value={title}
              />
            </View>
            <View className="ml-5 border-b border-border/70" />
            <View className="px-5 py-4">
              <Text className="text-xs font-bold uppercase tracking-[0.8px] text-muted-foreground">
                Description
              </Text>
              <TextInput
                className="mt-2 min-h-[74px] min-w-0 py-1 text-[17px] font-semibold leading-6 text-foreground"
                maxLength={180}
                multiline
                onChangeText={setDescription}
                placeholder="Describe this group"
                placeholderTextColor="#64748b"
                selectionColor="#f8fafc"
                textAlignVertical="top"
                value={description}
              />
              <Text className="mt-1 text-right text-xs font-semibold text-muted-foreground">
                {description.trim().length}/180
              </Text>
            </View>
          </View>

          <View className="mt-7 rounded-[28px] bg-muted px-5 py-4">
            <View className="flex-row items-center justify-between gap-4">
              <View className="min-w-0 flex-1">
                <Text className="text-[17px] font-bold text-foreground">Chat History</Text>
                <Text className="mt-1 text-sm font-medium leading-5 text-muted-foreground">
                  Let new members see messages from before they joined.
                </Text>
              </View>
              <Switch
                ios_backgroundColor="#1f2937"
                onValueChange={(enabled) => setHistoryPolicy(enabled ? 'full' : 'since_join')}
                thumbColor="#f8fafc"
                trackColor={{ false: '#334155', true: '#60a5fa' }}
                value={historyPolicy === 'full'}
              />
            </View>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </Modal>
  );
}

function AddableFriendRow({
  friend,
  isSelected,
  onPress,
}: {
  friend: AddableFriend;
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

function toMemberView(
  membership: ConversationMembershipRecord,
  profilesByUserId: Map<string, ProfileRecord>,
  currentUserId: string,
  fileToken?: string,
): MemberView {
  const profile = profilesByUserId.get(membership.user);
  const name =
    profile?.display_name ||
    profile?.username ||
    (membership.user === currentUserId ? 'You' : 'Member');
  const username = profile?.username || 'unknown';
  const isCurrentUser = membership.user === currentUserId;

  return {
    avatarUrl: profile ? getProfileAvatarUrl(pb, profile, fileToken, 'thumb') : null,
    id: membership.id,
    isCurrentUser,
    name: isCurrentUser ? `${name} (You)` : name,
    note: isCurrentUser ? 'online' : `@${username}`,
    role: membership.role,
    userId: membership.user,
    username,
  };
}

async function applyGroupMutationResponse(
  context: GroupMutationContext,
  response: GroupMutationResponse,
) {
  await applyLocalChatRecords(context.authId, {
    conversation: response.conversation,
    membership: response.membership,
  });
  for (const membership of response.memberships ?? []) {
    await applyLocalChatRecords(context.authId, { membership });
  }
  await context.chatSyncService.syncNow('manual');
  await context.queryClient.invalidateQueries({
    queryKey: ['chat', context.authId],
  });
  await context.queryClient.invalidateQueries({
    queryKey: ['chat', context.authId, 'memberships', context.conversationId],
  });
}

function membershipCanManageGroup(membership: ConversationMembershipRecord): boolean {
  return membership.role === 'owner' || membership.role === 'admin';
}

function membershipCanManageMembers(membership: ConversationMembershipRecord): boolean {
  return membership.role === 'owner' || membership.role === 'admin';
}

function canRemoveMember(
  currentMembership: ConversationMembershipRecord | undefined,
  member: MemberView,
): boolean {
  if (!currentMembership || member.isCurrentUser || member.role === 'owner') {
    return false;
  }

  if (currentMembership.role === 'owner') {
    return true;
  }

  return currentMembership.role === 'admin' && member.role === 'member';
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

function toAddableFriends(profiles: ProfileRecord[], fileToken?: string): AddableFriend[] {
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

function toConversationAvatarUploadFile(
  asset: ImagePicker.ImagePickerAsset,
): ConversationAvatarUploadFile {
  const type = asset.mimeType || 'image/jpeg';
  const extension = type.split('/')[1] || 'jpg';

  return {
    name: asset.fileName || `group-avatar.${extension}`,
    type,
    uri: asset.uri,
  };
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
