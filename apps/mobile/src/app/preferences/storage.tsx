import Ionicons from '@expo/vector-icons/Ionicons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { router } from 'expo-router';
import { Alert, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useAuth } from '../../lib/auth-context';
import {
  clearManagedMediaCache,
  getMediaCacheUsageSummary,
  type MediaCacheUsageSummary,
} from '../../lib/media-cache';

type CacheType = keyof MediaCacheUsageSummary['byType'];

const CACHE_TYPE_LABELS: Record<CacheType, string> = {
  files: 'Files',
  images: 'Images',
  other: 'Other',
  videos: 'Videos',
  voice: 'Voice',
};

export default function StorageSettingsScreen() {
  const { authRecord } = useAuth();
  const insets = useSafeAreaInsets();
  const queryClient = useQueryClient();
  const queryKey = ['media-cache-usage', authRecord.id] as const;
  const usageQuery = useQuery({
    queryKey,
    queryFn: () => getMediaCacheUsageSummary(authRecord.id),
    networkMode: 'always',
  });
  const clearMutation = useMutation({
    mutationFn: (type?: CacheType) =>
      clearManagedMediaCache(authRecord.id, {
        includePinned: true,
        includeProtected: true,
        ...(type ? { type } : {}),
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey });
      await queryClient.invalidateQueries({
        queryKey: ['chat', authRecord.id, 'media-cache'],
      });
    },
    onError: () => {
      Alert.alert('Could not clear cache', 'Try again later.');
    },
  });
  const usage = usageQuery.data;
  const isClearing = clearMutation.isPending;

  const confirmClear = (type?: CacheType) => {
    const label = type ? CACHE_TYPE_LABELS[type].toLowerCase() : 'media';
    Alert.alert('Clear cache?', `This removes downloaded ${label} cache that is not protected.`, [
      { style: 'cancel', text: 'Cancel' },
      {
        onPress: () => clearMutation.mutate(type),
        style: 'destructive',
        text: 'Clear',
      },
    ]);
  };

  return (
    <View className="flex-1 bg-background">
      <View
        className="flex-row items-center justify-between border-b border-border/60 px-5 pb-3"
        style={{ paddingTop: insets.top + 8 }}
      >
        <Pressable className="h-10 w-16 justify-center" onPress={router.back}>
          <Ionicons color="#94a3b8" name="chevron-back" size={26} />
        </Pressable>
        <Text className="text-lg font-bold text-foreground">Data and Storage</Text>
        <View className="w-16" />
      </View>

      <ScrollView
        className="flex-1"
        contentContainerStyle={{
          paddingBottom: Math.max(insets.bottom, 20) + 24,
        }}
        showsVerticalScrollIndicator={false}
      >
        <View className="px-5 pt-5">
          <Text className="px-2 text-sm font-medium leading-5 text-muted-foreground">
            Manage InfChat media files stored on this device. Pending uploads are preserved; cached
            previews, originals, and downloaded files can be cleared here.
          </Text>

          <View className="mt-5 overflow-hidden rounded-[28px] bg-muted" style={styles.group}>
            <StorageInfoRow label="Total cache" value={formatBytes(usage?.totalBytes)} />
            <StorageInfoRow label="Cached items" value={String(usage?.entryCount ?? 0)} />
          </View>

          <View className="mt-5 overflow-hidden rounded-[28px] bg-muted" style={styles.group}>
            {(Object.keys(CACHE_TYPE_LABELS) as CacheType[]).map((type, index, types) => (
              <StorageActionRow
                disabled={isClearing || !usage?.byType[type]}
                isLast={index === types.length - 1}
                key={type}
                label={CACHE_TYPE_LABELS[type]}
                onPress={() => confirmClear(type)}
                value={formatBytes(usage?.byType[type])}
              />
            ))}
          </View>

          <Pressable
            className={`mt-5 flex-row items-center justify-center rounded-full bg-red-500 px-5 py-4 ${isClearing ? 'opacity-50' : ''}`}
            disabled={isClearing || !usage?.totalBytes}
            onPress={() => confirmClear()}
          >
            <Ionicons color="#fff" name="trash" size={18} />
            <Text className="ml-2 text-base font-black text-white">
              {isClearing ? 'Clearing...' : 'Clear Media Cache'}
            </Text>
          </Pressable>
        </View>
      </ScrollView>
    </View>
  );
}

function StorageInfoRow({ label, value }: { label: string; value: string }) {
  return (
    <View className="px-5">
      <View className="py-4">
        <Text className="text-xs font-bold uppercase tracking-[0.8px] text-muted-foreground">
          {label}
        </Text>
        <Text className="mt-2 text-[17px] font-semibold text-foreground">{value}</Text>
      </View>
    </View>
  );
}

function StorageActionRow({
  disabled,
  isLast,
  label,
  onPress,
  value,
}: {
  disabled?: boolean;
  isLast?: boolean;
  label: string;
  onPress: () => void;
  value: string;
}) {
  return (
    <Pressable
      className={`min-h-[62px] flex-row items-center px-5 ${isLast ? '' : 'border-b border-border/70'} ${disabled ? 'opacity-50' : ''}`}
      disabled={disabled}
      onPress={onPress}
    >
      <Text className="min-w-0 flex-1 text-[16px] font-semibold text-foreground">{label}</Text>
      <Text className="mr-3 text-[15px] font-semibold text-muted-foreground">{value}</Text>
      <Ionicons color="#64748b" name="trash-outline" size={18} />
    </Pressable>
  );
}

function formatBytes(value?: number | null): string {
  const bytes = value ?? 0;
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  const units = ['KB', 'MB', 'GB'];
  let size = bytes / 1024;
  let unitIndex = 0;
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }

  return `${size.toFixed(size >= 10 ? 0 : 1)} ${units[unitIndex]}`;
}

const styles = StyleSheet.create({
  group: {
    borderCurve: 'continuous',
  },
});
