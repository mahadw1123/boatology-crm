import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import DashboardLayout from "@/components/DashboardLayout";
import { Route, Switch } from "wouter";
import { Suspense, lazy } from "react";
import ErrorBoundary from "./components/ErrorBoundary";
import { ThemeProvider } from "./contexts/ThemeContext";

// Every route below is code-split — each page's code only downloads when
// someone actually navigates there, instead of one ~1.7MB bundle loading
// everything (every page, every feature) up front just to show the login
// screen. NotFound stays a normal import since it's the fallback shown
// while other lazy chunks might still be resolving.
import NotFound from "@/pages/NotFound";
const Dashboard = lazy(() => import("./pages/Dashboard"));
const Customers = lazy(() => import("./pages/Customers"));
const Contacts = lazy(() => import("./pages/Contacts"));
const CustomerDetail = lazy(() => import("./pages/CustomerDetail"));
const Vessels = lazy(() => import("./pages/Vessels"));
const VesselDetail = lazy(() => import("./pages/VesselDetail"));
const Quotes = lazy(() => import("./pages/Quotes"));
const Invoices = lazy(() => import("./pages/Invoices"));
const Inventory = lazy(() => import("./pages/Inventory"));
const QRJobView = lazy(() => import("./pages/QRJobView"));
const Timeline = lazy(() => import("./pages/Timeline"));
const TaskCentre = lazy(() => import("./pages/TaskCentre"));
const Reports = lazy(() => import("./pages/Reports"));
const JobMap = lazy(() => import("./pages/JobMap"));
const QuoteDetail = lazy(() => import("./pages/QuoteDetail"));
const Jobs = lazy(() => import("./pages/Jobs"));
const JobDetail = lazy(() => import("./pages/JobDetail"));
const Employees = lazy(() => import("./pages/Employees"));
const TimeTracking = lazy(() => import("./pages/TimeTracking"));
const Costs = lazy(() => import("./pages/Costs"));
const Calendar = lazy(() => import("./pages/Calendar"));
const Documents = lazy(() => import("./pages/Documents"));
const CustomerPortal = lazy(() => import("./pages/CustomerPortal"));
const Administration = lazy(() => import("./pages/Administration"));
const Analytics = lazy(() => import("./pages/Analytics"));
const AcceptInvite = lazy(() => import("./pages/AcceptInvite"));
const ForgotPassword = lazy(() => import("./pages/ForgotPassword"));
const ResetPassword = lazy(() => import("./pages/ResetPassword"));
const TechnicianHome = lazy(() => import("./pages/TechnicianHome"));
const Materials = lazy(() => import("./pages/Materials"));
const DataImport = lazy(() => import("./pages/DataImport"));

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
