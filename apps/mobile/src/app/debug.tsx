import Ionicons from '@expo/vector-icons/Ionicons';
import NetInfo, { type NetInfoState } from '@react-native-community/netinfo';
import Constants from 'expo-constants';
import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import {
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  type ViewStyle,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useAuth } from '../lib/auth-context';
import { getDeviceId } from '../lib/device-id';
import { pb, pocketBaseUrl } from '../lib/pocketbase';

type DebugItem = {
  label: string;
  value: string;
};

const NOT_SET = '(not set)';

export default function DebugScreen() {
  const insets = useSafeAreaInsets();
  const { authRecord } = useAuth();
  const [deviceId, setDeviceId] = useState<string>(NOT_SET);
  const [networkState, setNetworkState] = useState<NetInfoState | null>(null);
  const extra = Constants.expoConfig?.extra ?? {};

  useEffect(() => {
    let isMounted = true;

    getDeviceId()
      .then((nextDeviceId) => {
        if (isMounted) {
          setDeviceId(nextDeviceId);
        }
      })
      .catch(() => {
        if (isMounted) {
          setDeviceId('(unavailable)');
        }
      });

    const unsubscribe = NetInfo.addEventListener((state) => {
      setNetworkState(state);
    });

    return () => {
      isMounted = false;
      unsubscribe();
    };
  }, []);

  const envItems: DebugItem[] = [
    {
      label: 'EXPO_PUBLIC_POCKETBASE_URL',
      value: process.env.EXPO_PUBLIC_POCKETBASE_URL ?? NOT_SET,
    },
    {
      label: 'EXPO_PUBLIC_LIVEKIT_URL',
      value: process.env.EXPO_PUBLIC_LIVEKIT_URL ?? NOT_SET,
    },
    { label: 'PocketBase client URL', value: pocketBaseUrl },
    {
      label: 'Expo extra pocketbaseUrl',
      value: stringValue(extra.pocketbaseUrl),
    },
    { label: 'Expo extra livekitUrl', value: stringValue(extra.livekitUrl) },
  ];

  const appItems: DebugItem[] = [
    { label: 'App name', value: Constants.expoConfig?.name ?? NOT_SET },
    { label: 'Slug', value: Constants.expoConfig?.slug ?? NOT_SET },
    { label: 'Version', value: Constants.expoConfig?.version ?? NOT_SET },
    {
      label: 'SDK version',
      value: Constants.expoConfig?.sdkVersion ?? NOT_SET,
    },
    { label: 'Scheme', value: stringValue(Constants.expoConfig?.scheme) },
    {
      label: 'Bundle ID',
      value: Constants.expoConfig?.ios?.bundleIdentifier ?? NOT_SET,
    },
    {
      label: 'Android package',
      value: Constants.expoConfig?.android?.package ?? NOT_SET,
    },
  ];

  const runtimeItems: DebugItem[] = [
    { label: 'Platform', value: Platform.OS },
    { label: 'Platform version', value: String(Platform.Version) },
    { label: 'Device ID', value: deviceId },
    { label: 'Session ID', value: Constants.sessionId ?? NOT_SET },
    { label: 'PocketBase auth valid', value: String(pb.authStore.isValid) },
    { label: 'Auth user ID', value: authRecord.id },
    { label: 'Auth username', value: authRecord.username || NOT_SET },
  ];

  const networkItems: DebugItem[] = [
    { label: 'Network type', value: networkState?.type ?? NOT_SET },
    { label: 'Connected', value: booleanValue(networkState?.isConnected) },
    {
      label: 'Internet reachable',
      value: booleanValue(networkState?.isInternetReachable),
    },
  ];

  return (
    <View className="flex-1 bg-background">
      <View
        className="flex-row items-center justify-between border-b border-border/60 px-5 pb-3"
        style={{ paddingTop: insets.top + 8 }}
      >
        <Pressable className="h-10 w-16 justify-center" onPress={router.back}>
          <Ionicons color="#94a3b8" name="chevron-back" size={26} />
        </Pressable>
        <Text className="text-lg font-bold text-foreground">Debug</Text>
        <View className="w-16" />
      </View>

      <ScrollView
        className="flex-1"
        contentContainerStyle={{
          paddingBottom: Math.max(insets.bottom, 20) + 24,
        }}
        showsVerticalScrollIndicator={false}
      >
        <View className="px-5 pb-5 pt-5">
          <Text className="px-2 text-sm font-medium leading-5 text-muted-foreground">
            Runtime-only diagnostics for validating release builds and backend configuration.
          </Text>

          <DebugSection items={envItems} title="Environment" />
          <DebugSection items={appItems} title="App" />
          <DebugSection items={runtimeItems} title="Runtime" />
          <DebugSection items={networkItems} title="Network" />
        </View>
      </ScrollView>
    </View>
  );
}

function DebugSection({ items, title }: { items: DebugItem[]; title: string }) {
  return (
    <View className="mt-5">
      <Text className="mb-2 px-2 text-xs font-bold uppercase tracking-[0.8px] text-muted-foreground">
        {title}
      </Text>
      <View className="overflow-hidden rounded-[28px] bg-muted" style={styles.group}>
        {items.map((item, index) => (
          <View className="px-5" key={item.label}>
            <View className={`py-4 ${index < items.length - 1 ? 'border-b border-border/70' : ''}`}>
              <Text className="text-xs font-bold uppercase tracking-[0.8px] text-muted-foreground">
                {item.label}
              </Text>
              <Text className="mt-2 text-[16px] font-semibold leading-6 text-foreground" selectable>
                {item.value}
              </Text>
            </View>
          </View>
        ))}
      </View>
    </View>
  );
}

function booleanValue(value: boolean | null | undefined): string {
  if (value === null || value === undefined) {
    return NOT_SET;
  }

  return String(value);
}

function stringValue(value: unknown): string {
  if (typeof value === 'string' && value.length > 0) {
    return value;
  }

  if (Array.isArray(value)) {
    return value.join(', ');
  }

  return NOT_SET;
}

const styles = StyleSheet.create({
  group: {
    borderCurve: 'continuous',
  } as ViewStyle,
});
