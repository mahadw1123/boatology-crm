// The API surface: one router per area of the CRM, each in server/routers/.
// Add a new area by creating its file there and registering it below.
import { router } from "./_core/trpc";
import { authRouter } from "./routers/auth";
import { customersRouter } from "./routers/customers";
import { vesselsRouter } from "./routers/vessels";
import { quotesRouter } from "./routers/quotes";
import { jobsRouter } from "./routers/jobs";
import { employeesRouter } from "./routers/employees";
import { timeEntriesRouter } from "./routers/timeEntries";
import { schedulesRouter } from "./routers/schedules";
import { antifoulingRouter } from "./routers/antifouling";
import { materialRequestsRouter } from "./routers/materialRequests";
import { inventoryRouter } from "./routers/inventory";
import { tasksRouter } from "./routers/tasks";
import { jobCostsRouter } from "./routers/jobCosts";
import { businessExpensesRouter } from "./routers/businessExpenses";
import { customerMessagesRouter } from "./routers/customerMessages";
import { reportsRouter } from "./routers/reports";
import { staffTasksRouter } from "./routers/staffTasks";
import { suppliersRouter } from "./routers/suppliers";
import { jobSignaturesRouter } from "./routers/jobSignatures";
import { jobMapRouter } from "./routers/jobMap";
import { timelineRouter } from "./routers/timeline";
import { agendaRouter } from "./routers/agenda";
import { jobPlanRouter } from "./routers/jobPlan";
import { notificationsRouter } from "./routers/notifications";
import { calendarNotesRouter } from "./routers/calendarNotes";
import { invoicesRouter } from "./routers/invoices";
import { documentsRouter } from "./routers/documents";
import { analyticsRouter } from "./routers/analytics";
import { administrationRouter } from "./routers/administration";
import { importsRouter } from "./routers/imports";
import { predictionsRouter } from "./routers/predictions";
import { assistantRouter } from "./routers/assistant";

export const appRouter = router({
  auth: authRouter,
  customers: customersRouter,
  vessels: vesselsRouter,
  quotes: quotesRouter,
  jobs: jobsRouter,
  employees: employeesRouter,
  timeEntries: timeEntriesRouter,
  schedules: schedulesRouter,
  documents: documentsRouter,
  analytics: analyticsRouter,
  administration: administrationRouter,
  predictions: predictionsRouter,
  calendarNotes: calendarNotesRouter,
  notifications: notificationsRouter,
  jobPlan: jobPlanRouter,
  agenda: agendaRouter,
  timeline: timelineRouter,
  jobMap: jobMapRouter,
  jobSignatures: jobSignaturesRouter,
  suppliers: suppliersRouter,
  staffTasks: staffTasksRouter,
  reports: reportsRouter,
  jobCosts: jobCostsRouter,
  businessExpenses: businessExpensesRouter,
  customerMessages: customerMessagesRouter,
  tasks: tasksRouter,
  inventory: inventoryRouter,
  materialRequests: materialRequestsRouter,
  antifouling: antifoulingRouter,
  invoices: invoicesRouter,
  imports: importsRouter,
  assistant: assistantRouter,
});

export type AppRouter = typeof appRouter;
