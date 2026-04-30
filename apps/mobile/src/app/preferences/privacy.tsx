import Ionicons from '@expo/vector-icons/Ionicons';
import {
  getPrivacySettings,
  updatePrivacySettings,
  type PrivacySettingsRecord,
} from '@infchat/pocketbase';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { router } from 'expo-router';
import { Alert, Pressable, ScrollView, StyleSheet, Switch, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useAuth } from '../../lib/auth-context';
import { pb } from '../../lib/pocketbase';

type PrivacyField = 'mutual' | 'public';

export default function PrivacySettingsScreen() {
  const { authRecord } = useAuth();
  const insets = useSafeAreaInsets();
  const queryClient = useQueryClient();
  const privacySettingsQueryKey = ['privacy-settings', authRecord.id] as const;
  const settingsQuery = useQuery({
    queryKey: privacySettingsQueryKey,
    queryFn: () => getPrivacySettings(pb),
    networkMode: 'always',
  });
  const settings = settingsQuery.data;
  const updateMutation = useMutation({
    mutationFn: ({ field, value }: { field: PrivacyField; value: boolean }) => {
      if (!settings) {
        throw new Error('Privacy settings are not loaded');
      }

      return updatePrivacySettings(pb, settings.id, {
        showInMutualSuggestions: field === 'mutual' ? value : settings.show_in_mutual_suggestions,
        showInPublicSuggestions: field === 'public' ? value : settings.show_in_public_suggestions,
      });
    },
    onMutate: async ({ field, value }) => {
      await queryClient.cancelQueries({ queryKey: privacySettingsQueryKey });
      const previousSettings =
        queryClient.getQueryData<PrivacySettingsRecord>(privacySettingsQueryKey);

      if (previousSettings) {
        queryClient.setQueryData<PrivacySettingsRecord>(privacySettingsQueryKey, {
          ...previousSettings,
          ...(field === 'mutual' ? { show_in_mutual_suggestions: value } : {}),
          ...(field === 'public' ? { show_in_public_suggestions: value } : {}),
        });
      }

      return { previousSettings };
    },
    onSuccess: (nextSettings) => {
      queryClient.setQueryData(privacySettingsQueryKey, nextSettings);
      void queryClient.invalidateQueries({
        queryKey: ['friend-suggestions', authRecord.id],
      });
    },
    onError: (_error, _variables, context) => {
      if (context?.previousSettings) {
        queryClient.setQueryData(privacySettingsQueryKey, context.previousSettings);
      }
      Alert.alert('Could not update privacy', 'Check your connection and try again.');
    },
  });

  const isMutating = updateMutation.isPending || !settings;

  return (
    <View className="flex-1 bg-background">
      <View
        className="flex-row items-center justify-between border-b border-border/60 px-5 pb-3"
        style={{ paddingTop: insets.top + 8 }}
      >
        <Pressable className="h-10 w-16 justify-center" onPress={router.back}>
          <Ionicons color="#94a3b8" name="chevron-back" size={26} />
        </Pressable>
        <Text className="text-lg font-bold text-foreground">Privacy</Text>
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
          <View className="overflow-hidden rounded-[28px] bg-muted" style={styles.group}>
            <PrivacySwitchRow
              disabled={isMutating}
              isFirst
              label="Mutual friend suggestions"
              onValueChange={(value) => updateMutation.mutate({ field: 'mutual', value })}
              value={settings?.show_in_mutual_suggestions ?? true}
            />
            <PrivacySwitchRow
              disabled={isMutating}
              label="Public suggestions"
              onValueChange={(value) => updateMutation.mutate({ field: 'public', value })}
              value={settings?.show_in_public_suggestions ?? false}
            />
          </View>
        </View>
      </ScrollView>
    </View>
  );
}

function PrivacySwitchRow({
  disabled,
  isFirst,
  label,
  onValueChange,
  value,
}: {
  disabled?: boolean;
  isFirst?: boolean;
  label: string;
  onValueChange: (value: boolean) => void;
  value: boolean;
}) {
  return (
    <View className="px-5">
      <View
        className={`min-h-[62px] flex-row items-center justify-between gap-4 ${isFirst ? 'border-b border-border/70' : ''}`}
      >
        <Text className="min-w-0 flex-1 text-[16px] font-semibold text-foreground">{label}</Text>
        <View className="h-[62px] justify-center">
          <Switch
            disabled={disabled}
            ios_backgroundColor="#334155"
            onValueChange={onValueChange}
            style={styles.switch}
            thumbColor="#f8fafc"
            trackColor={{ false: '#334155', true: '#2563eb' }}
            value={value}
          />
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  group: {
    borderCurve: 'continuous',
  },
  switch: {
    transform: [{ translateY: 1 }],
  },
});
