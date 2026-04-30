import { isValidUsername, normalizeUsername } from '@infchat/shared';
import { useState } from 'react';
import { Pressable, Text, View } from 'react-native';

import { AuthButton } from '../components/AuthButton';
import { AuthField } from '../components/AuthField';
import { AuthScreen } from '../components/AuthScreen';

type LoginScreenProps = {
  onCreateAccount: () => void;
  onSubmit: (username: string, password: string) => Promise<unknown>;
};

export function LoginScreen(props: LoginScreenProps) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    const normalizedUsername = normalizeUsername(username);
    setError(null);

    if (!isValidUsername(normalizedUsername) || password.length < 8) {
      setError('Check your username and password.');
      return;
    }

    setIsSubmitting(true);
    try {
      await props.onSubmit(normalizedUsername, password);
      setPassword('');
    } catch {
      setError('Username or password is incorrect.');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <AuthScreen>
      <View className="mb-12 gap-2">
        <Text className="text-[44px] font-bold tracking-[-1.5px] text-foreground">InfChat</Text>
        <Text className="text-2xl font-semibold text-muted-foreground">Welcome back</Text>
        <Text className="text-base font-medium leading-6 text-muted-foreground">
          Sign in with your username to continue your chats.
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
          autoComplete="username"
          returnKeyType="next"
          textContentType="username"
        />
        <AuthField
          label="Password"
          value={password}
          onChangeText={setPassword}
          placeholder="password"
          secureTextEntry
          autoComplete="password"
          returnKeyType="done"
          onSubmitEditing={submit}
          textContentType="password"
        />
      </View>

      {error ? <Text className="mt-4 px-1 text-sm font-medium text-danger">{error}</Text> : null}

      <View className="mt-7 gap-5">
        <AuthButton label="Sign in" isLoading={isSubmitting} onPress={submit} />
        <Pressable
          className="items-center py-2"
          disabled={isSubmitting}
          onPress={props.onCreateAccount}
        >
          <Text className="text-base font-semibold text-foreground">Create account</Text>
        </Pressable>
      </View>
    </AuthScreen>
  );
}
