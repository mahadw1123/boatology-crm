import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { trpc } from "@/lib/trpc";
import { BoatologyLogo } from "@/components/BoatologyLogo";
import { useState } from "react";
import { toast } from "sonner";
import { showErrorToast } from "@/lib/errors";

export default function SetupAdmin() {
  const companyNameQuery = trpc.administration.companyName.useQuery();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");

  const utils = trpc.useUtils();
  const bootstrapMutation = trpc.auth.bootstrapAdmin.useMutation({
    onSuccess: () => {
      toast.success("Admin account created");
      utils.auth.me.invalidate();
      utils.auth.needsBootstrap.invalidate();
    },
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
    bootstrapMutation.mutate({ name, email, password });
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

        <h1 className="text-lg font-semibold text-ink">Set up your admin account</h1>
        <p className="mt-1 text-sm text-ink-light">
          This is a brand-new installation with no accounts yet. Create the first admin account to
          get started — from there, you'll invite the rest of your team from Administration.
        </p>

        <form className="mt-6 flex flex-col gap-4" onSubmit={handleSubmit}>
          <div>
            <label className="mb-1 block text-xs font-medium text-ink-light">Your Name</label>
            <Input value={name} onChange={(e) => setName(e.target.value)} required autoFocus />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-ink-light">Email</label>
            <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-ink-light">Password</label>
            <Input type="password" maxLength={72} value={password} onChange={(e) => setPassword(e.target.value)} required minLength={12} />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-ink-light">Confirm Password</label>
            <Input type="password" maxLength={72} value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} required minLength={12} />
          </div>
          <Button type="submit" className="bg-navy hover:bg-navy-700" disabled={bootstrapMutation.isPending}>
            {bootstrapMutation.isPending ? "Creating..." : "Create Admin Account"}
          </Button>
        </form>
      </div>
    </div>
  );
}
