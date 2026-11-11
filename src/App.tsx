import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import DashboardLayout from "@/components/DashboardLayout";
import { Route, Switch } from "wouter";
import { Suspense } from "react";
import { lazyWithRetry } from "./lib/lazyWithRetry";
import ErrorBoundary from "./components/ErrorBoundary";
import { ThemeProvider } from "./contexts/ThemeContext";

// Every route below is code-split — each page's code only downloads when
// someone actually navigates there, instead of one ~1.7MB bundle loading
// everything (every page, every feature) up front just to show the login
// screen. NotFound stays a normal import since it's the fallback shown
// while other lazy chunks might still be resolving.
import NotFound from "@/pages/NotFound";
const Dashboard = lazyWithRetry(() => import("./pages/Dashboard"));
const Customers = lazyWithRetry(() => import("./pages/Customers"));
const Contacts = lazyWithRetry(() => import("./pages/Contacts"));
const CustomerDetail = lazyWithRetry(() => import("./pages/CustomerDetail"));
const Vessels = lazyWithRetry(() => import("./pages/Vessels"));
const VesselDetail = lazyWithRetry(() => import("./pages/VesselDetail"));
const Quotes = lazyWithRetry(() => import("./pages/Quotes"));
const Invoices = lazyWithRetry(() => import("./pages/Invoices"));
const Inventory = lazyWithRetry(() => import("./pages/Inventory"));
const QRJobView = lazyWithRetry(() => import("./pages/QRJobView"));
const Timeline = lazyWithRetry(() => import("./pages/Timeline"));
const TaskCentre = lazyWithRetry(() => import("./pages/TaskCentre"));
const Reports = lazyWithRetry(() => import("./pages/Reports"));
const JobMap = lazyWithRetry(() => import("./pages/JobMap"));
const QuoteDetail = lazyWithRetry(() => import("./pages/QuoteDetail"));
const Jobs = lazyWithRetry(() => import("./pages/Jobs"));
const JobDetail = lazyWithRetry(() => import("./pages/JobDetail"));
const Employees = lazyWithRetry(() => import("./pages/Employees"));
const TimeTracking = lazyWithRetry(() => import("./pages/TimeTracking"));
const Costs = lazyWithRetry(() => import("./pages/Costs"));
const Calendar = lazyWithRetry(() => import("./pages/Calendar"));
const Documents = lazyWithRetry(() => import("./pages/Documents"));
const CustomerPortal = lazyWithRetry(() => import("./pages/CustomerPortal"));
const Administration = lazyWithRetry(() => import("./pages/Administration"));
const Analytics = lazyWithRetry(() => import("./pages/Analytics"));
const AcceptInvite = lazyWithRetry(() => import("./pages/AcceptInvite"));
const ForgotPassword = lazyWithRetry(() => import("./pages/ForgotPassword"));
const ResetPassword = lazyWithRetry(() => import("./pages/ResetPassword"));
const TechnicianHome = lazyWithRetry(() => import("./pages/TechnicianHome"));
const Materials = lazyWithRetry(() => import("./pages/Materials"));
const DataImport = lazyWithRetry(() => import("./pages/DataImport"));

function RouteLoadingFallback() {
  // Shown briefly inside the existing layout (sidebar/header stay put)
  // while a page's own chunk downloads — not a full-page blank/spinner.
  return (
    <div className="flex h-64 items-center justify-center">
      <div className="h-8 w-8 animate-spin rounded-full border-2 border-slate-200 border-t-navy" />
    </div>
  );
}

function Router() {
  return (
    <Suspense fallback={<RouteLoadingFallback />}>
      <Switch>
        <Route path="/accept-invite" component={AcceptInvite} />
        <Route path="/forgot-password" component={ForgotPassword} />
        <Route path="/reset-password" component={ResetPassword} />
        <Route path="/technician-home" component={TechnicianHome} />
        <Route path="/" component={Dashboard} />
        <Route path="/customers" component={Customers} />
        <Route path="/contacts" component={Contacts} />
        <Route path="/customers/:id" component={CustomerDetail} />
        <Route path="/vessels" component={Vessels} />
        <Route path="/vessels/:id" component={VesselDetail} />
        <Route path="/quotes" component={Quotes} />
        <Route path="/invoices" component={Invoices} />
        <Route path="/inventory" component={Inventory} />
        <Route path="/qr/:jobId" component={QRJobView} />
        <Route path="/timeline" component={Timeline} />
        <Route path="/task-centre" component={TaskCentre} />
        <Route path="/reports" component={Reports} />
        <Route path="/job-map" component={JobMap} />
        <Route path="/quotes/:id" component={QuoteDetail} />
        <Route path="/jobs" component={Jobs} />
        <Route path="/jobs/:id" component={JobDetail} />
        <Route path="/employees" component={Employees} />
        <Route path="/time-tracking" component={TimeTracking} />
        <Route path="/costs" component={Costs} />
        <Route path="/calendar" component={Calendar} />
        <Route path="/documents" component={Documents} />
        <Route path="/customer-portal" component={CustomerPortal} />
        <Route path="/administration" component={Administration} />
        <Route path="/analytics" component={Analytics} />
        <Route path="/materials" component={Materials} />
        <Route path="/data-import" component={DataImport} />
        <Route path={"/404"} component={NotFound} />
        {/* Final fallback route */}
        <Route component={NotFound} />
      </Switch>
    </Suspense>
  );
}

function App() {
  return (
    <ErrorBoundary>
      <ThemeProvider defaultTheme="light">
        <TooltipProvider>
          <Toaster />
          <DashboardLayout>
            <Router />
          </DashboardLayout>
        </TooltipProvider>
      </ThemeProvider>
    </ErrorBoundary>
  );
}

export default App;
