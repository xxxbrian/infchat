import '../../global.css';

import { registerWithUsername, signInWithUsername, signOut } from '@infchat/pocketbase';
import { StatusBar } from 'expo-status-bar';
import { NativeTabs } from 'expo-router/unstable-native-tabs';
import { useEffect, useState } from 'react';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { LoginScreen } from '../screens/LoginScreen';
import { RegisterScreen } from '../screens/RegisterScreen';
import { AuthContext, type AuthRecord, type AuthRoute } from '../lib/auth-context';
import { pb } from '../lib/pocketbase';

export default function RootLayout() {
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
        <AuthContext.Provider
          value={{
            authRecord,
            logout: () => {
              signOut(pb);
              setRoute('login');
            },
          }}
        >
          <AppTabs />
        </AuthContext.Provider>
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

function AppTabs() {
  return (
    <NativeTabs
      backgroundColor="#080b12"
      disableTransparentOnScrollEdge
      iconColor={{ default: '#64748b', selected: '#f8fafc' }}
      labelStyle={{
        default: { color: '#64748b', fontWeight: '600' },
        selected: { color: '#f8fafc', fontWeight: '700' },
      }}
      tintColor="#f8fafc"
    >
      <NativeTabs.Trigger name="index" contentStyle={{ backgroundColor: '#080b12' }}>
        <NativeTabs.Trigger.Label>Chat</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon sf={{ default: 'message', selected: 'message.fill' }} md="chat" />
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="friends" contentStyle={{ backgroundColor: '#080b12' }}>
        <NativeTabs.Trigger.Label>Friends</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon
          sf={{ default: 'person.2', selected: 'person.2.fill' }}
          md="group"
        />
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="settings" contentStyle={{ backgroundColor: '#080b12' }}>
        <NativeTabs.Trigger.Label>Settings</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon
          sf={{ default: 'gearshape', selected: 'gearshape.fill' }}
          md="settings"
        />
      </NativeTabs.Trigger>
    </NativeTabs>
  );
}
