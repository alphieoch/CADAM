import React, { useEffect, useState } from 'react';
import { Link } from '@tanstack/react-router';
import { Button } from '@/components/ui/button';
import { Mail } from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';

function EmailConfirmation() {
  const [email, setEmail] = useState('');

  useEffect(() => {
    const storedEmail = sessionStorage.getItem('pendingSignupEmail');
    if (storedEmail) {
      setEmail(storedEmail);
      sessionStorage.removeItem('pendingSignupEmail');
    }
  }, []);

  return (
    <div className="flex min-h-screen items-center justify-center bg-adam-bg-dark p-4">
      <div className="w-full max-w-md">
        <div className="rounded-lg bg-adam-bg-secondary-dark p-8 shadow-md">
          {/* Icon and Header */}
          <div className="mb-8 text-center">
            <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-adam-neutral-800">
              <Mail className="h-6 w-6 text-white" />
            </div>
            <h1 className="mb-4 text-2xl font-semibold text-white">
              Account Created
            </h1>
            <p className="text-gray-400">
              Your account{email ? ` for ${email}` : ''} is ready to use.
            </p>
          </div>

          {/* Instructions */}
          <div className="space-y-6">
            <Alert className="border-adam-neutral-700 bg-adam-neutral-800">
              <AlertDescription className="text-center text-gray-400">
                You can now{' '}
                <Link
                  to="/signin"
                  className="font-medium text-adam-text-primary transition-colors duration-200 hover:text-adam-text-primary/80"
                >
                  sign in here
                </Link>
                {' '}to start creating.
              </AlertDescription>
            </Alert>

            <Link to="/signin">
              <Button
                type="button"
                className="w-full p-6 text-adam-blue transition-colors duration-200 hover:bg-adam-neutral-950 hover:text-adam-blue/80"
              >
                Sign In
              </Button>
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
}

export default EmailConfirmation;
