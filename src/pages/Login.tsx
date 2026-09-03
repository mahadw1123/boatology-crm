import { useState } from "react";
import { useLocation, Link } from "wouter";
import { trpc } from "@/lib/trpc";
import { BoatologyLogo } from "@/components/BoatologyLogo";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { toast } from "sonner";
import { showErrorToast } from "@/lib/errors";

export default function Login() {
  const [, navigate] = useLocation();
  const utils = trpc.useUtils();
  const companyNameQuery = trpc.administration.companyName.useQuery();
  const [mode, setMode] = useState<"login" | "register">("login");

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");

  const destinationAfterAuth = (() => {
    const current = `${window.location.pathname}${window.location.search}`;
    return current === "/login" || current === "/" ? null : current;
  })();

  const loginMutation = trpc.auth.login.useMutation({
    onSuccess: (user) => {
      utils.auth.me.setData(undefined, user);
      if (destinationAfterAuth) {
        navigate(destinationAfterAuth);
      } else {
        navigate(user.role === "customer" ? "/customer-portal" : "/");
      }
    },
    onError: (err) => {
      showErrorToast(err, "Login failed");
    },
  });

  const registerMutation = trpc.auth.register.useMutation({
    onSuccess: (user) => {
      utils.auth.me.setData(undefined, user);
      toast.success("Account created");
      if (destinationAfterAuth) {
        navigate(destinationAfterAuth);
      } else {
        navigate(user.role === "customer" ? "/customer-portal" : "/");
      }
    },
    onError: (err) => {
      showErrorToast(err, "Registration failed");
    },
  });

  return (
    <div className="flex min-h-screen items-center justify-center bg-navy px-4">
      <div className="w-full max-w-sm rounded-xl bg-white p-8 shadow-cardHover">
        <div className="mb-6 flex flex-col items-center gap-2">
          <div className="flex h-12 w-12 items-center justify-center rounded-lg bg-navy">
            <BoatologyLogo variant="emblem" light className="h-7 w-7" />
          </div>
          <h1 className="text-xl font-semibold text-navy">{companyNameQuery.data?.name || "Boatology"}</h1>
          {mode === "register" && (
            <p className="text-sm text-ink-light">Create a customer account</p>
          )}
        </div>

        {mode === "login" ? (
          <form
            className="flex flex-col gap-4"
            onSubmit={(e) => {
              e.preventDefault();
              loginMutation.mutate({ email, password });
            }}
          >
            <div>
              <label className="mb-1 block text-xs font-medium text-ink-light">Email</label>
              <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
            </div>
            <div>
              <div className="mb-1 flex items-center justify-between">
                <label className="block text-xs font-medium text-ink-light">Password</label>
                <Link href="/forgot-password">
                  <a className="text-xs text-ocean hover:underline">Forgot password?</a>
                </Link>
              </div>
              <Input
                type="password"
                maxLength={72}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
              />
            </div>
            <Button type="submit" className="bg-navy hover:bg-navy-700" disabled={loginMutation.isPending}>
              {loginMutation.isPending ? "Signing in..." : "Sign in"}
            </Button>
          </form>
        ) : (
          <form
            className="flex flex-col gap-4"
            onSubmit={(e) => {
              e.preventDefault();
              registerMutation.mutate({ name, email, password });
            }}
          >
            <div className="rounded-lg border border-blue-200 bg-blue-50 p-3 text-xs text-blue-800">
              This creates a <strong>customer</strong> account, for tracking your own quotes and jobs.
              Staff accounts are set up by an administrator invite instead.
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-ink-light">Full name</label>
              <Input value={name} onChange={(e) => setName(e.target.value)} required />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-ink-light">Email</label>
              <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
              <p className="mt-1 text-xs text-ink-light">
                For security, a new account is not linked automatically. After registration, ask office staff
                to verify your identity and link it in Administration → Users.
              </p>
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
            <Button
              type="submit"
              className="bg-navy hover:bg-navy-700"
              disabled={registerMutation.isPending}
            >
              {registerMutation.isPending ? "Creating account..." : "Create account"}
            </Button>
          </form>
        )}

        <button
          type="button"
          onClick={() => setMode(mode === "login" ? "register" : "login")}
          className="mt-4 w-full text-center text-xs font-medium text-ocean underline"
        >
          {mode === "login" ? "Need an account? Create one" : "Already have an account? Sign in"}
        </button>
      </div>
    </div>
  );
}
