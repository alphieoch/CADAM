import { useConversation } from '@/contexts/ConversationContext';
import { useQuery } from '@tanstack/react-query';

export const useMeshData = ({ id }: { id: string }) => {
  const { conversation } = useConversation();

  const dataQuery = useQuery({
    queryKey: ['meshData', id],
    enabled: !!id,
    queryFn: async () => {
      const res = await fetch(
        `${import.meta.env.BASE_URL}/api/meshes/${id}`,
        { credentials: 'include' },
      );
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: 'Failed to load mesh' }));
        throw new Error(err.error);
      }
      return res.json();
    },
    // Poll while pending to ensure UI progresses past 95% as soon as status flips
    refetchInterval: (query) => {
      const current = query.state.data as { status: string } | undefined;
      return current && current.status === 'pending' ? 3000 : false;
    },
  });

  const blobQuery = useQuery({
    queryKey: ['mesh', id],
    enabled:
      !!id &&
      !dataQuery.isLoading &&
      dataQuery.data &&
      dataQuery.data.status === 'success',
    queryFn: async () => {
      const fileExtension = dataQuery.data?.file_type || 'glb';
      const storagePath = `${conversation.user_id}/${conversation.id}/${id}.${fileExtension}`;
      const signedRes = await fetch(
        `${import.meta.env.BASE_URL}/api/storage?container=meshes&path=${encodeURIComponent(storagePath)}`,
        { credentials: 'include' },
      );
      if (!signedRes.ok) {
        throw new Error('Failed to get signed URL for mesh');
      }
      const { url: signedUrl } = await signedRes.json();
      const downloadRes = await fetch(signedUrl);
      if (!downloadRes.ok) {
        throw new Error('Failed to download mesh');
      }
      return downloadRes.blob();
    },
    refetchOnMount: false,
  });

  return {
    data: dataQuery,
    blob: blobQuery,
  };
};
