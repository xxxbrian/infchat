import { Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

export default function ChatTab() {
  const insets = useSafeAreaInsets();

  return (
    <View className="flex-1 bg-background px-5" style={{ paddingTop: insets.top + 16 }}>
      <Text className="text-4xl font-bold tracking-[-1px] text-foreground">Chat</Text>
      <View className="flex-1 items-center justify-center pb-24">
        <View className="h-20 w-20 items-center justify-center rounded-[28px] bg-muted">
          <Text className="text-3xl font-bold text-foreground">∞</Text>
        </View>
        <Text className="mt-6 text-xl font-semibold text-foreground">No chats yet</Text>
      </View>
    </View>
  );
}
