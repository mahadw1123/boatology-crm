import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { trpc } from "@/lib/trpc";
import { BoatologyLogo } from "@/components/BoatologyLogo";
import { CheckCircle2 } from "lucide-react";
import { useState } from "react";
import { useSearch, Link } from "wouter";
import { toast } from "sonner";
import { showErrorToast } from "@/lib/errors";

export default function ResetPassword() {
  const companyNameQuery = trpc.administration.companyName.useQuery();
  const search = useSearch();
  const token = new URLSearchParams(search).get("token") || "";

  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [success, setSuccess] = useState(false);

  const resetMutation = trpc.auth.resetPassword.useMutation({
    onSuccess: () => setSuccess(true),
    onError: (err) => showErrorToast(err),
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (password.length < 12) {
      toast.error("Password must be at least 12 characters");
      return;
    }
    if (password !== confirmPassword) {
      toast.error("Passwords don't match");
      return;
    }
    resetMutation.mutate({ token, newPassword: password });
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-surface-muted px-4">
      <div className="w-full max-w-sm rounded-xl border border-border bg-white p-8 shadow-card">
        <div className="mb-6 flex items-center gap-2">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-navy">
            <BoatologyLogo variant="emblem" light className="h-5 w-5" />
          </div>
          <span className="text-sm font-semibold tracking-wide text-navy">{companyNameQuery.data?.name || "Boatology"}</span>
        </div>

        {!token ? (
          <div>
            <h1 className="text-lg font-semibold text-ink">Invalid reset link</h1>
            <p className="mt-2 text-sm text-ink-light">
              This link is missing its reset token. Request a new one from the sign-in page.
            </p>
            <Link href="/forgot-password" className="mt-6 inline-block text-sm text-ocean hover:underline">
              Request a new link
            </Link>
          </div>
        ) : success ? (
          <div>
            <div className="mb-4 flex h-10 w-10 items-center justify-center rounded-full bg-emerald-100">
              <CheckCircle2 className="h-5 w-5 text-emerald-600" />
            </div>
            <h1 className="text-lg font-semibold text-ink">Password updated</h1>
            <p className="mt-2 text-sm text-ink-light">You can now sign in with your new password.</p>
            <Link href="/login" className="mt-6 inline-block">
              <Button className="bg-navy hover:bg-navy-700">Go to Sign In</Button>
            </Link>
          </div>
        ) : (
          <>
            <h1 className="text-lg font-semibold text-ink">Set a new password</h1>
            <p className="mt-1 text-sm text-ink-light">Choose a new password for your account.</p>
            <form className="mt-6 flex flex-col gap-4" onSubmit={handleSubmit}>
              <div>
                <label className="mb-1 block text-xs font-medium text-ink-light">New Password</label>
                <Input type="password" maxLength={72} value={password} onChange={(e) => setPassword(e.target.value)} required autoFocus minLength={12} />
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium text-ink-light">Confirm Password</label>
                <Input type="password" maxLength={72} value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} required minLength={12} />
              </div>
              <Button type="submit" className="bg-navy hover:bg-navy-700" disabled={resetMutation.isPending}>
                {resetMutation.isPending ? "Saving..." : "Reset Password"}
              </Button>
            </form>
          </>
        )}
      </div>
    </div>
  );
}
