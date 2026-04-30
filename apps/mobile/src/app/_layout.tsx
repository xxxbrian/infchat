import '../../global.css';
import '../lib/event-source';
import '../lib/livekit';

import Ionicons from '@expo/vector-icons/Ionicons';
import NetInfo from '@react-native-community/netinfo';
import {
  endCall,
  registerWithUsername,
  signInWithUsername,
  signOut,
  type CallRoomRecord,
} from '@infchat/pocketbase';
import { DarkTheme, ThemeProvider } from '@react-navigation/native';
import {
  focusManager,
  onlineManager,
  QueryClient,
  QueryClientProvider,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { StatusBar } from 'expo-status-bar';
import { router, Stack, usePathname } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { Animated, AppState, Pressable, Text, Vibration, View } from 'react-native';
import { SafeAreaProvider, useSafeAreaInsets } from 'react-native-safe-area-context';

import { LoginScreen } from '../screens/LoginScreen';
import { RegisterScreen } from '../screens/RegisterScreen';
import { AuthContext, type AuthRecord, type AuthRoute } from '../lib/auth-context';
import { useRingingSecondsLeft } from '../lib/call-countdown';
import { CallSessionProvider, useCallSession } from '../lib/call-context';
import { refreshCachedCurrentProfile } from '../lib/local-cache';
import { pb } from '../lib/pocketbase';
import { getMissingProfileSetupFields } from '../lib/profile-completion';
import {
  endIOSSystemCallForCallRoom,
  registerIOSPushDevice,
  setCurrentNotificationRoute,
  setupIOSSystemCalls,
  setupIOSPushRegistrationRecovery,
  setupNotificationPresentation,
  setupNotificationResponses,
} from '../lib/push-notifications';

setupNotificationPresentation();

const navigationTheme = {
  ...DarkTheme,
  colors: {
    ...DarkTheme.colors,
    background: '#080b12',
    border: '#1f2937',
    card: '#080b12',
    notification: '#fb7185',
    primary: '#60a5fa',
    text: '#f8fafc',
  },
};

export default function RootLayout() {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            refetchOnMount: true,
            refetchOnReconnect: true,
            refetchOnWindowFocus: true,
            retry: 2,
          },
        },
      }),
  );
  const [route, setRoute] = useState<AuthRoute>('login');
  const [authRecord, setAuthRecord] = useState<AuthRecord | null>(
    pb.authStore.record as AuthRecord | null,
  );

  useEffect(() => {
    return pb.authStore.onChange((_token, record) => {
      setAuthRecord(record as AuthRecord | null);
    }, true);
  }, []);

  useEffect(() => {
    return onlineManager.setEventListener((setOnline) =>
      NetInfo.addEventListener((state) => {
        setOnline(Boolean(state.isConnected && state.isInternetReachable !== false));
      }),
    );
  }, []);

  useEffect(() => {
    return focusManager.setEventListener((setFocused) => {
      const subscription = AppState.addEventListener('change', (status) => {
        setFocused(status === 'active');
      });

      return () => subscription.remove();
    });
  }, []);

  return (
    <QueryClientProvider client={queryClient}>
      <ThemeProvider value={navigationTheme}>
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
              <CallSessionProvider>
                <View className="flex-1 bg-background">
                  <Stack
                    screenOptions={{
                      contentStyle: { backgroundColor: '#080b12' },
                      headerShown: false,
                    }}
                  >
                    <Stack.Screen name="(tabs)" />
                    <Stack.Screen name="call/[id]" />
                    <Stack.Screen name="chat/[id]" />
                    <Stack.Screen name="debug" />
                    <Stack.Screen name="profile/[userId]" />
                    <Stack.Screen name="profile/edit" />
                    <Stack.Screen name="profile/setup" />
                    <Stack.Screen name="settings/notifications" />
                    <Stack.Screen name="settings/privacy" />
                  </Stack>
                  <ProfileSetupGate authRecord={authRecord} />
                  <NotificationRouteTracker />
                  <PushRegistration authRecord={authRecord} />
                  <IncomingCallListener authRecord={authRecord} />
                </View>
              </CallSessionProvider>
            </AuthContext.Provider>
          ) : (
            <View className="flex-1 bg-background">
              {route === 'login' ? (
                <LoginScreen
                  onCreateAccount={() => setRoute('register')}
                  onSubmit={(username, password) => signInWithUsername(pb, { username, password })}
                />
              ) : (
                <RegisterScreen
                  onSignIn={() => setRoute('login')}
                  onSubmit={(username, password) =>
                    registerWithUsername(pb, { username, password })
                  }
                />
              )}
            </View>
          )}
          <StatusBar style="light" />
        </SafeAreaProvider>
      </ThemeProvider>
    </QueryClientProvider>
  );
}

function ProfileSetupGate({ authRecord }: { authRecord: AuthRecord }) {
  const pathname = usePathname();
  const queryClient = useQueryClient();
  const profileQuery = useQuery({
    queryKey: ['profile', 'current', authRecord.id],
    queryFn: () => refreshCachedCurrentProfile(pb),
    networkMode: 'always',
    retry: 1,
  });

  useEffect(() => {
    const profile = profileQuery.data;
    if (!profile || pathname === '/profile/setup' || pathname.startsWith('/call/')) {
      return;
    }

    if (getMissingProfileSetupFields(profile).length > 0) {
      router.replace({
        pathname: '/profile/setup',
        params: { returnTo: pathname },
      } as never);
    }
  }, [pathname, profileQuery.data]);

  useEffect(() => {
    let isMounted = true;
    let unsubscribe: (() => void) | undefined;

    void pb
      .collection('profiles')
      .subscribe('*', (event) => {
        const record = event.record as { user?: string } | undefined;
        if (record?.user === authRecord.id) {
          void queryClient.invalidateQueries({
            queryKey: ['profile', 'current', authRecord.id],
          });
        }
      })
      .then((cleanup) => {
        if (isMounted) {
          unsubscribe = cleanup;
        } else {
          cleanup();
        }
      });

    return () => {
      isMounted = false;
      unsubscribe?.();
    };
  }, [authRecord.id, queryClient]);

  return null;
}

function PushRegistration({ authRecord }: { authRecord: AuthRecord }) {
  useEffect(() => {
    void registerIOSPushDevice();
    const cleanupNotificationResponses = setupNotificationResponses();
    const cleanupPushRegistrationRecovery = setupIOSPushRegistrationRecovery();
    const cleanupSystemCalls = setupIOSSystemCalls();

    return () => {
      cleanupNotificationResponses();
      cleanupPushRegistrationRecovery();
      cleanupSystemCalls();
    };
  }, [authRecord.id]);

  return null;
}

function NotificationRouteTracker() {
  const pathname = usePathname();

  useEffect(() => {
    setCurrentNotificationRoute(pathname);
  }, [pathname]);

  return null;
}

function IncomingCallListener({ authRecord }: { authRecord: AuthRecord }) {
  const insets = useSafeAreaInsets();
  const pathname = usePathname();
  const { activeSession, isJoining } = useCallSession();
  const slide = useRef(new Animated.Value(0)).current;
  const seenCallIds = useRef(new Set<string>());
  const [incomingCall, setIncomingCall] = useState<CallRoomRecord | null>(null);
  const ringingSecondsLeft = useRingingSecondsLeft(incomingCall);
  const activeCallRoomId = activeSession?.callRoom.id;
  const isOnCallRoute = pathname.startsWith('/call/');

  const showIncomingCall = (callRoom: CallRoomRecord | null | undefined) => {
    if (
      !callRoom ||
      callRoom.status !== 'ringing' ||
      callRoom.created_by === authRecord.id ||
      activeCallRoomId === callRoom.id ||
      isOnCallRoute ||
      isJoining ||
      pathname === `/chat/${callRoom.conversation}` ||
      seenCallIds.current.has(callRoom.id)
    ) {
      return;
    }

    seenCallIds.current.add(callRoom.id);
    setIncomingCall(callRoom);
  };

  useEffect(() => {
    if (!incomingCall) {
      return;
    }

    if (activeCallRoomId === incomingCall.id || isOnCallRoute || isJoining) {
      setIncomingCall(null);
    }
  }, [activeCallRoomId, incomingCall, isJoining, isOnCallRoute]);

  useEffect(() => {
    let isMounted = true;

    const loadPendingIncomingCall = async () => {
      try {
        const callRooms = await pb.collection('call_rooms').getFullList<CallRoomRecord>({
          filter: pb.filter('status={:status} && created_by!={:userId}', {
            status: 'ringing',
            userId: authRecord.id,
          }),
          sort: '-created',
        });

        if (isMounted) {
          showIncomingCall(callRooms[0]);
        }
      } catch {
        // Realtime remains the primary path; foreground refetch will retry later.
      }
    };

    void loadPendingIncomingCall();

    const subscription = AppState.addEventListener('change', (status) => {
      if (status === 'active') {
        void loadPendingIncomingCall();
      }
    });

    return () => {
      isMounted = false;
      subscription.remove();
    };
  }, [authRecord.id, activeCallRoomId, isJoining, isOnCallRoute, pathname]);

  useEffect(() => {
    let isMounted = true;
    let unsubscribe: (() => void) | undefined;

    pb.collection('call_rooms')
      .subscribe('*', (event) => {
        const callRoom = event.record as unknown as CallRoomRecord | undefined;
        if (!isMounted || !callRoom) {
          return;
        }

        if (callRoom.status !== 'ringing') {
          setIncomingCall((currentCall) => (currentCall?.id === callRoom.id ? null : currentCall));
          if (activeCallRoomId !== callRoom.id) {
            endIOSSystemCallForCallRoom(
              callRoom.id,
              callRoom.status === 'active'
                ? 'answered-elsewhere'
                : systemCallEndReasonForStatus(callRoom.status),
            );
          }
          return;
        }

        showIncomingCall(callRoom);
      })
      .then((nextUnsubscribe) => {
        if (isMounted) {
          unsubscribe = nextUnsubscribe;
        } else {
          nextUnsubscribe();
        }
      })
      .catch(() => {
        // Query refetch on reconnect covers temporary realtime connection failures.
      });

    return () => {
      isMounted = false;
      unsubscribe?.();
    };
  }, [authRecord.id, activeCallRoomId, isJoining, isOnCallRoute, pathname]);

  useEffect(() => {
    if (!incomingCall) {
      Vibration.cancel();
      return;
    }

    Vibration.vibrate([0, 700, 900], true);

    return () => Vibration.cancel();
  }, [incomingCall]);

  useEffect(() => {
    Animated.spring(slide, {
      damping: 18,
      mass: 0.8,
      stiffness: 180,
      toValue: incomingCall ? 1 : 0,
      useNativeDriver: true,
    }).start();
  }, [incomingCall, slide]);

  const handleAccept = () => {
    if (!incomingCall) {
      return;
    }

    const callRoomId = incomingCall.id;
    setIncomingCall(null);
    router.push({ pathname: '/call/[id]', params: { id: callRoomId } });
  };

  const handleDecline = () => {
    if (!incomingCall) {
      return;
    }

    const callRoomId = incomingCall.id;
    setIncomingCall(null);
    void endCall(pb, callRoomId);
  };

  const translateY = slide.interpolate({
    inputRange: [0, 1],
    outputRange: [-130, 0],
  });

  return (
    <Animated.View
      className="absolute left-4 right-4 rounded-[28px] border border-border/70 bg-background/95 p-4"
      pointerEvents={incomingCall ? 'auto' : 'none'}
      style={{
        opacity: slide,
        top: insets.top + 10,
        transform: [{ translateY }],
      }}
    >
      <View className="flex-row items-center gap-3">
        <View className="h-12 w-12 items-center justify-center rounded-full bg-foreground">
          <Ionicons
            color="#080b12"
            name={incomingCall?.kind === 'video' ? 'videocam' : 'call'}
            size={22}
          />
        </View>
        <View className="min-w-0 flex-1">
          <Text className="text-lg font-bold text-foreground">
            Incoming {incomingCall?.kind === 'video' ? 'video' : 'voice'} call
          </Text>
          <Text className="text-sm font-medium text-muted-foreground">
            {ringingSecondsLeft === null
              ? 'Join or decline'
              : `Ringing · ${ringingSecondsLeft}s left`}
          </Text>
        </View>
        <Pressable
          className="h-11 w-11 items-center justify-center rounded-full bg-red-500"
          onPress={handleDecline}
        >
          <Ionicons color="#080b12" name="close" size={22} />
        </Pressable>
        <Pressable
          className="h-11 w-11 items-center justify-center rounded-full bg-foreground"
          onPress={handleAccept}
        >
          <Ionicons color="#080b12" name="call" size={20} />
        </Pressable>
      </View>
    </Animated.View>
  );
}

function systemCallEndReasonForStatus(status: CallRoomRecord['status']) {
  switch (status) {
    case 'declined':
      return 'declined-elsewhere' as const;
    case 'missed':
      return 'missed' as const;
    default:
      return 'remote-ended' as const;
  }
}
