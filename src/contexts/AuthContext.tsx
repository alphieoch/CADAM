import { createContext, useContext } from 'react';

export type SubscriptionLevel = 'standard' | 'pro' | 'max';
export type PlanLevel = SubscriptionLevel | 'free';

export type BillingStatus = {
  user: {
    hasTrialed: boolean;
  };
  subscription: {
    level: SubscriptionLevel;
    status: string | null;
    currentPeriodEnd: string | null;
  } | null;
  tokens: {
    free: number;
    subscription: number;
    purchased: number;
    total: number;
  };
};

// Azure-native user type (replaces Supabase User)
export interface AuthUser {
  id: string;
  email: string;
  full_name: string | null;
  avatar_url: string | null;
  provider: string;
}

const ACTIVE_STATUSES = new Set(['active', 'trialing']);

export function getLevel(billing: BillingStatus | null | undefined): PlanLevel {
  if (!billing?.subscription) return 'free';
  if (!ACTIVE_STATUSES.has(billing.subscription.status ?? '')) return 'free';
  return billing.subscription.level;
}

interface AuthContextType {
  user: AuthUser | null;
  billing: BillingStatus | null;
  isLoading: boolean;
  signIn: (email: string, password: string) => Promise<void>;
  signUp: (email: string, password: string, name: string) => Promise<void>;
  signOut: () => Promise<void>;
  signInWithMagicLink: (email: string) => Promise<void>;
  signInWithMicrosoft: () => Promise<void>;
  signInWithGoogle: () => Promise<void>;
  verifyOtp: (email: string, token: string) => Promise<void>;
  resetPassword: (email: string) => Promise<void>;
  updatePassword: (currentPassword: string, newPassword: string) => Promise<void>;
}

export const AuthContext = createContext<AuthContextType | undefined>(
  undefined,
);

export function useAuth() {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}
