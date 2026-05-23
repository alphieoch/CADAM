import { useAuth } from '@/contexts/AuthContext';
import { useQuery, type UseQueryResult } from '@tanstack/react-query';

interface UsePreviewOptions {
  id: string | undefined;
  conversationId: string;
  generateBlob: () => Promise<Blob>;
  enabled?: boolean;
  userId?: string;
}

/**
 * "Get or create" cached preview image.
 * Checks Azure Blob Storage via backend API at `images/{userId}/{convId}/preview-{id}`
 * and returns a data URL. Generates and uploads if not cached.
 */
export function usePreview({
  id,
  conversationId,
  generateBlob,
  enabled = true,
  userId: userIdProp,
}: UsePreviewOptions): UseQueryResult<string> {
  const { user } = useAuth();
  const userId = userIdProp ?? user?.id;

  return useQuery({
    queryKey: ['preview', conversationId, id],
    queryFn: async () => {
      if (!userId || !id) throw new Error('usePreview: missing userId or id');
      const storagePath = `${userId}/${conversationId}/preview-${id}`;

      // Try to get a signed URL for the existing preview
      try {
        const signedRes = await fetch(
          `${import.meta.env.BASE_URL}/api/storage?container=images&path=${encodeURIComponent(storagePath)}`,
          { credentials: 'include' },
        );
        if (signedRes.ok) {
          const { url } = await signedRes.json();
          const downloadRes = await fetch(url);
          if (downloadRes.ok) {
            const blob = await downloadRes.blob();
            return blobToDataUrl(blob);
          }
        }
      } catch {
        // Blob doesn't exist yet, continue to generate
      }

      const blob = await generateBlob();

      // Upload to Azure via backend API
      try {
        const formData = new FormData();
        formData.append('container', 'images');
        formData.append('path', storagePath);
        formData.append('file', blob, 'preview.png');

        const uploadRes = await fetch(`${import.meta.env.BASE_URL}/api/storage`, {
          method: 'POST',
          credentials: 'include',
          body: formData,
        });

        if (!uploadRes.ok) {
          console.warn('[usePreview] upload failed, continuing with local blob');
        }
      } catch (uploadError) {
        console.warn('[usePreview] upload failed, continuing:', uploadError);
      }

      return blobToDataUrl(blob);
    },
    enabled: enabled && !!userId && !!id,
    staleTime: Infinity,
    retry: false,
  });
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}
