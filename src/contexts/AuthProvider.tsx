import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import posthog from 'posthog-js';
import { AuthContext, type BillingStatus, getLevel, type AuthUser } from './AuthContext';
import { apiJson } from '@/services/api';
import { z } from 'zod';

const LOCAL_BILLING_STATUS: BillingStatus = {
  user: { hasTrialed: false },
  subscription: {
    level: 'pro',
    status: 'active',
    currentPeriodEnd: new Date(
      Date.now() + 365 * 24 * 60 * 60 * 1000,
    ).toISOString(),
  },
  tokens: {
    free: 1_000_000,
    subscription: 1_000_000,
    purchased: 1_000_000,
    total: 3_000_000,
  },
};

const billingStatusSchema = z.object({
  user: z.object({ hasTrialed: z.boolean() }),
  subscription: z
    .object({
      level: z.union([
        z.literal('standard'),
        z.literal('pro'),
        z.literal('max'),
      ]),
      status: z.string().nullable(),
      currentPeriodEnd: z.string().nullable(),
    })
    .nullable(),
  tokens: z.object({
    free: z.number(),
    subscription: z.number(),
    purchased: z.number(),
    total: z.number(),
  }),
});

const userSchema = z.object({
  id: z.string(),
  email: z.string(),
  full_name: z.string().nullable(),
  avatar_url: z.string().nullable(),
  provider: z.string(),
});

const ensurePermission = async () => {
  if (typeof window === 'undefined' || !('Notification' in window)) {
    return false;
  }
  if (Notification.permission === 'granted') return true;
  if (Notification.permission === 'denied') return false;
  const perm = await Notification.requestPermission();
  return perm === 'granted';
};

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const navigate = useNavigate();
  const posthogSent = useRef(false);
  const queryClient = useQueryClient();

  // Initialize auth state from /api/auth/me
  useEffect(() => {
    const initializeAuth = async () => {
      try {
        const res = await fetch(`${import.meta.env.BASE_URL}/api/auth/me`, {
          credentials: 'include',
        });
        if (res.ok) {
          const data = await res.json();
          if (data.user) {
            const parsed = userSchema.safeParse(data.user);
            if (parsed.success) {
              setUser(parsed.data);
            }
          }
        }
      } catch {
        // Auth endpoint not available, stay logged out
      } finally {
        setIsLoading(false);
      }
    };

    initializeAuth();
  }, []);

  // Poll adam-billing for subscription state + token balances
  const { data: billing, isLoading: isBillingLoading } = useQuery({
    queryKey: ['billing', 'status'],
    enabled: !!user,
    refetchInterval: 30000,
    queryFn: async (): Promise<BillingStatus> => {
      try {
        return await apiJson('billing-status', {}, billingStatusSchema);
      } catch (err) {
        if (import.meta.env.DEV) return LOCAL_BILLING_STATUS;
        throw err;
      }
    },
  });

  // Track user in PostHog once we have all their data
  useEffect(() => {
    if (
      user &&
      !posthogSent.current &&
      !isBillingLoading
    ) {
      posthog.identify(user.id, {
        email: user.email,
        full_name: user.full_name,
        subscription: getLevel(billing),
        has_trialed: billing?.user.hasTrialed ?? false,
      });
      posthogSent.current = true;
    }
  }, [user, isBillingLoading, billing]);

  const signIn = async (email: string, password: string) => {
    const res = await fetch(`${import.meta.env.BASE_URL}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ email, password }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({ error: 'Login failed' }));
      throw new Error(data.error || 'Login failed');
    }
    const data = await res.json();
    if (data.user) {
      const parsed = userSchema.safeParse(data.user);
      if (parsed.success) setUser(parsed.data);
    }
  };

  const signUp = async (email: string, password: string, name: string) => {
    const res = await fetch(`${import.meta.env.BASE_URL}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ email, password, name }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({ error: 'Sign up failed' }));
      throw new Error(data.error || 'Sign up failed');
    }
    const data = await res.json();
    if (data.user) {
      const parsed = userSchema.safeParse(data.user);
      if (parsed.success) setUser(parsed.data);
    }
  };

  const signOut = async () => {
    await fetch(`${import.meta.env.BASE_URL}/api/auth/logout`, {
      method: 'POST',
      credentials: 'include',
    });
    setUser(null);
    posthogSent.current = false;
    queryClient.clear();
  };

  const signInWithMagicLink = async (email: string) => {
    // Not implemented in Azure-native auth yet
    console.warn('Magic link not implemented in Azure-native auth');
    throw new Error('Magic link not available');
  };

  const signInWithMicrosoft = async () => {
    window.location.href = `${import.meta.env.BASE_URL}/api/auth/microsoft`;
  };

  const signInWithGoogle = async () => {
    window.location.href = `${import.meta.env.BASE_URL}/api/auth/google`;
  };

  const verifyOtp = async (email: string, token: string) => {
    // Not implemented in Azure-native auth yet
    console.warn('OTP verification not implemented in Azure-native auth');
    throw new Error('OTP verification not available');
  };

  const resetPassword = async (email: string) => {
    // Not implemented in Azure-native auth yet
    console.warn('Password reset not implemented in Azure-native auth');
    throw new Error('Password reset not available');
  };

  const updatePassword = async (password: string) => {
    // Not implemented in Azure-native auth yet
    console.warn('Password update not implemented in Azure-native auth');
    throw new Error('Password update not available');
  };

  return (
    <AuthContext.Provider
      value={{
        user,
        billing: billing ?? null,
        isLoading:
          isLoading || (!!user && isBillingLoading),
        signIn,
        signUp,
        signInWithMagicLink,
        signInWithMicrosoft,
        signInWithGoogle,
        verifyOtp,
        signOut,
        resetPassword,
        updatePassword,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}
