import Ionicons from '@expo/vector-icons/Ionicons';
import Constants from 'expo-constants';
import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { Alert, Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import {
  type AppUpdateChannel,
  checkForAppUpdate,
  downloadAndInstallAppUpdate,
  formatAppUpdateChannel,
  getSelectedAppUpdateChannel,
  isAndroidAppUpdatesSupported,
  setSelectedAppUpdateChannel,
  type AppUpdateRelease,
} from '../../lib/app-updates';

const CHANNELS: AppUpdateChannel[] = ['stable', 'beta'];

export default function UpdateSettingsScreen() {
  const insets = useSafeAreaInsets();
  const [channel, setChannel] = useState<AppUpdateChannel>('beta');
  const [currentVersionCode, setCurrentVersionCode] = useState<number | null>(null);
  const [isChecking, setIsChecking] = useState(false);
  const [isInstalling, setIsInstalling] = useState(false);
  const [lastStatus, setLastStatus] = useState('Not checked yet');
  const [release, setRelease] = useState<AppUpdateRelease | null>(null);
  const isSupported = isAndroidAppUpdatesSupported();

  useEffect(() => {
    void getSelectedAppUpdateChannel().then(setChannel);
  }, []);

  const handleSelectChannel = async (nextChannel: AppUpdateChannel) => {
    setChannel(nextChannel);
    setRelease(null);
    setLastStatus(`Using ${formatAppUpdateChannel(nextChannel)} updates`);
    await setSelectedAppUpdateChannel(nextChannel);
  };

  const handleCheck = async () => {
    setIsChecking(true);
    try {
      const result = await checkForAppUpdate(channel);
      setCurrentVersionCode(result.currentVersionCode);
      setRelease(result.release);
      if (result.release) {
        setLastStatus(
          result.isForced
            ? `Required update ${result.release.versionName} (${result.release.versionCode})`
            : `Update ${result.release.versionName} (${result.release.versionCode}) is available`,
        );
      } else {
        setLastStatus('You are up to date');
      }
    } catch (error) {
      setLastStatus(error instanceof Error ? error.message : 'Update check failed');
    } finally {
      setIsChecking(false);
    }
  };

  const handleInstall = async () => {
    if (!release) {
      return;
    }
    setIsInstalling(true);
    try {
      await downloadAndInstallAppUpdate(release);
      setLastStatus('Installer opened');
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Could not install update';
      setLastStatus(message);
      Alert.alert('Update not installed', message);
    } finally {
      setIsInstalling(false);
    }
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
        <Text className="text-lg font-bold text-foreground">Updates</Text>
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
            Choose the Android APK update channel and check for releases published to the InfChat
            downloads bucket.
          </Text>

          <View className="mt-5 overflow-hidden rounded-[28px] bg-muted" style={styles.group}>
            <InfoRow label="Platform" value={Platform.OS} />
            <InfoRow label="App version" value={Constants.expoConfig?.version ?? 'Unknown'} />
            <InfoRow
              label="Version code"
              value={currentVersionCode ? String(currentVersionCode) : 'Unknown'}
            />
            <InfoRow
              label="Status"
              value={isSupported ? lastStatus : 'Android APK updates are not configured'}
            />
          </View>

          <View className="mt-5 overflow-hidden rounded-[28px] bg-muted" style={styles.group}>
            {CHANNELS.map((candidate, index) => (
              <Pressable
                className={`min-h-[62px] flex-row items-center px-5 ${index < CHANNELS.length - 1 ? 'border-b border-border/70' : ''}`}
                key={candidate}
                onPress={() => void handleSelectChannel(candidate)}
              >
                <View className="h-9 w-9 items-center justify-center rounded-full bg-background/55">
                  <Ionicons
                    color={channel === candidate ? '#86efac' : '#f8fafc'}
                    name={channel === candidate ? 'radio-button-on' : 'radio-button-off'}
                    size={19}
                  />
                </View>
                <View className="ml-4 flex-1">
                  <Text className="text-[17px] font-semibold text-foreground">
                    {formatAppUpdateChannel(candidate)}
                  </Text>
                  <Text className="mt-1 text-sm font-medium text-muted-foreground">
                    {candidate === 'beta'
                      ? 'Earlier APK releases for testing'
                      : 'Recommended public releases'}
                  </Text>
                </View>
              </Pressable>
            ))}
          </View>

          {release ? (
            <View className="mt-5 overflow-hidden rounded-[28px] bg-muted p-5" style={styles.group}>
              <Text className="text-lg font-bold text-foreground">
                {release.versionName} ({release.versionCode})
              </Text>
              <Text className="mt-2 text-sm font-medium leading-5 text-muted-foreground">
                {release.releaseNotes || 'No release notes.'}
              </Text>
            </View>
          ) : null}

          <View className="mt-5 gap-3">
            <ActionButton
              disabled={!isSupported || isChecking || isInstalling}
              icon="refresh"
              label={isChecking ? 'Checking...' : 'Check for Update'}
              onPress={handleCheck}
            />
            {release ? (
              <ActionButton
                disabled={isInstalling}
                icon="download"
                label={isInstalling ? 'Opening Installer...' : 'Download and Install'}
                onPress={handleInstall}
              />
            ) : null}
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

const styles = StyleSheet.create({
  group: {
    borderCurve: 'continuous',
  },
});
