import { Pressable, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useAuth } from '../../lib/auth-context';

export default function SettingsTab() {
  const insets = useSafeAreaInsets();
  const { authRecord, logout } = useAuth();

  return (
    <View className="flex-1 bg-background px-5" style={{ paddingTop: insets.top + 16 }}>
      <Text className="text-4xl font-bold tracking-[-1px] text-foreground">Settings</Text>
      <View className="mt-8 rounded-[28px] bg-muted p-5">
        <Text className="text-sm font-medium text-muted-foreground">Signed in</Text>
        <Text className="mt-2 text-2xl font-semibold text-foreground">
          @{authRecord.username || 'user'}
        </Text>
      </View>
      <Pressable
        className="mt-5 h-14 items-center justify-center rounded-full bg-foreground"
        onPress={logout}
      >
        <Text className="text-base font-semibold text-background">Log out</Text>
      </Pressable>
    </View>
  );
}
