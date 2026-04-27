import { Pressable, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import type { AuthRecord } from '../../App';

type HomeScreenProps = {
  authRecord: AuthRecord;
  onLogout: () => void;
};

export function HomeScreen({ authRecord, onLogout }: HomeScreenProps) {
  const insets = useSafeAreaInsets();

  return (
    <View
      className="flex-1 bg-background"
      style={{
        paddingTop: insets.top,
        paddingBottom: Math.max(insets.bottom, 12),
      }}
    >
      <View className="flex-1 px-5 pt-4">
        <View className="flex-row items-center justify-between">
          <View>
            <Text className="text-3xl font-bold tracking-[-0.8px] text-foreground">Chats</Text>
            <Text className="mt-1 text-base font-medium text-muted-foreground">
              @{authRecord.username || 'user'}
            </Text>
          </View>
          <Pressable
            className="h-11 items-center justify-center rounded-full bg-muted px-5"
            onPress={onLogout}
          >
            <Text className="font-semibold text-foreground">Log out</Text>
          </Pressable>
        </View>

        <View className="flex-1 items-center justify-center pb-20">
          <View className="h-20 w-20 items-center justify-center rounded-[28px] bg-muted">
            <Text className="text-3xl font-bold text-foreground">∞</Text>
          </View>
          <Text className="mt-6 text-xl font-semibold text-foreground">No chats yet</Text>
        </View>
      </View>
    </View>
  );
}
