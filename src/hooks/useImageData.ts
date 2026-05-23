import { useConversation } from '@/contexts/ConversationContext';
import { Prompt } from '@shared/types';
import { useQueries, useQuery } from '@tanstack/react-query';

export function useImageData(id: string) {
  const { conversation } = useConversation();

  const dataQuery = useQuery({
    queryKey: ['imageData', conversation.user_id, conversation.id, id],
    queryFn: async () => {
      const res = await fetch(
        `${import.meta.env.BASE_URL}/api/images/${id}`,
        { credentials: 'include' },
      );
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: 'Failed to load image' }));
        throw new Error(err.error);
      }
      return res.json() as Promise<{
        id: string;
        user_id: string;
        conversation_id: string;
        prompt: Prompt;
        status: string;
        image_generation_call_id: string | null;
        created_at: string;
      }>;
    },
    refetchInterval: (query) => {
      if (query.state.data?.status === 'pending') {
        return 10 * 1000;
      }
      return false;
    },
  });

  const urlQuery = useQuery({
    queryKey: ['image', conversation.user_id, conversation.id, id],
    enabled: dataQuery.data?.status === 'success',
    queryFn: async () => {
      const storagePath = `${conversation.user_id}/${conversation.id}/${id}`;
      const signedRes = await fetch(
        `${import.meta.env.BASE_URL}/api/storage?container=images&path=${encodeURIComponent(storagePath)}`,
        { credentials: 'include' },
      );
      if (!signedRes.ok) {
        throw new Error('Failed to get signed URL for image');
      }
      const { url: signedUrl } = await signedRes.json();
      const downloadRes = await fetch(signedUrl);
      if (!downloadRes.ok) {
        throw new Error('Failed to download image');
      }
      const blob = await downloadRes.blob();
      const reader = new FileReader();
      const urlPromise = new Promise<string>((resolve) => {
        reader.onload = () => {
          resolve(reader.result as string);
        };
      });
      reader.readAsDataURL(blob);
      const url = await urlPromise;
      return { id, url };
    },
  });

  return { data: dataQuery, url: urlQuery };
}

export function useImagesData(ids: string[]) {
  const { conversation } = useConversation();

  const dataQueries = useQueries({
    queries: ids.map((id) => ({
      queryKey: ['imageData', conversation.user_id, conversation.id, id],
      enabled: !!id,
      queryFn: async () => {
        const res = await fetch(
          `${import.meta.env.BASE_URL}/api/images/${id}`,
          { credentials: 'include' },
        );
        if (!res.ok) {
          const err = await res.json().catch(() => ({ error: 'Failed to load image' }));
          throw new Error(err.error);
        }
        return res.json();
      },
    })),
  });

  const urlQueries = useQueries({
    queries: ids.map((id) => ({
      queryKey: ['image', conversation.user_id, conversation.id, id],
      enabled: dataQueries.some(
        (query) =>
          query.data && query.data.id === id && query.data.status === 'success',
      ),
      queryFn: async () => {
        const storagePath = `${conversation.user_id}/${conversation.id}/${id}`;
        const signedRes = await fetch(
          `${import.meta.env.BASE_URL}/api/storage?container=images&path=${encodeURIComponent(storagePath)}`,
          { credentials: 'include' },
        );
        if (!signedRes.ok) {
          throw new Error('Failed to get signed URL for image');
        }
        const { url: signedUrl } = await signedRes.json();
        const downloadRes = await fetch(signedUrl);
        if (!downloadRes.ok) {
          throw new Error('Failed to download image');
        }
        const blob = await downloadRes.blob();
        const reader = new FileReader();
        const urlPromise = new Promise<string>((resolve) => {
          reader.onload = () => {
            resolve(reader.result as string);
          };
        });
        reader.readAsDataURL(blob);
        const url = await urlPromise;
        return { id, url };
      },
    })),
  });

  return { data: dataQueries, url: urlQueries };
}
