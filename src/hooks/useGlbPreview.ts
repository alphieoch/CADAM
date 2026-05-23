import { useQuery } from '@tanstack/react-query';

export const useGlbPreview = ({ id }: { id?: string }) => {
  const query = useQuery({
    queryKey: ['preview', id],
    enabled: !!id,
    queryFn: async () => {
      if (!id) return null;

      // Get most recent successful preview (handles multiple previews per mesh)
      const previewRes = await fetch(
        `${import.meta.env.BASE_URL}/api/meshes/${id}/previews`,
        { credentials: 'include' },
      );

      if (!previewRes.ok) {
        return null;
      }

      const preview = await previewRes.json();

      const downloadStart = Date.now();

      const storagePath = `${preview.user_id}/${preview.conversation_id}/${preview.id}.glb`;
      const signedRes = await fetch(
        `${import.meta.env.BASE_URL}/api/storage?container=previews&path=${encodeURIComponent(storagePath)}`,
        { credentials: 'include' },
      );
      if (!signedRes.ok) {
        return null;
      }
      const { url: signedUrl } = await signedRes.json();
      const downloadRes = await fetch(signedUrl);
      if (!downloadRes.ok) {
        return null;
      }
      const previewBlob = await downloadRes.blob();

      const downloadEnd = Date.now();
      const downloadTime = downloadEnd - downloadStart;

      return {
        blob: previewBlob || null,
        updatedAt: new Date(preview.updated_at).getTime() + downloadTime,
      };
    },
    // Poll for preview availability during mesh generation
    refetchInterval: (query) => {
      // Only poll if we don't have a successful preview yet
      return !query.state.data ? 3000 : false;
    },
  });

  return {
    data: query.data?.blob || null,
    updatedAt: query.data?.updatedAt || null,
    isLoading: query.isLoading,
    error: query.error,
  };
};
