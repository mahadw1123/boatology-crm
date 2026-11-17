import { TRPCError } from "@trpc/server";
import { protectedProcedure, staffProcedure, adminOrManagementProcedure, router } from "../_core/trpc";
import * as db from "../db";
import { getXeroRevenueSummary } from "../_core/xero";
import { getWeatherForecast } from "../_core/weather";

// ============================================================================
// ANALYTICS ROUTER
// ============================================================================

export const analyticsRouter = router({
  quoteStats: staffProcedure.query(async ({ ctx }) => {
    try {
      return await db.getQuoteStats();
    } catch (error) {
      console.error("Error fetching quote stats:", error);
      throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    }
  }),

  jobStats: staffProcedure.query(async ({ ctx }) => {
    try {
      return await db.getJobStats();
    } catch (error) {
      console.error("Error fetching job stats:", error);
      throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    }
  }),

  labourStats: staffProcedure.query(async ({ ctx }) => {
    return await db.getLabourStats();
  }),

  revenueStats: staffProcedure.query(async ({ ctx }) => {
    return await db.getRevenueStats();
  }),

  xeroRevenue: staffProcedure.query(async ({ ctx }) => {
    try {
      return await getXeroRevenueSummary();
    } catch (error) {
      console.error("Error fetching Xero revenue:", error);
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: "Xero revenue could not be loaded. Open Administration → Xero, reconnect if needed, then return to Analytics and refresh.",
      });
    }
  }),

  myWeeklyStats: protectedProcedure.query(async ({ ctx }) => {
    if (!ctx.user.employeeId) return null;
    try {
      const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
      const [weekEntries, allJobs, allAssignments] = await Promise.all([
        db.getWeeklyTimeEntries(weekAgo),
        db.getJobs(),
        db.getAllJobAssignments(),
      ]);

      const entries = weekEntries.filter((e) => e.employeeId === ctx.user.employeeId && !e.isInternalCost);
      const hoursThisWeek = Math.round(entries.reduce((sum, e) => sum + (e.hoursWorked || 0), 0) * 100) / 100;

      const assignedJobIds = new Set(
        allAssignments.filter((a) => a.employeeId === ctx.user.employeeId).map((a) => a.jobId)
      );
      const jobsCompletedThisWeek = allJobs.filter(
        (j) =>
          assignedJobIds.has(j.id) &&
          (j.status === "completed" || j.status === "closed") &&
          j.completedAt &&
          j.completedAt >= weekAgo
      ).length;

      return { hoursThisWeek, jobsCompletedThisWeek };
    } catch (error) {
      console.error("Error computing personal weekly stats:", error);
      throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    }
  }),

  weeklyProductivity: staffProcedure.query(async ({ ctx }) => {
    try {
      const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
      const [employeeList, weekEntries, allJobs, allAssignments] = await Promise.all([
        db.getEmployees(),
        db.getWeeklyTimeEntries(weekAgo),
        db.getJobs(),
        db.getAllJobAssignments(),
      ]);

      return employeeList.map((emp) => {
        const entries = weekEntries.filter((e) => e.employeeId === emp.id);
        const hoursThisWeek = Math.round(entries.reduce((sum, e) => sum + (e.hoursWorked || 0), 0) * 100) / 100;

        const assignedJobIds = new Set(allAssignments.filter((a) => a.employeeId === emp.id).map((a) => a.jobId));
        const jobsCompletedThisWeek = allJobs.filter(
          (j) =>
            assignedJobIds.has(j.id) &&
            (j.status === "completed" || j.status === "closed") &&
            j.completedAt &&
            j.completedAt >= weekAgo
        ).length;

        return {
          employeeId: emp.id,
          name: emp.name,
          role: emp.role,
          hoursThisWeek,
          jobsCompletedThisWeek,
        };
      });
    } catch (error) {
      console.error("Error computing weekly productivity:", error);
      throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    }
  }),

  weatherForecast: protectedProcedure.query(async () => {
    try {
      return await getWeatherForecast();
    } catch (error) {
      console.error("Error fetching weather forecast:", error);
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: "The weather forecast is temporarily unavailable. Continue without it and refresh the Dashboard later.",
      });
    }
  }),

  jobCompletion: staffProcedure.query(async ({ ctx }) => {
    try {
      return await db.getJobCompletionStats();
    } catch (error) {
      console.error("Error computing job completion stats:", error);
      throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    }
  }),

  customerPaymentStatus: staffProcedure.query(async ({ ctx }) => {
    try {
      return await db.getCustomerPaymentStatus();
    } catch (error) {
      console.error("Error computing customer payment status:", error);
      throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    }
  }),

  weeklyOperationsSummary: staffProcedure.query(async ({ ctx }) => {
    try {
      const weekAgoStr = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
      const todayStr = new Date().toISOString().slice(0, 10);

      const [jobs, quotes, invoices, inventory, materialReqs, employees, assignments] =
        await Promise.all([
          db.getJobs(),
          db.getQuotes(),
          db.getAllInvoices(),
          db.getInventoryItems(),
          db.getMaterialRequests(),
          db.getEmployees("technician"),
          db.getAllJobAssignments(),
        ]);

      const jobsCompletedThisWeek = jobs.filter(
        (j) => (j.status === "completed" || j.status === "closed") && j.completedAt && j.completedAt.slice(0, 10) >= weekAgoStr
      ).length;
      const jobsOverdue = jobs.filter((j) => j.dueDate && j.dueDate < todayStr && j.status !== "completed" && j.status !== "closed").length;
      const quotesAwaitingApproval = quotes.filter((q) => q.status === "sent").length;

      const depositInvoices = invoices.filter((i) => i.invoiceType === "deposit" && i.status === "sent");
      const depositsOutstandingCount = depositInvoices.length;
      const depositsOutstandingAmount = depositInvoices.reduce((sum, i) => sum + Math.max(0, i.totalDue - (i.refundedAmount || 0)), 0);

      const draftInvoices = invoices.filter((i) => i.status === "draft");
      const draftInvoicesCount = draftInvoices.length;
      const draftInvoicesAmount = draftInvoices.reduce((sum, i) => sum + i.totalDue, 0);
      const unpaidInvoices = invoices.filter((i) => i.status === "sent" && i.invoiceType !== "deposit");
      const invoicesOutstandingCount = unpaidInvoices.length;
      const invoicesOutstandingAmount = unpaidInvoices.reduce((sum, i) => sum + Math.max(0, i.totalDue - (i.refundedAmount || 0)), 0);

      const stockShortages = inventory.filter((i) => i.currentStock <= i.minimumStock).length;
      const materialRequestsAwaitingApproval = materialReqs.filter((r) => r.status === "pending").length;

      const jobCountByEmployee = new Map<number, number>();
      for (const a of assignments) {
        jobCountByEmployee.set(a.employeeId, (jobCountByEmployee.get(a.employeeId) || 0) + 1);
      }
      // Only a started, unfinished entry means "clocked in" — a manual entry
      // with hours but no clock times is not someone currently on the clock.
      const activeEmployeeIds = new Set(db.getClockedInEmployeeIds());

      const technicianWorkload = employees
        .map((e) => ({ name: e.name, activeJobs: jobCountByEmployee.get(e.id) || 0, currentlyClockedIn: activeEmployeeIds.has(e.id) }))
        .sort((a, b) => b.activeJobs - a.activeJobs);
      const techniciansAvailable = employees.length - activeEmployeeIds.size;

      const revenueThisWeek = invoices
        .filter((i) => (i.status === "paid" || i.status === "partially_refunded") && i.paidAt && i.paidAt.slice(0, 10) >= weekAgoStr)
        .reduce((sum, i) => sum + Math.max(0, i.totalDue - (i.refundedAmount || 0)), 0);

      // Projected: the 70%+ still expected on jobs that only have a deposit
      // invoiced so far, plus any invoices already sent but unpaid. Deposits
      // themselves are deliberately NOT added again here — they're already
      // their own dedicated stat above.
      const finalInvoicedQuoteIds = new Set(
        invoices.filter((i) => i.invoiceType === "final" && i.quoteId).map((i) => i.quoteId)
      );
      const acceptedNoFinalYet = quotes.filter((q) => q.status === "accepted" && !finalInvoicedQuoteIds.has(q.id));
      const depositByQuoteId = new Map<number, (typeof invoices)[number]>();
      for (const i of invoices) {
        if (i.invoiceType === "deposit" && i.quoteId != null && !depositByQuoteId.has(i.quoteId)) depositByQuoteId.set(i.quoteId, i);
      }
      let remainingPipeline = 0;
      for (const q of acceptedNoFinalYet) {
        const depositForThisQuote = depositByQuoteId.get(q.id);
        const depositAmount = depositForThisQuote ? depositForThisQuote.totalDue : 0;
        remainingPipeline += Math.max(0, (q.totalAmount || 0) - depositAmount);
      }
      const projectedRevenue = invoicesOutstandingAmount + remainingPipeline;

      return {
        jobsCompletedThisWeek,
        jobsOverdue,
        quotesAwaitingApproval,
        depositsOutstandingCount,
        depositsOutstandingAmount,
        invoicesOutstandingCount,
        invoicesOutstandingAmount,
        draftInvoicesCount,
        draftInvoicesAmount,
        stockShortages,
        materialRequestsAwaitingApproval,
        technicianWorkload,
        techniciansAvailable,
        revenueThisWeek,
        projectedRevenue,
      };
    } catch (error) {
      console.error("Error computing weekly operations summary:", error);
      throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    }
  }),

  businessHealth: adminOrManagementProcedure.query(async ({ ctx }) => {
    try {
      const todayStr = new Date().toISOString().slice(0, 10);
      const weekAgoStr = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);

      const [jobs, quotes, invoices, inventory, materialReqs, employees, assignments, allJobCosts] =
        await Promise.all([
          db.getJobs(),
          db.getQuotes(),
          db.getAllInvoices(),
          db.getInventoryItems(),
          db.getMaterialRequests(),
          db.getEmployees("technician"),
          db.getAllJobAssignments(),
          db.getAllJobCosts(),
        ]);

      const activeJobs = jobs.filter((j) => j.status !== "completed" && j.status !== "closed");
      const assignedJobIds = new Set(assignments.map((a) => a.jobId));
      const jobsAwaitingAssignment = activeJobs.filter((j) => !assignedJobIds.has(j.id));
      const jobsOverdue = activeJobs.filter((j) => j.dueDate && j.dueDate < todayStr);

      const quotesPending = quotes.filter((q) => q.status === "sent").length;
      const depositsOutstanding = invoices.filter((i) => i.invoiceType === "deposit" && !["paid", "void", "refunded"].includes(i.status));
      const finalInvoicesAwaitingPayment = invoices.filter(
        (i) => !["paid", "void", "refunded"].includes(i.status) && i.invoiceType !== "deposit"
      );
      const stockBelowMinimum = inventory.filter((i) => i.currentStock <= i.minimumStock);
      const purchaseOrdersPending = materialReqs.filter((r) => r.status === "pending");

      // Only a started, unfinished entry means "clocked in" — a manual entry
      // with hours but no clock times is not someone currently on the clock.
      const activeEmployeeIds = new Set(db.getClockedInEmployeeIds());
      const workshopUtilization = employees.length > 0 ? Math.round((activeEmployeeIds.size / employees.length) * 100) : 0;

      // Gross profit across every active job, reusing the exact same
      // per-job calculation already built and tested for Job Costs (1.2).
      const costsByJob = new Map<number, number>();
      for (const c of allJobCosts) costsByJob.set(c.jobId, (costsByJob.get(c.jobId) || 0) + c.totalCost);

      let totalGrossProfit = 0;
      const jobProfitability: { jobId: number; jobNumber: string; revenue: number; cost: number; grossProfit: number }[] = [];
      for (const job of activeJobs) {
        const invoice = invoices.find((i) => i.jobId === job.id);
        let revenue = invoice ? invoice.subtotal : 0;
        if (!invoice && job.quoteId) {
          const quote = quotes.find((q) => q.id === job.quoteId);
          revenue = quote?.totalAmount || 0;
        }
        const cost = costsByJob.get(job.id) || 0;
        const gp = revenue - cost;
        totalGrossProfit += gp;
        if (revenue > 0 || cost > 0) {
          jobProfitability.push({ jobId: job.id, jobNumber: job.jobNumber || `#${job.id}`, revenue, cost, grossProfit: gp });
        }
      }
      jobProfitability.sort((a, b) => a.grossProfit - b.grossProfit); // worst first — the ones that need attention

      const revenueThisWeek = invoices
        .filter((i) => (i.status === "paid" || i.status === "partially_refunded") && i.paidAt && i.paidAt.slice(0, 10) >= weekAgoStr)
        .reduce((sum, i) => sum + Math.max(0, i.totalDue - (i.refundedAmount || 0)), 0);
      const costsThisWeek = allJobCosts
        .filter((c) => c.createdAt.slice(0, 10) >= weekAgoStr)
        .reduce((sum, c) => sum + c.totalCost, 0);
      const weeklyCashFlow = revenueThisWeek - costsThisWeek;

      // Real, rule-based bottleneck detection — not vague AI-sounding
      // claims, specific conditions checked against real numbers.
      const bottlenecks: string[] = [];
      const jobsInLoss = jobProfitability.filter((j) => j.grossProfit < 0);
      if (jobsInLoss.length > 0) {
        bottlenecks.push(`${jobsInLoss.length} active job(s) are currently running at a loss — costs exceed the agreed price.`);
      }
      if (workshopUtilization >= 90 && jobsOverdue.length > 0) {
        bottlenecks.push(`Technicians are at ${workshopUtilization}% utilization with ${jobsOverdue.length} job(s) overdue — capacity may be the constraint.`);
      }
      if (stockBelowMinimum.length > 0 && purchaseOrdersPending.length > 0) {
        bottlenecks.push(`${stockBelowMinimum.length} item(s) below minimum stock with ${purchaseOrdersPending.length} order(s) still awaiting approval — material availability may be blocking work.`);
      }
      if (jobsAwaitingAssignment.length > 0) {
        bottlenecks.push(`${jobsAwaitingAssignment.length} active job(s) have no technician assigned yet.`);
      }

      return {
        jobsAwaitingAssignment: jobsAwaitingAssignment.length,
        jobsOverdue: jobsOverdue.length,
        quotesPending,
        depositsOutstandingCount: depositsOutstanding.length,
        depositsOutstandingAmount: depositsOutstanding.reduce((s, i) => s + i.totalDue, 0),
        finalInvoicesAwaitingPaymentCount: finalInvoicesAwaitingPayment.length,
        finalInvoicesAwaitingPaymentAmount: finalInvoicesAwaitingPayment.reduce((s, i) => s + i.totalDue, 0),
        stockBelowMinimum: stockBelowMinimum.length,
        purchaseOrdersPending: purchaseOrdersPending.length,
        workshopUtilization,
        totalGrossProfit,
        jobProfitability: jobProfitability.slice(0, 5), // worst 5 — the ones worth looking at
        weeklyCashFlow,
        revenueThisWeek,
        costsThisWeek,
        bottlenecks,
      };
    } catch (error) {
      console.error("Error computing business health:", error);
      throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    }
  }),
});
