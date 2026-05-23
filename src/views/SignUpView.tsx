import { Link, useNavigate, useLocation } from '@tanstack/react-router';
import { Button } from '@/components/ui/button';
import { useToast } from '@/hooks/use-toast';
import { useAuth } from '@/contexts/AuthContext';

import { useMutation } from '@tanstack/react-query';
import { GoogleIcon, MicrosoftIcon } from '@/components/icons/CompanyIcons';
import { useEffect } from 'react';
import { validateRedirectUrl } from '@/lib/utils';

function getAppRedirectUrl(path: string) {
  const basePath = import.meta.env.BASE_URL.replace(/\/$/, '');

  return `${window.location.origin}${basePath}${path}`;
}

export function SignUpView() {
  const { toast } = useToast();
  const navigate = useNavigate();
  const location = useLocation();
  const { signInWithGoogle, signInWithMicrosoft, user, isLoading: authLoading } = useAuth();

  // Get and validate redirect parameter from URL
  const searchParams = new URLSearchParams(location.searchStr);
  const rawRedirectPath = searchParams.get('redirect');
  const redirectPath = validateRedirectUrl(rawRedirectPath);

  // Redirect to home if already authenticated
  useEffect(() => {
    if (!authLoading && user) {
      navigate({ to: '/', replace: true });
    }
  }, [user, authLoading, navigate]);

  const { mutate: handleSignInWithGoogle, isPending: isSigningInWithGoogle } =
    useMutation({
      mutationFn: async () => {
        await signInWithGoogle();
      },
      onError: (error) => {
        toast({
          title: 'Whoopsies',
          description:
            error instanceof Error ? error.message : 'Something went wrong',
          variant: 'destructive',
        });
      },
    });

  const { mutate: handleSignInWithMicrosoft, isPending: isSigningInWithMicrosoft } =
    useMutation({
      mutationFn: async () => {
        await signInWithMicrosoft();
      },
      onError: (error) => {
        toast({
          title: 'Whoopsies',
          description:
            error instanceof Error ? error.message : 'Something went wrong',
          variant: 'destructive',
        });
      },
    });

  return (
    <div className="flex min-h-screen items-center justify-center bg-adam-bg-dark p-4">
      <div className="w-full max-w-md">
        <div className="rounded-lg bg-adam-bg-secondary-dark p-8 shadow-md">
          <div className="mb-4 flex flex-col items-center justify-center gap-2">
            <img
              src={`${import.meta.env.BASE_URL}/adam-logo.svg`}
              alt="Adam Logo"
              className="mr-2 h-8 w-8"
            />
            <h1 className="text-xl font-semibold text-white">Create Account</h1>
          </div>
          <div className="flex flex-col gap-2 py-2">
            <Button
              onClick={() => handleSignInWithGoogle()}
              className="flex w-full items-center gap-2 p-6 md:hover:bg-adam-blue/10"
              disabled={isSigningInWithGoogle}
            >
              <GoogleIcon className="w-4" />
              <span>Continue with Google</span>
            </Button>
            <Button
              onClick={() => handleSignInWithMicrosoft()}
              className="flex w-full items-center gap-2 bg-[#0078D4] p-6 text-white hover:bg-[#005A9E]"
              disabled={isSigningInWithMicrosoft}
            >
              <MicrosoftIcon className="w-4" />
              <span>Continue with Microsoft</span>
            </Button>
          </div>
          <div className="pt-4 text-center text-sm text-adam-text-secondary">
            <Link
              to="/signup-email"
              className="text-adam-text-primary hover:underline"
            >
              Sign up with email
            </Link>
            {' or '}
            <Link to="/signin" className="text-adam-blue hover:underline">
              Sign in
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
}
