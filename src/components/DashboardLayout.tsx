import { type ReactNode, useState, useEffect } from "react";
import { Link, useLocation } from "wouter";
import {
  Menu,
  X as CloseIcon,
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
  ChevronDown,
  ChevronLeft,
  ChevronRight,
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
import { HelpAssistant } from "@/components/HelpAssistant";
import { NotificationsBell } from "@/components/NotificationsBell";
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
  // On phones and small tablets the sidebar is a drawer opened from the top bar.
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  useEffect(() => {
    setMobileNavOpen(false);
    setMenuOpen(false);
  }, [location]);
  useEffect(() => {
    if (!mobileNavOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMobileNavOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [mobileNavOpen]);
  // Role redirects happen after render, never during it (navigating while
  // rendering makes React warn and can drop the update).
  const redirectTo =
    !isAuthenticated || isLoading || ["/accept-invite", "/forgot-password", "/reset-password"].some((path) => location.startsWith(path))
      ? null
      : user?.role === "customer" && !location.startsWith("/customer-portal")
        ? "/customer-portal"
        : user?.role === "technician" && location === "/"
          ? "/technician-home"
          : null;
  useEffect(() => {
    if (redirectTo) navigate(redirectTo);
  }, [redirectTo, navigate]);
  // Sidebar collapse is a per-device preference, remembered in the browser.
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return localStorage.getItem("sidebarCollapsed") === "1";
    } catch {
      return false;
    }
  });
  const toggleSidebar = () => {
    setCollapsed((value) => {
      try {
        localStorage.setItem("sidebarCollapsed", value ? "0" : "1");
      } catch {
        // Storage can be unavailable (private windows); the toggle still works.
      }
      return !value;
    });
  };

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
    if (redirectTo) return null;
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

  if (location.startsWith("/calendar") && user?.role === "technician") {
    // Calendar.tsx already renders a reduced, technician-appropriate view
    // internally (no team workload data, no create/edit for non-managers).
    // Without this, a technician clicking Calendar from their simplified
    // home screen would suddenly land in the full desktop admin shell —
    // a sidebar full of mostly-forbidden links they can't use.
    return <>{children}</>;
  }

  // Technicians land on their simplified mobile view instead of the full
  // desktop dashboard/sidebar — they only need Today's Jobs, Clock In/Out,
  // photo upload, and Calendar, and mostly use this on their phone.
  if (redirectTo) return null;

  const role = (user?.role || "technician") as Role;
  const visibleNavItems = NAV_ITEMS.filter((item) => item.roles.includes(role) && !item.hidden);
  const pageAllowed = isPathAllowed(location, role);

  return (
    <div className="flex min-h-screen bg-surface-muted">
      {/* Backdrop behind the drawer on small screens */}
      {mobileNavOpen && (
        <button
          type="button"
          aria-label="Close menu"
          className="fixed inset-0 z-30 bg-navy-950/40 backdrop-blur-sm md:hidden"
          onClick={() => setMobileNavOpen(false)}
        />
      )}

      {/* Sidebar */}
      <aside
        aria-label="Main navigation"
        className={`fixed inset-y-0 left-0 z-40 flex w-64 flex-col bg-navy text-white transition-[width,transform] duration-200 ease-out md:z-20 md:translate-x-0 ${
          collapsed ? "md:w-16" : "md:w-60"
        } ${mobileNavOpen ? "translate-x-0 shadow-sheet" : "-translate-x-full"}`}
      >
        <button
          type="button"
          onClick={() => setMobileNavOpen(false)}
          aria-label="Close menu"
          className="absolute right-3 top-4 flex h-8 w-8 items-center justify-center rounded-full text-white/70 hover:bg-white/10 hover:text-white md:hidden"
        >
          <CloseIcon className="h-4 w-4" />
        </button>
        <button
          type="button"
          onClick={toggleSidebar}
          aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          className="absolute -right-3 top-5 z-30 hidden h-6 w-6 items-center justify-center rounded-full border border-border bg-white text-navy shadow-card hover:bg-surface-muted md:flex"
        >
          {collapsed ? <ChevronRight className="h-3.5 w-3.5" /> : <ChevronLeft className="h-3.5 w-3.5" />}
        </button>
        <Link href="/" title={collapsed ? companyNameQuery.data?.name || "Boatology" : undefined} className={`flex h-16 items-center gap-2 px-5 hover:bg-white/5 ${collapsed ? "md:justify-center md:px-0" : ""}`}>
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-white/10">
            <BoatologyLogo variant="emblem" light className="h-5 w-5" />
          </div>
          <span className={`truncate text-sm font-semibold tracking-wide ${collapsed ? "md:hidden" : ""}`}>{companyNameQuery.data?.name || "Boatology"}</span>
        </Link>
        {/* Items share the available height (capped at h-9), so the whole menu fits without scrolling. */}
        <nav className={`flex min-h-0 flex-1 flex-col gap-px overflow-y-auto px-3 py-2 md:overflow-visible ${collapsed ? "md:px-2" : ""}`}>
          {visibleNavItems.map((item) => {
            // /customers/:id is a Customer Detail page reached from Contacts,
            // not its own nav item (customers/* is hidden — see NAV_ITEMS
            // comment above) — without this, opening a customer record would
            // leave the whole sidebar looking unselected.
            const active =
              item.href === "/"
                ? location === "/"
                : location.startsWith(item.href) || (item.href === "/contacts" && location.startsWith("/customers"));
            const Icon = item.icon;
            return (
              <Link
                key={item.href}
                href={item.href}
                title={collapsed ? item.label : undefined}
                aria-label={item.label}
                aria-current={active ? "page" : undefined}
                className={`flex min-h-9 shrink-0 items-center gap-3 rounded-lg px-3 text-[13px] transition-colors md:min-h-0 md:max-h-9 md:flex-1 md:shrink ${
                  collapsed ? "md:justify-center md:gap-0 md:px-0" : ""
                } ${
                  active
                    ? "bg-white/[0.12] font-medium text-white"
                    : "text-white/70 hover:bg-white/5 hover:text-white"
                }`}
              >
                <Icon className="h-4 w-4 shrink-0" />
                <span className={`truncate ${collapsed ? "md:hidden" : ""}`}>{item.label}</span>
              </Link>
            );
          })}
        </nav>
      </aside>

      {/* Main column */}
      <div className={`flex min-w-0 flex-1 flex-col transition-[padding] duration-200 ${collapsed ? "md:pl-16" : "md:pl-60"}`}>
        {/* Top bar */}
        <header className="sticky top-0 z-10 flex h-14 items-center justify-between gap-3 border-b border-border bg-white/85 px-3 backdrop-blur-md sm:px-6 md:h-16">
          <div className="flex min-w-0 flex-1 items-center gap-2">
            <button
              type="button"
              aria-label="Open menu"
              aria-expanded={mobileNavOpen}
              onClick={() => setMobileNavOpen(true)}
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-navy hover:bg-surface-muted md:hidden"
            >
              <Menu className="h-5 w-5" />
            </button>
            <GlobalSearch canSearchInvoices={role !== "technician"} />
          </div>
          <div className="flex shrink-0 items-center gap-1 sm:gap-3">
            <NotificationsBell
              onOpen={(n) => {
                if (!n.relatedEntityId) return;
                switch (n.relatedEntityType) {
                  case "customer":
                    navigate(`/customers/${n.relatedEntityId}`);
                    break;
                  case "job":
                    navigate(`/jobs/${n.relatedEntityId}`);
                    break;
                  case "quote":
                    navigate(`/quotes/${n.relatedEntityId}`);
                    break;
                  case "invoice":
                    navigate(`/invoices?invoice=${n.relatedEntityId}`);
                    break;
                  default:
                    break;
                }
              }}
            />
            <div className="relative">
              <button
                onClick={() => setMenuOpen((v) => !v)}
                aria-label="Account menu"
                aria-haspopup="menu"
                aria-expanded={menuOpen}
                className="flex items-center gap-2 rounded-lg px-1.5 py-1.5 hover:bg-surface-muted sm:px-2"
              >
                <div className="flex h-8 w-8 items-center justify-center rounded-full bg-navy text-xs font-semibold text-white">
                  {(user?.name || "U").slice(0, 1).toUpperCase()}
                </div>
                <div className="hidden text-left leading-tight sm:block">
                  <div className="text-sm font-medium text-navy">{user?.name || "User"}</div>
                  <div className="text-xs text-ink-light">
                    {user?.role ? ROLE_LABELS[user.role] : ""}
                  </div>
                </div>
                <ChevronDown className="hidden h-4 w-4 text-slate-400 sm:block" />
              </button>
              {menuOpen && (
                <div role="menu" className="enter absolute right-0 top-full mt-2 w-52 rounded-xl border border-border bg-white p-1 shadow-sheet">
                  <div className="border-b border-border px-3 py-2 sm:hidden">
                    <div className="truncate text-sm font-medium text-navy">{user?.name || "User"}</div>
                    <div className="text-xs text-slate-500">{user?.role ? ROLE_LABELS[user.role] : ""}</div>
                  </div>
                  <button
                    onClick={logout}
                    role="menuitem"
                    className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm text-ink hover:bg-surface-muted"
                  >
                    <LogOut className="h-4 w-4" />
                    Sign out
                  </button>
                </div>
              )}
            </div>
          </div>
        </header>

        <main className="flex-1 overflow-x-auto">
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
      <HelpAssistant />
    </div>
  );
}

function GlobalSearch({ canSearchInvoices }: { canSearchInvoices: boolean }) {
  const [, navigate] = useLocation();
  const [query, setQuery] = useState("");
  const [isOpen, setIsOpen] = useState(false);

  const customersQuery = trpc.customers.list.useQuery(undefined, { enabled: query.length > 1 });
  const vesselsQuery = trpc.vessels.list.useQuery(undefined, { enabled: query.length > 1 });
  const jobsQuery = trpc.jobs.list.useQuery(undefined, { enabled: query.length > 1 });
  const quotesQuery = trpc.quotes.list.useQuery(undefined, { enabled: query.length > 1 });
  const invoicesQuery = trpc.invoices.listAll.useQuery(undefined, { enabled: query.length > 1 && canSearchInvoices });

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

  const matchedQuotes =
    q.length > 1 ? (quotesQuery.data || []).filter((qt: any) => qt.quoteNumber?.toLowerCase().includes(q)).slice(0, 5) : [];
  const matchedInvoices =
    q.length > 1 ? (invoicesQuery.data || []).filter((i: any) => i.invoiceNumber?.toLowerCase().includes(q)).slice(0, 5) : [];

  const hasResults =
    matchedCustomers.length > 0 || matchedVessels.length > 0 || matchedJobs.length > 0 || matchedQuotes.length > 0 || matchedInvoices.length > 0;

  const goTo = (path: string) => {
    navigate(path);
    setQuery("");
    setIsOpen(false);
  };

  return (
    <div className="relative w-full max-w-md">
      <div className="flex h-9 items-center gap-2 rounded-lg border border-transparent bg-surface-muted px-3 transition-[border-color,box-shadow,background-color] duration-150 focus-within:border-ocean-600 focus-within:bg-white focus-within:ring-4 focus-within:ring-ocean/25">
        <Search className="h-4 w-4 shrink-0 text-slate-400" />
        <input
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setIsOpen(true);
          }}
          onFocus={() => setIsOpen(true)}
          onBlur={() => setTimeout(() => setIsOpen(false), 150)}
          type="search"
          aria-label="Search customers, vessels, jobs, quotes and invoices"
          placeholder="Search customers, vessels, jobs, quotes, invoices…"
          className="w-full min-w-0 bg-transparent text-sm outline-none placeholder:text-slate-400 [&::-webkit-search-cancel-button]:hidden"
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
              {matchedQuotes.length > 0 && (
                <div className="border-t border-border">
                  <p className="px-3 pt-2 text-xs font-medium uppercase tracking-wide text-ink-light">Quotes</p>
                  {matchedQuotes.map((qt: any) => (
                    <button
                      key={"q-" + qt.id}
                      className="block w-full px-3 py-2 text-left text-sm text-ink hover:bg-surface-muted"
                      onMouseDown={() => goTo("/quotes/" + qt.id)}
                    >
                      {qt.quoteNumber}
                    </button>
                  ))}
                </div>
              )}
              {matchedInvoices.length > 0 && (
                <div className="border-t border-border">
                  <p className="px-3 pt-2 text-xs font-medium uppercase tracking-wide text-ink-light">Invoices</p>
                  {matchedInvoices.map((i: any) => (
                    <button
                      key={"i-" + i.id}
                      className="block w-full px-3 py-2 text-left text-sm text-ink hover:bg-surface-muted"
                      onMouseDown={() => goTo("/invoices?invoice=" + i.id)}
                    >
                      {i.invoiceNumber}
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
