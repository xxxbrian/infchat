import '../../global.css';

import { registerWithUsername, signInWithUsername, signOut } from '@infchat/pocketbase';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StatusBar } from 'expo-status-bar';
import { Stack } from 'expo-router';
import { useEffect, useState } from 'react';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { LoginScreen } from '../screens/LoginScreen';
import { RegisterScreen } from '../screens/RegisterScreen';
import { AuthContext, type AuthRecord, type AuthRoute } from '../lib/auth-context';
import { pb } from '../lib/pocketbase';

export default function RootLayout() {
  const [queryClient] = useState(() => new QueryClient());
  const [route, setRoute] = useState<AuthRoute>('login');
  const [authRecord, setAuthRecord] = useState<AuthRecord | null>(
    pb.authStore.record as AuthRecord | null,
  );

  useEffect(() => {
    return pb.authStore.onChange((_token, record) => {
      setAuthRecord(record as AuthRecord | null);
    }, true);
  }, []);

  return (
    <QueryClientProvider client={queryClient}>
      <SafeAreaProvider>
        {authRecord ? (
          <AuthContext.Provider
            value={{
              authRecord,
              logout: () => {
                signOut(pb);
                queryClient.clear();
                setRoute('login');
              },
            }}
          >
            <Stack
              screenOptions={{
                contentStyle: { backgroundColor: '#080b12' },
                headerShown: false,
              }}
            >
              <Stack.Screen name="(tabs)" />
              <Stack.Screen name="chat/[id]" />
            </Stack>
          </AuthContext.Provider>
        ) : route === 'login' ? (
          <LoginScreen
            onCreateAccount={() => setRoute('register')}
            onSubmit={(username, password) => signInWithUsername(pb, { username, password })}
          />
        ) : (
          <RegisterScreen
            onSignIn={() => setRoute('login')}
            onSubmit={(username, password) => registerWithUsername(pb, { username, password })}
          />
        )}
        <StatusBar style="light" />
      </SafeAreaProvider>
    </QueryClientProvider>
  );
}
