import { useConversation } from '@/contexts/ConversationContext';
import type { AppUIMessage } from '@shared/chatAi';
import type { Conversation, Message } from '@shared/types';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

/**
 * Insert a new user message into the conversation. The `update_leaf_trigger`
 * on `public.messages` automatically advances
 * `conversations.current_message_leaf_id` to the inserted row's id, which
 * is what the server-side chat handler walks to build the branch — so a
 * single INSERT is sufficient to set up the next generation request.
 *
 * Returns the new id so the caller can re-use it for the optimistic
 * `useChat` user bubble (keeping the local-state id and the DB id in
 * sync prevents a duplicate-render flash when the messages query
 * refetches after the stream completes).
 */
export async function persistUserMessage({
  conversationId,
  parts,
  metadata,
  parentMessageId,
}: {
  conversationId: string;
  parts: AppUIMessage['parts'];
  metadata: AppUIMessage['metadata'];
  parentMessageId: string | null;
}): Promise<string> {
  const id = crypto.randomUUID();
  const res = await fetch(
    `${import.meta.env.BASE_URL}/api/conversations/${conversationId}/messages`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({
        id,
        role: 'user',
        parts,
        metadata: metadata ?? {},
        parent_message_id: parentMessageId,
      }),
    },
  );
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Failed to persist message' }));
    throw new Error(err.error || 'Failed to persist message');
  }
  return id;
}

/**
 * Persist updated `parts` on an existing assistant row. Used after the
 * client compiles a `build_parametric_model` tool call locally — we need
 * the DB row to reflect the completed tool output before the server reads
 * the leaf and continues the stream.
 */
export async function persistAssistantParts({
  messageId,
  parts,
}: {
  conversationId: string;
  messageId: string;
  parts: AppUIMessage['parts'];
}) {
  const res = await fetch(
    `${import.meta.env.BASE_URL}/api/messages/${messageId}`,
    {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ parts }),
    },
  );
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Failed to update message' }));
    throw new Error(err.error || 'Failed to update message');
  }
}

export const useMessagesQuery = () => {
  const { conversation } = useConversation();

  return useQuery<Message[]>({
    enabled: !!conversation.id,
    queryKey: ['messages', conversation.id],
    initialData: [],
    queryFn: async () => {
      const res = await fetch(
        `${import.meta.env.BASE_URL}/api/conversations/${conversation.id}/messages`,
        { credentials: 'include' },
      );
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: 'Failed to load messages' }));
        throw new Error(err.error || 'Failed to load messages');
      }
      return (await res.json()) as Message[];
    },
  });
};

/**
 * Optimistically update a message row's rating column. The chat tree is
 * read straight from Supabase via useMessagesQuery; this writes both the
 * cache and the DB so the thumb fills in instantly.
 */
export function useChangeRatingMutation({
  conversationId,
}: {
  conversationId: string;
}) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationKey: ['change-rating', conversationId],
    mutationFn: async ({
      messageId,
      rating,
    }: {
      messageId: string;
      rating: number;
    }) => {
      queryClient.setQueryData<Message[]>(
        ['messages', conversationId],
        (oldMessages) =>
          oldMessages?.map((m) => (m.id === messageId ? { ...m, rating } : m)),
      );
      const res = await fetch(
        `${import.meta.env.BASE_URL}/api/messages/${messageId}`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ rating }),
        },
      );
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: 'Failed to update rating' }));
        throw new Error(err.error || 'Failed to update rating');
      }
    },
  });
}

/**
 * "Restore" an old assistant message — matches the legacy CADAM behavior
 * exactly: insert a fresh row that COPIES the message's role, parts,
 * metadata, and `parent_message_id`, then point the conversation's
 * `current_message_leaf_id` at the new copy. Because the copy shares the
 * original's parent, the two messages become siblings, so BranchNavigation
 * keeps working (the user can flip back to whichever version they want).
 *
 * The previous implementation just retargeted `current_message_leaf_id`
 * to the existing message — that "worked" superficially but broke the
 * sibling story for any subsequent retry, because the assistant being
 * restored already had its own children in the tree.
 */
export function useRestoreMessageMutation({
  conversation,
  updateConversationAsync,
}: {
  conversation: Conversation;
  updateConversationAsync?: (conversation: Conversation) => Promise<unknown>;
}) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationKey: ['restore-message', conversation.id],
    mutationFn: async ({
      message,
    }: {
      message: Pick<
        Message,
        'role' | 'parts' | 'metadata' | 'parent_message_id'
      >;
    }) => {
      const newId = crypto.randomUUID();
      const res = await fetch(
        `${import.meta.env.BASE_URL}/api/conversations/${conversation.id}/messages`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({
            id: newId,
            role: message.role,
            parts: message.parts,
            metadata: message.metadata ?? {},
            parent_message_id: message.parent_message_id,
            rating: 0,
          }),
        },
      );
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: 'Failed to restore message' }));
        throw new Error(err.error || 'Failed to restore message');
      }

      if (updateConversationAsync) {
        await updateConversationAsync({
          ...conversation,
          current_message_leaf_id: newId,
        });
      }

      // Pull the freshly inserted row into the messages query so the
      // tree merge sees it as a sibling immediately.
      queryClient.invalidateQueries({
        queryKey: ['messages', conversation.id],
      });
    },
  });
}
