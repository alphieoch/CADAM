import { useState, useEffect } from 'react';
import { Loader2, ArrowLeft } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useToast } from '@/hooks/use-toast';
import { useAuth } from '@/contexts/AuthContext';
import { Link, useSearch } from '@tanstack/react-router';

export function ResetPasswordView() {
  const search = useSearch({ from: '/reset-password' }) as { token?: string };
  const hasToken = !!search.token;

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [isSuccess, setIsSuccess] = useState(false);
  const { toast } = useToast();
  const { resetPassword } = useAuth();

  const handleRequestReset = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsLoading(true);

    try {
      await resetPassword(email);
      setIsSuccess(true);
      toast({
        title: 'Success',
        description: 'Password reset instructions have been sent to your email',
      });
    } catch (error) {
      toast({
        title: 'Error',
        description: 'Failed to send reset instructions',
        variant: 'destructive',
      });
    } finally {
      setIsLoading(false);
    }
  };

  const handleVerifyReset = async (e: React.FormEvent) => {
    e.preventDefault();
    if (password !== confirmPassword) {
      toast({
        title: 'Error',
        description: 'Passwords do not match',
        variant: 'destructive',
      });
      return;
    }
    if (password.length < 6) {
      toast({
        title: 'Error',
        description: 'Password must be at least 6 characters',
        variant: 'destructive',
      });
      return;
    }

    setIsLoading(true);
    try {
      const res = await fetch(`${import.meta.env.BASE_URL}/api/auth/verify-reset`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: search.token, password }),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({ error: 'Reset failed' }));
        throw new Error(data.error || 'Reset failed');
      }

      setIsSuccess(true);
      toast({
        title: 'Success',
        description: 'Your password has been reset. You can now sign in.',
      });
    } catch (error) {
      toast({
        title: 'Error',
        description: error instanceof Error ? error.message : 'Failed to reset password',
        variant: 'destructive',
      });
    } finally {
      setIsLoading(false);
    }
  };

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
            <h1 className="text-2xl font-semibold text-white">
              {hasToken ? 'Set New Password' : 'Reset Password'}
            </h1>
          </div>

          {isSuccess ? (
            <div className="space-y-4 text-center">
              <p className="text-green-400">
                {hasToken
                  ? 'Your password has been reset successfully.'
                  : 'Check your email for password reset instructions.'}
              </p>
              <Link
                to="/signin"
                className="flex w-full items-center justify-center text-adam-blue hover:text-adam-blue/80"
              >
                <ArrowLeft className="mr-2 h-4 w-4" />
                <p className="text-sm">Back to Sign In</p>
              </Link>
            </div>
          ) : hasToken ? (
            <form onSubmit={handleVerifyReset} className="space-y-6">
              <div className="space-y-2">
                <Label htmlFor="password" className="text-white">
                  New Password
                </Label>
                <Input
                  id="password"
                  type="password"
                  placeholder="Enter new password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                  className="border-gray-700 bg-adam-bg-dark text-white placeholder:text-gray-400"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="confirmPassword" className="text-white">
                  Confirm Password
                </Label>
                <Input
                  id="confirmPassword"
                  type="password"
                  placeholder="Confirm new password"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  required
                  className="border-gray-700 bg-adam-bg-dark text-white placeholder:text-gray-400"
                />
              </div>
              <Button type="submit" className="w-full" disabled={isLoading}>
                {isLoading ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Resetting...
                  </>
                ) : (
                  'Reset Password'
                )}
              </Button>
            </form>
          ) : (
            <form onSubmit={handleRequestReset} className="space-y-6">
              <div className="space-y-2">
                <Label htmlFor="email" className="text-white">
                  Email
                </Label>
                <Input
                  id="email"
                  type="email"
                  placeholder="Enter your email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                  className="border-gray-700 bg-adam-bg-dark text-white placeholder:text-gray-400"
                />
              </div>

              <Button type="submit" className="w-full" disabled={isLoading}>
                {isLoading ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Sending instructions...
                  </>
                ) : (
                  'Send Reset Instructions'
                )}
              </Button>

              <Link
                to="/signin"
                className="flex w-full items-center justify-center text-adam-blue hover:text-adam-blue/80"
              >
                <ArrowLeft className="mr-2 h-4 w-4" />
                <p className="text-sm">Back to Sign In</p>
              </Link>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}
