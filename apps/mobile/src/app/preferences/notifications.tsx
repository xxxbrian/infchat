import Ionicons from '@expo/vector-icons/Ionicons';
import Constants from 'expo-constants';
import * as Notifications from 'expo-notifications';
import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import {
  AppState,
  Linking,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import {
  getPushEnvironment,
  getPushProviderLabel,
  isPushRegistrationSupported,
  registerPushDeviceForPlatform,
} from '../../lib/push-notifications';

type PermissionState = {
  canAskAgain?: boolean;
  granted: boolean;
  status: string;
};

export default function NotificationSettingsScreen() {
  const insets = useSafeAreaInsets();
  const [permission, setPermission] = useState<PermissionState | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [lastRegistrationStatus, setLastRegistrationStatus] = useState('Not retried yet');

  const loadPermission = async () => {
    const nextPermission = await Notifications.getPermissionsAsync();
    setPermission({
      canAskAgain: nextPermission.canAskAgain,
      granted: nextPermission.granted,
      status: nextPermission.status,
    });
  };

  useEffect(() => {
    void loadPermission();
  }, []);

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (status) => {
      if (status === 'active') {
        void loadPermission();
      }
    });

    return () => subscription.remove();
  }, []);

  const handleRequestPermission = async () => {
    setIsRefreshing(true);
    try {
      await Notifications.requestPermissionsAsync({
        ios: {
          allowAlert: true,
          allowBadge: true,
          allowSound: true,
        },
      });
      await loadPermission();
      const didRegister = await registerPushDeviceForPlatform(Constants.expoConfig?.version, {
        throwOnFailure: true,
      });
      setLastRegistrationStatus(didRegister ? 'Registration updated' : 'Registration unavailable');
    } catch {
      setLastRegistrationStatus('Retry failed; try again later');
    } finally {
      setIsRefreshing(false);
    }
  };

  const handleRetryRegistration = async () => {
    setIsRefreshing(true);
    try {
      const didRegister = await registerPushDeviceForPlatform(Constants.expoConfig?.version, {
        throwOnFailure: true,
      });
      await loadPermission();
      setLastRegistrationStatus(didRegister ? 'Registration updated' : 'Registration unavailable');
    } catch {
      setLastRegistrationStatus('Retry failed; try again later');
    } finally {
      setIsRefreshing(false);
    }
  };

  const handleOpenSettings = () => {
    void Linking.openSettings();
  };

  const permissionLabel = permission?.granted
    ? 'Allowed'
    : formatPermissionStatus(permission?.status);
  const isRegistrationSupported = isPushRegistrationSupported();
  const canRequestPermission = permission?.canAskAgain !== false;

  return (
    <View className="flex-1 bg-background">
      <View
        className="flex-row items-center justify-between border-b border-border/60 px-5 pb-3"
        style={{ paddingTop: insets.top + 8 }}
      >
        <Pressable className="h-10 w-16 justify-center" onPress={router.back}>
          <Ionicons color="#94a3b8" name="chevron-back" size={26} />
        </Pressable>
        <Text className="text-lg font-bold text-foreground">Notifications</Text>
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
            Manage device notification permission and retry push registration for this device.
          </Text>

          <View className="mt-5 overflow-hidden rounded-[28px] bg-muted" style={styles.group}>
            <InfoRow label="Permission" value={permissionLabel} />
            <InfoRow
              label="Can ask again"
              value={permission?.canAskAgain === false ? 'No' : 'Yes'}
            />
            <InfoRow label="Provider" value={getPushProviderLabel()} />
            {Platform.OS === 'ios' ? (
              <InfoRow label="APNs environment" value={getPushEnvironment()} />
            ) : null}
            {Platform.OS === 'android' ? (
              <InfoRow label="Call notifications" value="Not supported yet" />
            ) : null}
            <InfoRow label="Last retry" value={lastRegistrationStatus} />
          </View>

          <View className="mt-5 gap-3">
            {canRequestPermission ? (
              <ActionButton
                disabled={isRefreshing}
                icon="notifications"
                label="Request Permission"
                onPress={handleRequestPermission}
              />
            ) : null}
            <ActionButton
              disabled={isRefreshing || !isRegistrationSupported}
              icon="refresh"
              label="Retry Push Registration"
              onPress={handleRetryRegistration}
            />
            <ActionButton
              icon="settings"
              label="Open System Settings"
              onPress={handleOpenSettings}
            />
          </View>
        </View>
      </ScrollView>
    </View>
  );
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <View className="px-5">
      <View className="border-b border-border/70 py-4">
        <Text className="text-xs font-bold uppercase tracking-[0.8px] text-muted-foreground">
          {label}
        </Text>
        <Text className="mt-2 text-[16px] font-semibold text-foreground">{value}</Text>
      </View>
    </View>
  );
}

function ActionButton({
  disabled,
  icon,
  label,
  onPress,
}: {
  disabled?: boolean;
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  onPress: () => void;
}) {
  return (
    <Pressable
      className={`flex-row items-center justify-center rounded-full bg-foreground px-5 py-4 ${disabled ? 'opacity-50' : ''}`}
      disabled={disabled}
      onPress={onPress}
    >
      <Ionicons color="#080b12" name={icon} size={18} />
      <Text className="ml-2 text-base font-black text-background">{label}</Text>
    </Pressable>
  );
}

function formatPermissionStatus(status?: string) {
  if (!status) {
    return 'Unknown';
  }

  return status.slice(0, 1).toUpperCase() + status.slice(1);
}

const styles = StyleSheet.create({
  group: {
    borderCurve: 'continuous',
  },
});
