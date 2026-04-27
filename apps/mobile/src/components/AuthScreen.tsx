import type { ReactNode } from 'react';
import { useEffect, useRef } from 'react';
import { Animated, Easing, KeyboardAvoidingView, Platform, SafeAreaView, View } from 'react-native';

type AuthScreenProps = {
  children: ReactNode;
};

export function AuthScreen({ children }: AuthScreenProps) {
  const opacity = useRef(new Animated.Value(0)).current;
  const translateY = useRef(new Animated.Value(16)).current;

  useEffect(() => {
    Animated.parallel([
      Animated.timing(opacity, {
        toValue: 1,
        duration: 360,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }),
      Animated.timing(translateY, {
        toValue: 0,
        duration: 360,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }),
    ]).start();
  }, [opacity, translateY]);

  return (
    <SafeAreaView className="flex-1 bg-background">
      <KeyboardAvoidingView
        className="flex-1"
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <View className="flex-1 justify-end px-5 pb-5 pt-4">
          <Animated.View style={{ opacity, transform: [{ translateY }] }}>{children}</Animated.View>
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}
