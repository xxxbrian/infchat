import './global.css';

import { StatusBar } from 'expo-status-bar';
import { Text, View } from 'react-native';

export default function App() {
  return (
    <View className="flex-1 items-center justify-center bg-background px-6">
      <Text className="text-3xl font-semibold tracking-tight text-foreground">InfChat</Text>
      <Text className="mt-3 text-center text-base text-muted-foreground">
        Mobile app skeleton with Uniwind ready.
      </Text>
      <StatusBar style="auto" />
    </View>
  );
}
