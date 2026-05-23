import { useEffect } from 'react';
import { useNavigate, useLocation } from '@tanstack/react-router';
import { useAuth } from '@/contexts/AuthContext';
import { Loader2 } from 'lucide-react';

interface AuthGuardProps {
  children: React.ReactNode;
}

export function AuthGuard({ children }: AuthGuardProps) {
  const { user, isLoading } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();

  useEffect(() => {
    if (!isLoading && !user) {
      // Capture current path for redirect after authentication
      // Only include pathname and search to avoid security issues
      const currentPath = location.pathname + location.searchStr;
      const search = currentPath !== '/' ? { redirect: currentPath } : {};

      navigate({ to: '/signin', search, replace: true });
    }
  }, [
    user,
    navigate,
    isLoading,
    location.pathname,
    location.searchStr,
  ]);

  if (isLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-blue-500" />
      </div>
    );
  }

  if (!user) {
    return null;
  }

  return <>{children}</>;
}
