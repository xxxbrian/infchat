import './global.css';

import { isValidUsername, normalizeUsername } from '@infchat/shared';
import { registerWithUsername, signInWithUsername, signOut } from '@infchat/pocketbase';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Animated,
  Easing,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  Text,
  TextInput,
  View,
} from 'react-native';

import { pb } from './src/lib/pocketbase';

type AuthMode = 'register' | 'login';
type AuthRecord = {
  id: string;
  username?: string;
};

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

export default function App() {
  const [mode, setMode] = useState<AuthMode>('register');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [authRecord, setAuthRecord] = useState<AuthRecord | null>(
    pb.authStore.record as AuthRecord | null,
  );
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const introOpacity = useRef(new Animated.Value(0)).current;
  const introTranslateY = useRef(new Animated.Value(18)).current;

  useEffect(() => {
    Animated.parallel([
      Animated.timing(introOpacity, {
        toValue: 1,
        duration: 480,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }),
      Animated.timing(introTranslateY, {
        toValue: 0,
        duration: 480,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }),
    ]).start();
  }, [introOpacity, introTranslateY]);

  useEffect(() => {
    return pb.authStore.onChange((_token, record) => {
      setAuthRecord(record as AuthRecord | null);
    }, true);
  }, []);

  const submit = async () => {
    const normalizedUsername = normalizeUsername(username);
    setError(null);

    if (!isValidUsername(normalizedUsername)) {
      setError('Username must be 3-32 characters: lowercase letters, numbers, or underscore.');
      return;
    }

    if (password.length < 8) {
      setError('Password must be at least 8 characters.');
      return;
    }

    setIsSubmitting(true);
    try {
      if (mode === 'register') {
        await registerWithUsername(pb, { username: normalizedUsername, password });
      } else {
        await signInWithUsername(pb, { username: normalizedUsername, password });
      }
      setPassword('');
    } catch (err) {
      setError(getAuthErrorMessage(err, mode));
    } finally {
      setIsSubmitting(false);
    }
  };

  const logout = () => {
    signOut(pb);
    setPassword('');
    setError(null);
  };

  return (
    <KeyboardAvoidingView
      className="flex-1 bg-background"
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <View className="flex-1 justify-center px-6 py-10">
        <Animated.View
          className="gap-8"
          style={{ opacity: introOpacity, transform: [{ translateY: introTranslateY }] }}
        >
          <View className="gap-3">
            <View className="h-14 w-14 items-center justify-center rounded-3xl bg-primary">
              <Text className="text-2xl font-black text-primary-foreground">∞</Text>
            </View>
            <View>
              <Text className="text-4xl font-semibold tracking-tight text-foreground">InfChat</Text>
              <Text className="mt-2 text-base leading-6 text-muted-foreground">
                Register with a username and password. More identity methods can be linked later.
              </Text>
            </View>
          </View>

          {authRecord ? (
            <SignedInPanel authRecord={authRecord} onLogout={logout} />
          ) : (
            <View className="rounded-[28px] border border-border bg-muted/70 p-5">
              <ModeSwitch mode={mode} onChange={setMode} />

              <View className="mt-6 gap-4">
                <AuthInput
                  label="Username"
                  value={username}
                  onChangeText={setUsername}
                  placeholder="brian"
                  autoCapitalize="none"
                  autoCorrect={false}
                />
                <AuthInput
                  label="Password"
                  value={password}
                  onChangeText={setPassword}
                  placeholder="At least 8 characters"
                  secureTextEntry
                />
              </View>

              {error ? <Text className="mt-4 text-sm leading-5 text-danger">{error}</Text> : null}

              <AuthButton
                label={mode === 'register' ? 'Create account' : 'Sign in'}
                isLoading={isSubmitting}
                onPress={submit}
              />
            </View>
          )}
        </Animated.View>
      </View>
      <StatusBar style="auto" />
    </KeyboardAvoidingView>
  );
}

function ModeSwitch(props: { mode: AuthMode; onChange: (mode: AuthMode) => void }) {
  return (
    <View className="flex-row rounded-2xl bg-background/80 p-1">
      <ModeButton
        label="Register"
        isActive={props.mode === 'register'}
        onPress={() => props.onChange('register')}
      />
      <ModeButton
        label="Login"
        isActive={props.mode === 'login'}
        onPress={() => props.onChange('login')}
      />
    </View>
  );
}

function ModeButton(props: { label: string; isActive: boolean; onPress: () => void }) {
  return (
    <Pressable
      className={`flex-1 rounded-xl px-4 py-3 ${props.isActive ? 'bg-foreground' : 'bg-transparent'}`}
      onPress={props.onPress}
    >
      <Text
        className={`text-center text-sm font-semibold ${
          props.isActive ? 'text-background' : 'text-muted-foreground'
        }`}
      >
        {props.label}
      </Text>
    </Pressable>
  );
}

function AuthInput(props: React.ComponentProps<typeof TextInput> & { label: string }) {
  const { label, ...inputProps } = props;

  return (
    <View className="gap-2">
      <Text className="text-sm font-medium text-muted-foreground">{label}</Text>
      <TextInput
        {...inputProps}
        className="rounded-2xl border border-border bg-background px-4 py-4 text-base text-foreground focus:border-primary"
        placeholderTextColor="#64748b"
        selectionColor="#60a5fa"
      />
    </View>
  );
}

function AuthButton(props: { label: string; isLoading: boolean; onPress: () => void }) {
  const scale = useRef(new Animated.Value(1)).current;

  const animateScale = (toValue: number) => {
    Animated.timing(scale, {
      toValue,
      duration: 160,
      easing: Easing.out(Easing.quad),
      useNativeDriver: true,
    }).start();
  };

  return (
    <AnimatedPressable
      className="mt-6 h-14 items-center justify-center rounded-2xl bg-primary active:opacity-90"
      disabled={props.isLoading}
      style={{ transform: [{ scale }] }}
      onPress={props.onPress}
      onPressIn={() => animateScale(0.97)}
      onPressOut={() => animateScale(1)}
    >
      {props.isLoading ? (
        <ActivityIndicator color="#07111f" />
      ) : (
        <Text className="text-base font-bold text-primary-foreground">{props.label}</Text>
      )}
    </AnimatedPressable>
  );
}

function SignedInPanel(props: { authRecord: AuthRecord; onLogout: () => void }) {
  return (
    <View className="rounded-[28px] border border-border bg-muted/70 p-5">
      <Text className="text-sm font-medium text-muted-foreground">Signed in as</Text>
      <Text className="mt-2 text-2xl font-semibold text-foreground">
        {props.authRecord.username || 'user'}
      </Text>
      <Text className="mt-2 text-xs text-muted-foreground">User ID: {props.authRecord.id}</Text>
      <Pressable
        className="mt-6 h-12 items-center justify-center rounded-2xl border border-border"
        onPress={props.onLogout}
      >
        <Text className="font-semibold text-foreground">Logout</Text>
      </Pressable>
    </View>
  );
}

function getAuthErrorMessage(error: unknown, mode: AuthMode): string {
  if (typeof error === 'object' && error && 'status' in error && error.status === 400) {
    return mode === 'register'
      ? 'That username is unavailable or invalid.'
      : 'Username or password is incorrect.';
  }

  return 'Unable to reach the auth server. Check that PocketBase is running.';
}
