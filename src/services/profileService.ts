import { useAuth } from '@/contexts/AuthContext';
import { Profile } from '@shared/types';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiJson } from './api';

export function useProfile() {
  const { user } = useAuth();

  return useQuery<Profile | null>({
    queryKey: ['profile', user?.id],
    queryFn: async () => {
      if (!user) return null;
      // Map the AuthUser to a Profile shape for backward compatibility
      return {
        id: user.id,
        user_id: user.id,
        email: user.email,
        full_name: user.full_name,
        avatar_path: null,
        updated_at: new Date().toISOString(),
        created_at: new Date().toISOString(),
        notifications_enabled: true,
      } as Profile;
    },
    enabled: !!user?.id,
  });
}

export function useAvatarUrl(avatarPath: string | null | undefined) {
  const { user } = useAuth();

  return useQuery({
    queryKey: ['avatar-url', avatarPath],
    queryFn: async () => {
      // Use the avatar_url directly from the user object
      return user?.avatar_url || null;
    },
    enabled: !!avatarPath,
    staleTime: 1000 * 60 * 60 * 24,
    gcTime: 1000 * 60 * 60 * 24 * 7,
  });
}

export function useUpdateProfile() {
  const { user } = useAuth();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (profile: Partial<Profile>) => {
      // For now, just update locally. A full profile update endpoint can be added later.
      return {
        id: user?.id,
        user_id: user?.id,
        email: user?.email,
        full_name: profile.full_name ?? user?.full_name,
        avatar_path: profile.avatar_path ?? null,
        updated_at: new Date().toISOString(),
        created_at: new Date().toISOString(),
        notifications_enabled: profile.notifications_enabled ?? true,
      } as Profile;
    },
    onSuccess: (data) => {
      if (data) {
        queryClient.setQueryData(['profile', user?.id], data);
      }
    },
  });
}

export function useUploadAvatar() {
  const { user } = useAuth();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (file: File) => {
      if (!user) throw new Error('User not authenticated');

      // Validate file type
      const validTypes = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp'];
      if (!validTypes.includes(file.type)) {
        throw new Error(
          'Invalid file type. Please upload a JPEG, PNG, or WebP image.',
        );
      }

      // Validate file size (max 5MB)
      if (file.size > 5 * 1024 * 1024) {
        throw new Error(
          'File too large. Please upload an image smaller than 5MB.',
        );
      }

      // Avatar upload not yet implemented in API migration
      throw new Error('Avatar upload is not yet supported');
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['profile', user?.id] });
    },
  });
}
