import { useRef } from 'react';
import { ActivityIndicator, Animated, Easing, Pressable, Text } from 'react-native';

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

type AuthButtonProps = {
  label: string;
  isLoading: boolean;
  onPress: () => void;
};

export function AuthButton(props: AuthButtonProps) {
  const scale = useRef(new Animated.Value(1)).current;

  const animateScale = (toValue: number) => {
    Animated.timing(scale, {
      toValue,
      duration: 120,
      easing: Easing.out(Easing.quad),
      useNativeDriver: true,
    }).start();
  };

  return (
    <AnimatedPressable
      className="h-14 items-center justify-center rounded-full bg-foreground active:opacity-90"
      disabled={props.isLoading}
      style={{ transform: [{ scale }] }}
      onPress={props.onPress}
      onPressIn={() => animateScale(0.96)}
      onPressOut={() => animateScale(1)}
    >
      {props.isLoading ? (
        <ActivityIndicator color="#080b12" />
      ) : (
        <Text className="text-base font-semibold text-background">{props.label}</Text>
      )}
    </AnimatedPressable>
  );
}
