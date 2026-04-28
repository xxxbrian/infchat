import { Pressable, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

export default function FriendsTab() {
  const insets = useSafeAreaInsets();

  return (
    <View className="flex-1 bg-background px-5" style={{ paddingTop: insets.top + 16 }}>
      <Text className="text-4xl font-bold tracking-[-1px] text-foreground">Friends</Text>
      <View className="mt-8 rounded-[28px] bg-muted p-5">
        <Text className="text-lg font-semibold text-foreground">Find people</Text>
        <Text className="mt-2 text-base text-muted-foreground">Search by username.</Text>
        <Pressable className="mt-5 h-12 items-center justify-center rounded-full bg-foreground">
          <Text className="font-semibold text-background">Add friend</Text>
        </Pressable>
      </View>
    </View>
  );
}
