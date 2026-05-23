import { useCallback } from 'react';

export function useRequestCancellation() {
  const cancelRequest = useCallback(async (messageId: string) => {
    // Request cancellation via Supabase Realtime is not yet migrated to Azure.
    // For now, this is a no-op. Cancellation can be implemented via:
    // 1. Azure SignalR Service
    // 2. Azure Event Grid
    // 3. SSE (Server-Sent Events) with an abort controller
    console.log(`Cancellation for message ${messageId} not yet supported in Azure-native mode`);
  }, []);

  return { cancelRequest };
}
