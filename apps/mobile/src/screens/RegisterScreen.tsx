import { isValidUsername, normalizeUsername } from '@infchat/shared';
import { useState } from 'react';
import { Pressable, Text, View } from 'react-native';

import { AuthButton } from '../components/AuthButton';
import { AuthField } from '../components/AuthField';
import { AuthScreen } from '../components/AuthScreen';

type RegisterScreenProps = {
  onSignIn: () => void;
  onSubmit: (username: string, password: string) => Promise<unknown>;
};

export function RegisterScreen(props: RegisterScreenProps) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    const normalizedUsername = normalizeUsername(username);
    setError(null);

    if (!isValidUsername(normalizedUsername)) {
      setError('Use 3-32 letters, numbers, or underscores.');
      return;
    }

    if (password.length < 8) {
      setError('Password needs at least 8 characters.');
      return;
    }

    setIsSubmitting(true);
    try {
      await props.onSubmit(normalizedUsername, password);
      setPassword('');
    } catch {
      setError('That username is not available.');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <AuthScreen>
      <View className="mb-12 gap-2">
        <Text className="text-[44px] font-bold tracking-[-1.5px] text-foreground">InfChat</Text>
        <Text className="text-2xl font-semibold text-muted-foreground">Create your account</Text>
        <Text className="text-base font-medium leading-6 text-muted-foreground">
          Pick a username first. You can add your name, bio, and photo next.
        </Text>
      </View>

      <View className="gap-4">
        <AuthField
          label="Username"
          value={username}
          onChangeText={setUsername}
          placeholder="username"
          autoCapitalize="none"
          autoCorrect={false}
          autoComplete="username-new"
          returnKeyType="next"
          textContentType="username"
        />
        <Text className="-mt-2 px-1 text-xs font-semibold text-muted-foreground">
          3-32 lowercase letters, numbers, or underscores.
        </Text>
        <AuthField
          label="Password"
          value={password}
          onChangeText={setPassword}
          placeholder="password"
          secureTextEntry
          autoComplete="new-password"
          returnKeyType="done"
          onSubmitEditing={submit}
          textContentType="newPassword"
        />
        <Text className="-mt-2 px-1 text-xs font-semibold text-muted-foreground">
          At least 8 characters.
        </Text>
      </View>

      {error ? <Text className="mt-4 px-1 text-sm font-medium text-danger">{error}</Text> : null}

      <View className="mt-7 gap-5">
        <AuthButton label="Create account" isLoading={isSubmitting} onPress={submit} />
        <Pressable className="items-center py-2" disabled={isSubmitting} onPress={props.onSignIn}>
          <Text className="text-base font-semibold text-foreground">Sign in</Text>
        </Pressable>
      </View>
    </AuthScreen>
  );
}
