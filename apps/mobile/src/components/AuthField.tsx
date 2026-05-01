import { forwardRef, type ComponentProps } from 'react';
import { Text, TextInput, View } from 'react-native';

type AuthFieldProps = ComponentProps<typeof TextInput> & {
  label: string;
};

export const AuthField = forwardRef<TextInput, AuthFieldProps>(function AuthField(
  { label, ...inputProps },
  ref,
) {
  return (
    <View className="gap-2">
      <Text className="px-1 text-sm font-medium text-muted-foreground">{label}</Text>
      <TextInput
        {...inputProps}
        ref={ref}
        className="h-14 rounded-2xl bg-muted px-4 text-[17px] text-foreground"
        placeholderTextColor="#5f6b7c"
        selectionColor="#f8fafc"
      />
    </View>
  );
});
