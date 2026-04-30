import Ionicons from '@expo/vector-icons/Ionicons';
import { getProfileAvatarUrl, updateProfile, type ProfileUploadFile } from '@infchat/pocketbase';
import { BIO_MAX_LENGTH, bioSchema, displayNameSchema } from '@infchat/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import * as ImagePicker from 'expo-image-picker';
import { router } from 'expo-router';
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
import { commitCurrentProfileUpdate } from '../../lib/profile-cache';
import { pb } from '../../lib/pocketbase';

export default function EditProfileScreen() {
  const { authRecord } = useAuth();
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
  const avatarUrl =
    selectedAvatar?.uri || (profile ? getProfileAvatarUrl(pb, profile, fileTokenQuery.data) : null);
  const parsedDisplayName = displayNameSchema.safeParse(displayName);
  const parsedBio = bioSchema.safeParse(bio);
  const hasChanges =
    Boolean(selectedAvatar) ||
    Boolean(
      profile &&
        (displayName.trim() !== profile.display_name || bio.trim() !== (profile.bio ?? '')),
    );
  const canSave = Boolean(
    profile &&
      parsedDisplayName.success &&
      parsedBio.success &&
      hasChanges &&
      !profileQuery.isLoading,
  );
  const uploadFile = useMemo(
    () => (selectedAvatar ? toProfileUploadFile(selectedAvatar) : undefined),
    [selectedAvatar],
  );

  useEffect(() => {
    if (profile && !didSetInitialProfile.current) {
      didSetInitialProfile.current = true;
      setDisplayName(profile.display_name || profile.username);
      setBio(profile.bio ?? '');
    }
  }, [profile]);

  const updateMutation = useMutation({
    mutationFn: () => {
      if (!profile) {
        throw new Error('Profile is not loaded');
      }

      return updateProfile(pb, profile.id, {
        avatar: uploadFile,
        bio,
        displayName,
      });
    },
    onSuccess: async (nextProfile) => {
      await commitCurrentProfileUpdate({
        authId: authRecord.id,
        pb,
        profile: nextProfile,
        queryClient,
      });
      router.back();
    },
    onError: () => {
      Alert.alert('Could not save profile', 'Check your connection and try again.');
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
      <View
        className="flex-row items-center justify-between border-b border-border/60 px-5 pb-3"
        style={{ paddingTop: insets.top + 8 }}
      >
        <Pressable className="h-10 justify-center" onPress={router.back}>
          <Text className="text-[17px] font-semibold text-muted-foreground">Cancel</Text>
        </Pressable>
        <Text className="text-lg font-bold text-foreground">Edit Profile</Text>
        <Pressable
          className="h-10 justify-center"
          disabled={!canSave || updateMutation.isPending}
          onPress={() => updateMutation.mutate()}
        >
          <Text
            className={`text-[17px] font-bold ${canSave ? 'text-primary' : 'text-muted-foreground'}`}
          >
            Done
          </Text>
        </Pressable>
      </View>

      <ScrollView
        className="flex-1"
        contentContainerStyle={{
          paddingBottom: Math.max(insets.bottom, 20) + 24,
        }}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        <View className="items-center px-5 pb-8 pt-8">
          <Pressable className="items-center" onPress={pickAvatar}>
            <View>
              <ProfileAvatar
                avatarUrl={avatarUrl}
                name={displayName || profile?.display_name}
                size={118}
                userId={profile?.user || authRecord.id}
                username={profile?.username || authRecord.username || 'user'}
              />
              <View className="absolute bottom-1 right-1 h-9 w-9 items-center justify-center rounded-full border-4 border-background bg-foreground">
                <Ionicons color="#080b12" name="camera" size={16} />
              </View>
            </View>
            <Text className="mt-4 text-[17px] font-semibold text-foreground">Set New Photo</Text>
          </Pressable>
        </View>

        <View className="px-5">
          <View className="overflow-hidden rounded-[28px] bg-muted" style={styles.group}>
            <View className="px-5 py-4">
              <Text className="text-xs font-bold uppercase tracking-[0.8px] text-muted-foreground">
                Display name
              </Text>
              <TextInput
                autoCapitalize="words"
                className="mt-2 min-w-0 py-1 text-[19px] font-semibold text-foreground"
                maxLength={48}
                onChangeText={setDisplayName}
                placeholder="Display name"
                placeholderTextColor="#64748b"
                selectionColor="#f8fafc"
                value={displayName}
              />
            </View>
            <View className="ml-5 border-b border-border/70" />
            <View className="px-5 py-4">
              <Text className="text-xs font-bold uppercase tracking-[0.8px] text-muted-foreground">
                Bio
              </Text>
              <TextInput
                className="mt-2 min-h-[74px] min-w-0 py-1 text-[17px] font-semibold leading-6 text-foreground"
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
            <View className="ml-5 border-b border-border/70" />
            <View className="px-5 py-4">
              <Text className="text-xs font-bold uppercase tracking-[0.8px] text-muted-foreground">
                Username
              </Text>
              <Text
                className="mt-2 min-w-0 text-[18px] font-semibold text-foreground"
                numberOfLines={1}
              >
                @{profile?.username || authRecord.username || 'user'}
              </Text>
            </View>
          </View>

          <Text className="mt-3 px-2 text-sm font-medium leading-5 text-muted-foreground">
            Your name and photo are visible to friends and people you message.
          </Text>

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
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
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
  group: {
    borderCurve: 'continuous',
  } as ViewStyle,
});
