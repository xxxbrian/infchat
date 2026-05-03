import Ionicons from '@expo/vector-icons/Ionicons';
import {
  getPrivacySettings,
  type PresenceVisibility,
  updatePrivacySettings,
  type PrivacySettingsRecord,
} from '@infchat/pocketbase';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { router } from 'expo-router';
import { Alert, Pressable, ScrollView, StyleSheet, Switch, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useAuth } from '../../lib/auth-context';
import { pb } from '../../lib/pocketbase';

type PrivacyField = 'mutual' | 'presence' | 'public';

const presenceOptions: Array<{ label: string; value: PresenceVisibility }> = [
  { label: 'Everybody', value: 'everybody' },
  { label: 'Friends and shared chats', value: 'contacts_and_shared_chats' },
  { label: 'Nobody', value: 'nobody' },
];

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
    mutationFn: ({
      field,
      value,
    }: {
      field: PrivacyField;
      value: boolean | PresenceVisibility;
    }) => {
      if (!settings) {
        throw new Error('Privacy settings are not loaded');
      }

      return updatePrivacySettings(pb, settings.id, {
        presenceVisibility:
          field === 'presence' ? (value as PresenceVisibility) : settings.presence_visibility,
        showInMutualSuggestions:
          field === 'mutual' ? Boolean(value) : settings.show_in_mutual_suggestions,
        showInPublicSuggestions:
          field === 'public' ? Boolean(value) : settings.show_in_public_suggestions,
      });
    },
    onMutate: async ({ field, value }) => {
      await queryClient.cancelQueries({ queryKey: privacySettingsQueryKey });
      const previousSettings =
        queryClient.getQueryData<PrivacySettingsRecord>(privacySettingsQueryKey);

      if (previousSettings) {
        queryClient.setQueryData<PrivacySettingsRecord>(privacySettingsQueryKey, {
          ...previousSettings,
          ...(field === 'mutual' ? { show_in_mutual_suggestions: Boolean(value) } : {}),
          ...(field === 'presence' ? { presence_visibility: value as PresenceVisibility } : {}),
          ...(field === 'public' ? { show_in_public_suggestions: Boolean(value) } : {}),
        });
      }

      return { previousSettings };
    },
    onSuccess: (nextSettings) => {
      queryClient.setQueryData(privacySettingsQueryKey, nextSettings);
      void queryClient.invalidateQueries({
        queryKey: ['friend-suggestions', authRecord.id],
      });
      void queryClient.invalidateQueries({
        queryKey: ['presence'],
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
            <PresenceVisibilityRow
              disabled={isMutating}
              onValueChange={(value) => updateMutation.mutate({ field: 'presence', value })}
              value={settings?.presence_visibility ?? 'contacts_and_shared_chats'}
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

function PresenceVisibilityRow({
  disabled,
  onValueChange,
  value,
}: {
  disabled?: boolean;
  onValueChange: (value: PresenceVisibility) => void;
  value: PresenceVisibility;
}) {
  return (
    <View className="border-b border-border/70 px-5 py-4">
      <Text className="text-[16px] font-semibold text-foreground">Last Seen & Online</Text>
      <View className="mt-3 gap-2">
        {presenceOptions.map((option) => {
          const isSelected = option.value === value;

          return (
            <Pressable
              className={`min-h-11 flex-row items-center justify-between rounded-2xl border px-4 ${
                isSelected ? 'border-primary bg-primary/15' : 'border-border/60 bg-background/35'
              }`}
              disabled={disabled}
              key={option.value}
              onPress={() => onValueChange(option.value)}
            >
              <Text
                className={`min-w-0 flex-1 text-[15px] font-semibold ${
                  isSelected ? 'text-primary' : 'text-foreground'
                }`}
                numberOfLines={1}
              >
                {option.label}
              </Text>
              {isSelected ? <Ionicons color="#60a5fa" name="checkmark" size={18} /> : null}
            </Pressable>
          );
        })}
      </View>
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
