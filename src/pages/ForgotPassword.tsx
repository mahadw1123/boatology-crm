import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { trpc } from "@/lib/trpc";
import { BoatologyLogo } from "@/components/BoatologyLogo";
import { ArrowLeft, Mail } from "lucide-react";
import { useState } from "react";
import { Link } from "wouter";

export default function ForgotPassword() {
  const companyNameQuery = trpc.administration.companyName.useQuery();
  const [email, setEmail] = useState("");
  const [submitted, setSubmitted] = useState(false);

  const requestMutation = trpc.auth.requestPasswordReset.useMutation({
    onSuccess: () => setSubmitted(true),
  });

  return (
    <div className="flex min-h-screen items-center justify-center bg-surface-muted px-4">
      <div className="w-full max-w-sm rounded-xl border border-border bg-white p-8 shadow-card">
        <div className="mb-6 flex items-center gap-2">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-navy">
            <BoatologyLogo variant="emblem" light className="h-5 w-5" />
          </div>
          <span className="text-sm font-semibold tracking-wide text-navy">{companyNameQuery.data?.name || "Boatology"}</span>
        </div>

        {submitted ? (
          <div>
            <div className="mb-4 flex h-10 w-10 items-center justify-center rounded-full bg-emerald-100">
              <Mail className="h-5 w-5 text-emerald-600" />
            </div>
            <h1 className="text-lg font-semibold text-ink">Check your email</h1>
            <p className="mt-2 text-sm text-ink-light">
              If an account exists for <strong>{email}</strong>, we've sent a link to reset your password. It
              expires in 1 hour.
            </p>
            <Link href="/login">
              <a className="mt-6 flex items-center gap-1.5 text-sm text-ocean hover:underline">
                <ArrowLeft className="h-3.5 w-3.5" />
                Back to sign in
              </a>
            </Link>
          </div>
        ) : (
          <>
            <h1 className="text-lg font-semibold text-ink">Reset your password</h1>
            <p className="mt-1 text-sm text-ink-light">
              Enter the email on your account and we'll send you a link to reset your password.
            </p>
            <form
              className="mt-6 flex flex-col gap-4"
              onSubmit={(e) => {
                e.preventDefault();
                requestMutation.mutate({ email });
              }}
            >
              <div>
                <label className="mb-1 block text-xs font-medium text-ink-light">Email</label>
                <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus />
              </div>
              <Button type="submit" className="bg-navy hover:bg-navy-700" disabled={requestMutation.isPending}>
                {requestMutation.isPending ? "Sending..." : "Send Reset Link"}
              </Button>
            </form>
            <Link href="/login">
              <a className="mt-4 flex items-center gap-1.5 text-sm text-ocean hover:underline">
                <ArrowLeft className="h-3.5 w-3.5" />
                Back to sign in
              </a>
            </Link>
          </>
        )}
      </div>
    </div>
  );
}
