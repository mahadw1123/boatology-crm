import { type ReactNode, useState } from "react";
import { Link, useLocation } from "wouter";
import {
  LayoutDashboard,
  Users,
  Anchor,
  FileText,
  Receipt,
  Package,
  Wrench,
  Calendar,
  UserCog,
  BarChart3,
  FolderOpen,
  ShieldCheck,
  Search,
  Bell,
  ChevronDown,
  LogOut,
  ShieldAlert,
  Clock,
  ListOrdered,
  CheckSquare,
  MapPin,
  DollarSign,
  Database,
} from "lucide-react";
import { useAuth } from "@/_core/hooks/useAuth";
import { trpc } from "@/lib/trpc";
import { BoatologyLogo } from "@/components/BoatologyLogo";
import { ROLE_LABELS, type Role } from "@shared/const";
import Login from "@/pages/Login";
import SetupAdmin from "@/pages/SetupAdmin";

const NAV_ITEMS: { href: string; label: string; icon: any; roles: Role[]; group: string; hidden?: boolean }[] = [
  { href: "/", label: "Dashboard", icon: LayoutDashboard, roles: ["admin", "management", "office_staff"], group: "Overview" },

  { href: "/contacts", label: "Contacts", icon: Users, roles: ["admin", "management", "office_staff"], group: "Sales" },
  // Not shown in the sidebar (folded into Contacts above), but customer
  // detail pages (/customers/:id) still need a permission rule to match
  // against, or they'd fall through to "unrestricted" for every role.
  { href: "/customers", label: "Customers", icon: Users, roles: ["admin", "management", "office_staff"], group: "Sales", hidden: true },
  { href: "/vessels", label: "Vessels", icon: Anchor, roles: ["admin", "management", "office_staff"], group: "Sales" },
  { href: "/quotes", label: "Quotes", icon: FileText, roles: ["admin", "management", "office_staff"], group: "Sales" },
  { href: "/invoices", label: "Invoices", icon: Receipt, roles: ["admin", "management", "office_staff"], group: "Sales" },

  { href: "/jobs", label: "Jobs", icon: Wrench, roles: ["admin", "management", "office_staff"], group: "Operations" },
  { href: "/calendar", label: "Calendar", icon: Calendar, roles: ["admin", "management", "office_staff", "technician"], group: "Operations" },
  { href: "/timeline", label: "Timeline", icon: ListOrdered, roles: ["admin", "management", "office_staff"], group: "Operations" },
  { href: "/task-centre", label: "Task Centre", icon: CheckSquare, roles: ["admin", "management", "office_staff"], group: "Operations" },
  { href: "/job-map", label: "Job Map", icon: MapPin, roles: ["admin", "management", "office_staff"], group: "Operations" },

  { href: "/inventory", label: "Inventory", icon: Package, roles: ["admin", "management", "office_staff"], group: "Resources" },
  { href: "/materials", label: "Materials", icon: Package, roles: ["technician"], group: "Resources" },
  { href: "/time-tracking", label: "Time Tracking", icon: Clock, roles: ["admin", "management", "office_staff"], group: "Resources" },
  { href: "/costs", label: "Costs", icon: DollarSign, roles: ["admin", "management", "office_staff"], group: "Resources" },

  { href: "/analytics", label: "Analytics", icon: BarChart3, roles: ["admin", "management"], group: "Insights" },
  { href: "/reports", label: "Reports", icon: FileText, roles: ["admin", "management", "office_staff"], group: "Insights" },

  { href: "/employees", label: "Employees", icon: UserCog, roles: ["admin", "management"], group: "Admin" },
  { href: "/documents", label: "Documents", icon: FolderOpen, roles: ["admin", "management", "office_staff"], group: "Admin" },
  { href: "/data-import", label: "Data Import", icon: Database, roles: ["admin", "management", "office_staff"], group: "Admin" },
  { href: "/administration", label: "Administration", icon: ShieldCheck, roles: ["admin"], group: "Admin" },
];

function isPathAllowed(path: string, role: Role) {
  // Longest matching prefix wins, so /quotes/5 is governed by the /quotes rule.
  const match = [...NAV_ITEMS]
    .sort((a, b) => b.href.length - a.href.length)
    .find((item) => (item.href === "/" ? path === "/" : path.startsWith(item.href)));
  if (!match) return true; // Unlisted routes (e.g. 404) aren't restricted here.
  return match.roles.includes(role);
}

export default function DashboardLayout({ children }: { children: ReactNode }) {
  const [location, navigate] = useLocation();
  const { user, isLoading, isAuthenticated, logout } = useAuth();
  const companyNameQuery = trpc.administration.companyName.useQuery();
  const needsBootstrapQuery = trpc.auth.needsBootstrap.useQuery(undefined, {
    // Only worth checking while nobody's logged in — once authenticated,
    // the system obviously already has at least one account.
    enabled: !isAuthenticated,
  });
  const [menuOpen, setMenuOpen] = useState(false);

  if (isLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-surface-muted">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-ocean border-t-transparent" />
      </div>
    );
  }

  if (location.startsWith("/accept-invite")) {
    // Public route — the person isn't logged in yet, that's the whole point.
    return <>{children}</>;
  }

  if (location.startsWith("/forgot-password") || location.startsWith("/reset-password")) {
    // Also public — someone locked out of their account is, by definition,
    // not authenticated yet.
    return <>{children}</>;
  }

  if (!isAuthenticated) {
    if (needsBootstrapQuery.data?.needsBootstrap) {
      return <SetupAdmin />;
    }
    return <Login />;
  }

  if (location.startsWith("/customer-portal")) {
    // Customer portal has its own dedicated shell.
    return <>{children}</>;
  }

  // Customer accounts never see the staff shell — send them to their portal.
  if (user?.role === "customer") {
    if (location !== "/customer-portal") {
      navigate("/customer-portal");
      return null;
    }
    return <>{children}</>;
  }

  if (location.startsWith("/technician-home")) {
    // Technicians get a dedicated, simplified mobile-first shell — no sidebar.
    return <>{children}</>;
  }

  if (location.startsWith("/qr/")) {
    // QR scan destination — opens straight into a mobile-first job view,
    // not the desktop sidebar, since it's meant to be scanned on a phone.
    return <>{children}</>;
  }

  if (location.startsWith("/materials")) {
    // Reached from the Materials button on the technician's simplified
    // home screen — keeps that same mobile-first feel instead of suddenly
    // dropping into the full desktop sidebar shell.
    return <>{children}</>;
  }

  // Technicians land on their simplified mobile view instead of the full
  // desktop dashboard/sidebar — they only need Today's Jobs, Clock In/Out,
  // photo upload, and Calendar, and mostly use this on their phone.
  if (user?.role === "technician" && location === "/") {
    navigate("/technician-home");
    return null;
  }

  const role = (user?.role || "technician") as Role;
  const visibleNavItems = NAV_ITEMS.filter((item) => item.roles.includes(role) && !item.hidden);
  const pageAllowed = isPathAllowed(location, role);

  return (
    <div className="flex min-h-screen bg-surface-muted">
      {/* Sidebar */}
      <aside className="fixed inset-y-0 left-0 z-20 flex w-60 flex-col bg-navy text-white">
        <Link href="/">
          <a className="flex h-16 items-center gap-2 px-5 hover:bg-white/5">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-white/10">
              <BoatologyLogo variant="emblem" light className="h-5 w-5" />
            </div>
            <span className="text-sm font-semibold tracking-wide">{companyNameQuery.data?.name || "Boatology"}</span>
          </a>
        </Link>
        <nav className="flex-1 space-y-0.5 px-3 py-4">
          {visibleNavItems.map((item) => {
            const active = item.href === "/" ? location === "/" : location.startsWith(item.href);
            const Icon = item.icon;
            return (
              <Link key={item.href} href={item.href}>
                <a
                  className={`flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors ${
                    active
                      ? "bg-white/10 font-medium text-white"
                      : "text-white/70 hover:bg-white/5 hover:text-white"
                  }`}
                >
                  <Icon className="h-4 w-4 shrink-0" />
                  {item.label}
                </a>
              </Link>
            );
          })}
        </nav>
      </aside>

      {/* Main column */}
      <div className="flex flex-1 flex-col pl-60">
        {/* Top bar */}
        <header className="sticky top-0 z-10 flex h-16 items-center justify-between border-b border-border bg-white px-6">
          <GlobalSearch />
          <div className="flex items-center gap-4">
            <NotificationsBell />
            <div className="relative">
              <button
                onClick={() => setMenuOpen((v) => !v)}
                className="flex items-center gap-2 rounded-lg px-2 py-1.5 hover:bg-surface-muted"
              >
                <div className="flex h-8 w-8 items-center justify-center rounded-full bg-navy text-xs font-semibold text-white">
                  {(user?.name || "U").slice(0, 1).toUpperCase()}
                </div>
                <div className="text-left leading-tight">
                  <div className="text-sm font-medium text-navy">{user?.name || "User"}</div>
                  <div className="text-xs text-ink-light">
                    {user?.role ? ROLE_LABELS[user.role] : ""}
                  </div>
                </div>
                <ChevronDown className="h-4 w-4 text-ink-light" />
              </button>
              {menuOpen && (
                <div className="absolute right-0 top-full mt-2 w-44 rounded-lg border border-border bg-white py-1 shadow-cardHover">
                  <button
                    onClick={logout}
                    className="flex w-full items-center gap-2 px-3 py-2 text-sm text-ink hover:bg-surface-muted"
                  >
                    <LogOut className="h-4 w-4" />
                    Sign out
                  </button>
                </div>
              )}
            </div>
          </div>
        </header>

        <main className="flex-1">
          {pageAllowed ? (
            children
          ) : (
            <div className="flex min-h-[60vh] flex-col items-center justify-center gap-3 text-center">
              <ShieldAlert className="h-10 w-10 text-ink-light" />
              <h1 className="text-xl font-semibold text-navy">Access restricted</h1>
              <p className="max-w-sm text-sm text-ink-light">
                Your account ({ROLE_LABELS[role]}) doesn't have access to this page.
              </p>
            </div>
          )}
        </main>
      </div>
    </div>
  );
}

function GlobalSearch() {
  const [, navigate] = useLocation();
  const [query, setQuery] = useState("");
  const [isOpen, setIsOpen] = useState(false);

  const customersQuery = trpc.customers.list.useQuery(undefined, { enabled: query.length > 1 });
  const vesselsQuery = trpc.vessels.list.useQuery(undefined, { enabled: query.length > 1 });
  const jobsQuery = trpc.jobs.list.useQuery(undefined, { enabled: query.length > 1 });

  const q = query.trim().toLowerCase();

  const matchedCustomers =
    q.length > 1 ? (customersQuery.data || []).filter((c: any) => c.name?.toLowerCase().includes(q)).slice(0, 5) : [];
  const matchedVessels =
    q.length > 1 ? (vesselsQuery.data || []).filter((v: any) => v.name?.toLowerCase().includes(q)).slice(0, 5) : [];
  const matchedJobs =
    q.length > 1
      ? (jobsQuery.data || [])
          .filter(
            (j: any) =>
              j.jobNumber?.toLowerCase().includes(q) || j.description?.toLowerCase().includes(q)
          )
          .slice(0, 5)
      : [];

  const hasResults = matchedCustomers.length > 0 || matchedVessels.length > 0 || matchedJobs.length > 0;

  const goTo = (path: string) => {
    navigate(path);
    setQuery("");
    setIsOpen(false);
  };

  return (
    <div className="relative w-full max-w-md">
      <div className="flex items-center gap-2 rounded-lg border border-border bg-surface-muted px-3 py-2">
        <Search className="h-4 w-4 shrink-0 text-ink-light" />
        <input
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setIsOpen(true);
          }}
          onFocus={() => setIsOpen(true)}
          onBlur={() => setTimeout(() => setIsOpen(false), 150)}
          placeholder="Search customers, vessels, jobs..."
          className="w-full bg-transparent text-sm outline-none placeholder:text-ink-light"
        />
      </div>

      {isOpen && q.length > 1 && (
        <div className="absolute left-0 right-0 top-full z-20 mt-1 max-h-96 overflow-y-auto rounded-lg border border-border bg-white py-1 shadow-cardHover">
          {!hasResults ? (
            <p className="px-3 py-3 text-sm text-ink-light">No matches for "{query}"</p>
          ) : (
            <>
              {matchedCustomers.length > 0 && (
                <div>
                  <p className="px-3 pt-2 text-xs font-medium uppercase tracking-wide text-ink-light">
                    Customers
                  </p>
                  {matchedCustomers.map((c: any) => (
                    <button
                      key={`c-${c.id}`}
                      className="block w-full px-3 py-2 text-left text-sm text-ink hover:bg-surface-muted"
                      onMouseDown={() => goTo(`/customers/${c.id}`)}
                    >
                      {c.name}
                    </button>
                  ))}
                </div>
              )}
              {matchedVessels.length > 0 && (
                <div>
                  <p className="px-3 pt-2 text-xs font-medium uppercase tracking-wide text-ink-light">
                    Vessels
                  </p>
                  {matchedVessels.map((v: any) => (
                    <button
                      key={`v-${v.id}`}
                      className="block w-full px-3 py-2 text-left text-sm text-ink hover:bg-surface-muted"
                      onMouseDown={() => goTo(`/vessels/${v.id}`)}
                    >
                      {v.name}
                    </button>
                  ))}
                </div>
              )}
              {matchedJobs.length > 0 && (
                <div>
                  <p className="px-3 pt-2 text-xs font-medium uppercase tracking-wide text-ink-light">
                    Jobs
                  </p>
                  {matchedJobs.map((j: any) => (
                    <button
                      key={`j-${j.id}`}
                      className="block w-full px-3 py-2 text-left text-sm text-ink hover:bg-surface-muted"
                      onMouseDown={() => goTo(`/jobs/${j.id}`)}
                    >
                      {j.jobNumber} — {j.description || "No description"}
                    </button>
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

function NotificationsBell() {
  const [isOpen, setIsOpen] = useState(false);
  const notificationsQuery = trpc.notifications.list.useQuery(undefined, { refetchInterval: 30000 });
  const utils = trpc.useUtils();

  const markReadMutation = trpc.notifications.markRead.useMutation({
    onSuccess: () => utils.notifications.list.invalidate(),
  });

  const notifications = notificationsQuery.data || [];
  const unreadCount = notifications.filter((n: any) => !n.isRead).length;

  return (
    <div className="relative">
      <button
        onClick={() => setIsOpen((v) => !v)}
        className="relative rounded-lg p-2 text-ink-light hover:bg-surface-muted"
      >
        <Bell className="h-5 w-5" />
        {unreadCount > 0 && (
          <span className="absolute right-1 top-1 flex h-4 w-4 items-center justify-center rounded-full bg-danger text-[10px] font-bold text-white">
            {unreadCount > 9 ? "9+" : unreadCount}
          </span>
        )}
      </button>

      {isOpen && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setIsOpen(false)} />
          <div className="absolute right-0 top-full z-20 mt-2 w-80 rounded-lg border border-border bg-white py-2 shadow-cardHover">
            <div className="border-b border-border px-4 py-2">
              <p className="text-sm font-semibold text-navy">Notifications</p>
            </div>
            <div className="max-h-96 overflow-y-auto">
              {notifications.length === 0 ? (
                <p className="px-4 py-6 text-center text-sm text-ink-light">No notifications yet.</p>
              ) : (
                notifications.map((n: any) => (
                  <button
                    key={n.id}
                    onClick={() => !n.isRead && markReadMutation.mutate({ id: n.id })}
                    className={`block w-full border-b border-border/50 px-4 py-3 text-left last:border-0 hover:bg-surface-muted ${
                      !n.isRead ? "bg-ocean-50" : ""
                    }`}
                  >
                    <p className="text-sm font-medium text-ink">{n.title}</p>
                    {n.message && <p className="mt-0.5 text-xs text-ink-light">{n.message}</p>}
                    <p className="mt-1 text-[10px] text-ink-light">
                      {new Date(n.createdAt).toLocaleString()}
                    </p>
                  </button>
                ))
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
