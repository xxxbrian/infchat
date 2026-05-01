import Ionicons from '@expo/vector-icons/Ionicons';
import {
  getProfileAvatarUrl,
  updateProfile,
  type ProfileRecord,
  type ProfileSetupField,
  type ProfileUploadFile,
} from '@infchat/pocketbase';
import { BIO_MAX_LENGTH, bioSchema, displayNameSchema } from '@infchat/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import * as ImagePicker from 'expo-image-picker';
import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  type ViewStyle,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { ProfileAvatar } from '../../components/ProfileAvatar';
import { useAuth } from '../../lib/auth-context';
import { getCachedCurrentProfile } from '../../lib/local-cache';
import {
  getMissingProfileSetupFields,
  parseProfileSetupSkippedFields,
} from '../../lib/profile-completion';
import { commitCurrentProfileUpdate } from '../../lib/profile-cache';
import { pb } from '../../lib/pocketbase';

export default function ProfileSetupScreen() {
  const { authRecord } = useAuth();
  const { returnTo } = useLocalSearchParams<{ returnTo?: string }>();
  const insets = useSafeAreaInsets();
  const queryClient = useQueryClient();
  const didSetInitialProfile = useRef(false);
  const [displayName, setDisplayName] = useState('');
  const [bio, setBio] = useState('');
  const [selectedAvatar, setSelectedAvatar] = useState<ImagePicker.ImagePickerAsset | null>(null);

  const profileQuery = useQuery({
    queryKey: ['profile', 'current', authRecord.id],
    queryFn: () => getCachedCurrentProfile(pb),
    networkMode: 'always',
  });
  const fileTokenQuery = useQuery({
    queryKey: ['file-token', authRecord.id],
    queryFn: () => pb.files.getToken(),
    staleTime: 1000 * 60 * 5,
  });
  const profile = profileQuery.data;
  const missingFields = useMemo(
    () => (profile ? getMissingProfileSetupFields(profile) : []),
    [profile],
  );
  const asksDisplayName = missingFields.includes('displayName');
  const asksBio = missingFields.includes('bio');
  const asksAvatar = missingFields.includes('avatar');
  const avatarUrl =
    selectedAvatar?.uri ||
    (profile ? getProfileAvatarUrl(pb, profile, fileTokenQuery.data, 'medium') : null);
  const parsedDisplayName = displayNameSchema.safeParse(displayName);
  const parsedBio = bioSchema.safeParse(bio);
  const hasChanges = Boolean(
    selectedAvatar || (asksDisplayName && displayName.trim()) || (asksBio && bio.trim()),
  );
  const canSave = Boolean(
    profile &&
      hasChanges &&
      (!asksDisplayName || parsedDisplayName.success) &&
      (!asksBio || parsedBio.success),
  );
  const uploadFile = useMemo(
    () => (selectedAvatar ? toProfileUploadFile(selectedAvatar) : undefined),
    [selectedAvatar],
  );

  useEffect(() => {
    if (profile && !didSetInitialProfile.current) {
      didSetInitialProfile.current = true;
      setDisplayName(profile.display_name === profile.username ? '' : profile.display_name);
      setBio(profile.bio ?? '');
    }
  }, [profile]);

  useEffect(() => {
    if (profile && missingFields.length === 0) {
      finishSetup(returnTo);
    }
  }, [missingFields.length, profile, returnTo]);

  const updateMutation = useMutation({
    mutationFn: (mode: 'save' | 'skip') => {
      if (!profile) {
        throw new Error('Profile is not loaded');
      }

      return updateProfile(pb, profile.id, {
        avatar: mode === 'save' ? uploadFile : undefined,
        bio: mode === 'save' && asksBio && bio.trim() ? bio : undefined,
        displayName:
          mode === 'save' && asksDisplayName && displayName.trim() ? displayName : undefined,
        setupSkippedFields: getNextSkippedFields(profile, missingFields, {
          bio: mode === 'save' ? bio : '',
          displayName: mode === 'save' ? displayName : '',
          hasAvatar: mode === 'save' ? Boolean(selectedAvatar || profile.avatar) : false,
        }),
      });
    },
    onSuccess: async (nextProfile) => {
      await commitCurrentProfileUpdate({
        authId: authRecord.id,
        pb,
        profile: nextProfile,
        queryClient,
      });
      finishSetup(returnTo);
    },
    onError: () => {
      Alert.alert('Could not update profile', 'Check your connection and try again.');
    },
  });

  const pickAvatar = async () => {
    const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!permission.granted) {
      Alert.alert('Photos access needed', 'Allow photos access to choose a profile image.');
      return;
    }

    const result = await ImagePicker.launchImageLibraryAsync({
      allowsEditing: true,
      aspect: [1, 1],
      mediaTypes: ['images'],
      quality: 0.9,
    });

    if (!result.canceled) {
      setSelectedAvatar(result.assets[0] ?? null);
    }
  };

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      className="flex-1 bg-background"
    >
      <ScrollView
        className="flex-1"
        contentContainerStyle={{
          paddingBottom: Math.max(insets.bottom, 20) + 24,
          paddingTop: insets.top + 18,
        }}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        <View className="px-5">
          <View className="mb-8 flex-row items-start justify-between gap-4">
            <View className="flex-1">
              <Text className="text-[36px] font-bold tracking-[-1.4px] text-foreground">
                Make your profile yours
              </Text>
              <Text className="mt-3 text-[17px] font-semibold leading-6 text-muted-foreground">
                Add the details friends see in chats and calls.
              </Text>
            </View>
            <Pressable
              className="h-10 justify-center rounded-full bg-muted px-4"
              disabled={updateMutation.isPending || !profile}
              onPress={() => updateMutation.mutate('skip')}
            >
              <Text className="text-sm font-bold text-muted-foreground">Skip</Text>
            </Pressable>
          </View>

          {!profile ? (
            <Text className="text-base font-semibold text-muted-foreground">
              Loading profile...
            </Text>
          ) : (
            <>
              {asksAvatar ? (
                <View
                  className="mb-5 items-center rounded-[30px] bg-muted px-5 py-7"
                  style={styles.card}
                >
                  <Pressable className="items-center" onPress={pickAvatar}>
                    <View>
                      <ProfileAvatar
                        avatarUrl={avatarUrl}
                        name={displayName || profile.display_name}
                        size={112}
                        userId={profile.user || authRecord.id}
                        username={profile.username || authRecord.username || 'user'}
                      />
                      <View className="absolute bottom-1 right-1 h-9 w-9 items-center justify-center rounded-full border-4 border-muted bg-foreground">
                        <Ionicons color="#080b12" name="camera" size={16} />
                      </View>
                    </View>
                    <Text className="mt-4 text-[17px] font-bold text-foreground">
                      Choose a profile photo
                    </Text>
                  </Pressable>
                </View>
              ) : null}

              <View className="overflow-hidden rounded-[28px] bg-muted" style={styles.card}>
                {asksDisplayName ? (
                  <View className="px-5 py-4">
                    <Text className="text-xs font-bold uppercase tracking-[0.8px] text-muted-foreground">
                      Display name
                    </Text>
                    <TextInput
                      autoCapitalize="words"
                      className="mt-2 min-w-0 py-1 text-[19px] font-semibold text-foreground"
                      maxLength={48}
                      onChangeText={setDisplayName}
                      placeholder={profile.username || 'Display name'}
                      placeholderTextColor="#64748b"
                      selectionColor="#f8fafc"
                      value={displayName}
                    />
                  </View>
                ) : null}
                {asksDisplayName && asksBio ? (
                  <View className="ml-5 border-b border-border/70" />
                ) : null}
                {asksBio ? (
                  <View className="px-5 py-4">
                    <Text className="text-xs font-bold uppercase tracking-[0.8px] text-muted-foreground">
                      Bio
                    </Text>
                    <TextInput
                      className="mt-2 min-h-[92px] min-w-0 py-1 text-[17px] font-semibold leading-6 text-foreground"
                      maxLength={BIO_MAX_LENGTH}
                      multiline
                      onChangeText={setBio}
                      placeholder="A short line about you"
                      placeholderTextColor="#64748b"
                      selectionColor="#f8fafc"
                      textAlignVertical="top"
                      value={bio}
                    />
                    <Text className="mt-1 text-right text-xs font-semibold text-muted-foreground">
                      {bio.trim().length}/{BIO_MAX_LENGTH}
                    </Text>
                  </View>
                ) : null}
              </View>

              {!parsedDisplayName.success && displayName.length > 0 ? (
                <Text className="mt-3 px-2 text-sm font-medium text-red-300">
                  {parsedDisplayName.error.issues[0]?.message}
                </Text>
              ) : null}

              {!parsedBio.success ? (
                <Text className="mt-3 px-2 text-sm font-medium text-red-300">
                  {parsedBio.error.issues[0]?.message}
                </Text>
              ) : null}

              <View className="mt-7 gap-4">
                <Pressable
                  className={`h-14 items-center justify-center rounded-[22px] ${canSave ? 'bg-foreground' : 'bg-muted'}`}
                  disabled={!canSave || updateMutation.isPending}
                  onPress={() => updateMutation.mutate('save')}
                >
                  <Text
                    className={`text-base font-bold ${canSave ? 'text-background' : 'text-muted-foreground'}`}
                  >
                    Save and continue
                  </Text>
                </Pressable>
                <Pressable
                  className="h-12 items-center justify-center"
                  disabled={updateMutation.isPending}
                  onPress={() => updateMutation.mutate('skip')}
                >
                  <Text className="text-base font-bold text-muted-foreground">Skip for now</Text>
                </Pressable>
              </View>
            </>
          )}
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

function getNextSkippedFields(
  profile: ProfileRecord,
  missingFields: ProfileSetupField[],
  values: { bio: string; displayName: string; hasAvatar: boolean },
): ProfileSetupField[] {
  const skipped = parseProfileSetupSkippedFields(profile);

  for (const field of missingFields) {
    if (field === 'displayName') {
      const name = values.displayName.trim();
      if (!name || name.toLowerCase() === profile.username.trim().toLowerCase()) {
        skipped.add(field);
      }
    }

    if (field === 'bio' && !values.bio.trim()) {
      skipped.add(field);
    }

    if (field === 'avatar' && !values.hasAvatar) {
      skipped.add(field);
    }
  }

  return [...skipped];
}

function finishSetup(returnTo?: string) {
  router.replace(returnTo && returnTo !== '/profile/setup' ? (returnTo as never) : '/');
}

function toProfileUploadFile(asset: ImagePicker.ImagePickerAsset): ProfileUploadFile {
  const type = asset.mimeType || 'image/jpeg';
  const extension = type.split('/')[1] || 'jpg';

  return {
    name: asset.fileName || `avatar.${extension}`,
    type,
    uri: asset.uri,
  };
}

const styles = StyleSheet.create({
  card: {
    borderCurve: 'continuous',
  } as ViewStyle,
});
