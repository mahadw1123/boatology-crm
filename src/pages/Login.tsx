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
  const [rememberMe, setRememberMe] = useState(true);

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
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden bg-navy px-4 py-10">
      {/* Background — the same boat footage used on boatology.com.au and in the Customer Portal header */}
      <video
        className="absolute inset-0 h-full w-full object-cover"
        src="/media/customer-portal-hero.mp4"
        autoPlay
        loop
        muted
        playsInline
      />
      <div className="absolute inset-0 bg-gradient-to-b from-navy/50 via-navy/35 to-navy/60" />

      <div className="relative w-full max-w-sm rounded-2xl border border-white/20 bg-navy/15 p-8 shadow-2xl backdrop-blur-sm">
        <div className="mb-6 flex flex-col items-center gap-2">
          <div className="flex h-12 w-12 items-center justify-center rounded-lg bg-white/10 ring-1 ring-white/20">
            <BoatologyLogo variant="emblem" light className="h-7 w-7" />
          </div>
          <h1 className="text-xl font-semibold tracking-tight text-white">{companyNameQuery.data?.name || "Boatology"}</h1>
          <p className="text-xs uppercase tracking-[0.15em] text-white/70">
            {mode === "register" ? "Create a customer account" : "Management System"}
          </p>
        </div>

        {mode === "login" ? (
          <form
            className="flex flex-col gap-4"
            onSubmit={(e) => {
              e.preventDefault();
              loginMutation.mutate({ email, password, rememberMe });
            }}
          >
            <div>
              <label className="mb-1 block text-xs font-medium text-white/85">Email</label>
              <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
            </div>
            <div>
              <div className="mb-1 flex items-center justify-between">
                <label className="block text-xs font-medium text-white/85">Password</label>
                <Link href="/forgot-password" className="text-xs font-medium text-sky-300 hover:text-sky-200 hover:underline">
                  Forgot password?
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
            <label className="flex items-center gap-2 text-xs font-medium text-white/85">
              <input
                type="checkbox"
                checked={rememberMe}
                onChange={(e) => setRememberMe(e.target.checked)}
                className="h-3.5 w-3.5 rounded border-white/40 bg-white/10 accent-navy"
              />
              Remember me
            </label>
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
            <div className="rounded-lg border border-sky-300/30 bg-sky-950/40 p-3 text-xs text-sky-100">
              This creates a <strong>customer</strong> account, for tracking your own quotes and jobs.
              Staff accounts are set up by an administrator invite instead.
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-white/85">Full name</label>
              <Input value={name} onChange={(e) => setName(e.target.value)} required />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-white/85">Email</label>
              <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
              <p className="mt-1 text-xs text-white/70">
                For security, a new account is not linked automatically. After registration, ask office staff
                to verify your identity and link it in Administration → Users.
              </p>
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-white/85">Password</label>
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
          className="mt-4 w-full text-center text-xs font-medium text-sky-300 underline hover:text-sky-200"
        >
          {mode === "login" ? "Need an account? Create one" : "Already have an account? Sign in"}
        </button>
      </div>
    </div>
  );
}
