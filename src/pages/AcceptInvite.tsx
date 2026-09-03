import { useState } from "react";
import { useLocation, useSearch } from "wouter";
import { trpc } from "@/lib/trpc";
import { BoatologyLogo } from "@/components/BoatologyLogo";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { toast } from "sonner";
import { showErrorToast } from "@/lib/errors";

export default function AcceptInvite() {
  const [, navigate] = useLocation();
  const search = useSearch();
  const token = new URLSearchParams(search).get("token") || "";
  const utils = trpc.useUtils();
  const companyNameQuery = trpc.administration.companyName.useQuery();

  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");

  const inviteInfoQuery = trpc.auth.inviteInfo.useQuery(token, { enabled: !!token });

  const acceptMutation = trpc.auth.acceptInvite.useMutation({
    onSuccess: (user) => {
      utils.auth.me.setData(undefined, user);
      toast.success("Account activated");
      navigate("/");
    },
    onError: (err) => showErrorToast(err),
  });

  if (!token) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-navy px-4">
        <div className="w-full max-w-sm rounded-xl bg-white p-8 text-center shadow-cardHover">
          <p className="text-sm text-ink">This invite link is missing its token.</p>
        </div>
      </div>
    );
  }

  if (inviteInfoQuery.isLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-navy">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-white border-t-transparent" />
      </div>
    );
  }

  if (!inviteInfoQuery.data) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-navy px-4">
        <div className="w-full max-w-sm rounded-xl bg-white p-8 text-center shadow-cardHover">
          <h1 className="mb-2 text-lg font-semibold text-navy">Invite not valid</h1>
          <p className="text-sm text-ink-light">
            This invite link has expired, already been used, or doesn't exist. Ask an admin to send
            you a new one.
          </p>
        </div>
      </div>
    );
  }

  const roleLabels: Record<string, string> = {
    admin: "Administrator",
    management: "Management",
    office_staff: "Office Staff",
    technician: "Technician",
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-navy px-4">
      <div className="w-full max-w-sm rounded-xl bg-white p-8 shadow-cardHover">
        <div className="mb-6 flex flex-col items-center gap-2">
          <div className="flex h-12 w-12 items-center justify-center rounded-lg bg-navy">
            <BoatologyLogo variant="emblem" light className="h-7 w-7" />
          </div>
          <h1 className="text-xl font-semibold text-navy">Welcome to {companyNameQuery.data?.name || "Boatology"}</h1>
          <p className="text-center text-sm text-ink-light">
            You've been invited as <strong>{roleLabels[inviteInfoQuery.data.role] || inviteInfoQuery.data.role}</strong> —
            set your name and password to activate your account.
          </p>
        </div>

        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (password !== confirmPassword) {
              toast.error("Passwords don't match");
              return;
            }
            acceptMutation.mutate({ token, name, password });
          }}
        >
          <div>
            <label className="mb-1 block text-xs font-medium text-ink-light">Email</label>
            <Input value={inviteInfoQuery.data.email} disabled className="bg-slate-50" />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-ink-light">Full name</label>
            <Input value={name} onChange={(e) => setName(e.target.value)} required />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-ink-light">Password</label>
            <Input
              type="password"
              maxLength={72}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              minLength={12}
              required
            />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-ink-light">Confirm password</label>
            <Input
              type="password"
              maxLength={72}
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              minLength={12}
              required
            />
          </div>
          <Button type="submit" className="bg-navy hover:bg-navy-700" disabled={acceptMutation.isPending}>
            {acceptMutation.isPending ? "Activating..." : "Activate account"}
          </Button>
        </form>
      </div>
    </div>
  );
}
