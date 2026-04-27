import './global.css';

import { registerWithUsername, signInWithUsername, signOut } from '@infchat/pocketbase';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useState } from 'react';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { HomeScreen } from './src/screens/HomeScreen';
import { LoginScreen } from './src/screens/LoginScreen';
import { RegisterScreen } from './src/screens/RegisterScreen';
import { pb } from './src/lib/pocketbase';

export type AuthRecord = {
  id: string;
  username?: string;
};

export type AuthRoute = 'login' | 'register';

export default function App() {
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
    <SafeAreaProvider>
      {authRecord ? (
        <HomeScreen
          authRecord={authRecord}
          onLogout={() => {
            signOut(pb);
            setRoute('login');
          }}
        />
      ) : route === 'login' ? (
        <LoginScreen
          onCreateAccount={() => setRoute('register')}
          onSubmit={(username, password) => signInWithUsername(pb, { username, password })}
        />
      ) : (
        <RegisterScreen
          onSignIn={() => setRoute('login')}
          onSubmit={async (username, password) => {
            await registerWithUsername(pb, { username, password });
            await signInWithUsername(pb, { username, password });
          }}
        />
      )}
      <StatusBar style="light" />
    </SafeAreaProvider>
  );
}
