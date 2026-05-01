import Ionicons from '@expo/vector-icons/Ionicons';
import {
  type ConversationMembershipRecord,
  getProfileAvatarUrl,
  type ProfileRecord,
} from '@infchat/pocketbase';
import { useNetInfo } from '@react-native-community/netinfo';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useMemo } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { ProfileAvatar } from '../../../components/ProfileAvatar';
import { useAuth } from '../../../lib/auth-context';
import { useChatSyncService } from '../../../lib/chat-sync-context';
import {
  getLocalConversation,
  listLocalMembershipsForConversation,
} from '../../../lib/chat-sync-store';
import {
  listCachedProfilesByUserIds,
  refreshCachedProfilesByUserIds,
} from '../../../lib/local-cache';
import { pb } from '../../../lib/pocketbase';

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

const HEADER_HEIGHT = 64;

export default function GroupInfoScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const conversationId = id ?? '';
  const { authRecord } = useAuth();
  const chatSyncService = useChatSyncService();
  const queryClient = useQueryClient();
  const netInfo = useNetInfo();
  const insets = useSafeAreaInsets();
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
            disabled
          >
            <Text className="text-lg font-black text-muted-foreground">Edit</Text>
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
          <GroupAvatar count={memberCount} size={128} />
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
            disabled
          >
            <View className="h-11 w-11 items-center justify-center rounded-full bg-primary/15">
              <Ionicons color="#60a5fa" name="person-add-outline" size={24} />
            </View>
            <Text className="text-lg font-semibold text-primary">Add Members</Text>
          </Pressable>

          {conversationQuery.isLoading || membershipsQuery.isLoading ? (
            <View className="items-center py-10">
              <Text className="text-base font-bold text-muted-foreground">Loading members</Text>
            </View>
          ) : members.length ? (
            members.map((member, index) => (
              <MemberRow isLast={index === members.length - 1} key={member.id} member={member} />
            ))
          ) : (
            <View className="items-center py-10">
              <Text className="text-base font-bold text-muted-foreground">No members found</Text>
            </View>
          )}
        </View>
      </ScrollView>
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

function MemberRow({ isLast, member }: { isLast: boolean; member: MemberView }) {
  return (
    <Pressable
      className={`min-h-[72px] flex-row items-center gap-3 ${isLast ? '' : 'border-b border-border/60'}`}
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
      ) : null}
    </Pressable>
  );
}

function GroupAvatar({ count, size }: { count: number; size: number }) {
  return (
    <View
      className="items-center justify-center rounded-full bg-primary"
      style={{ height: size, width: size }}
    >
      <Text className="font-black text-background" style={{ fontSize: Math.max(28, size * 0.42) }}>
        {Math.max(1, count)}
      </Text>
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
    avatarUrl: profile ? getProfileAvatarUrl(pb, profile, fileToken) : null,
    id: membership.id,
    isCurrentUser,
    name: isCurrentUser ? `${name} (You)` : name,
    note: isCurrentUser ? 'online' : `@${username}`,
    role: membership.role,
    userId: membership.user,
    username,
  };
}
