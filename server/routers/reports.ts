import { TRPCError } from "@trpc/server";
import { staffProcedure, router } from "../_core/trpc";
import * as db from "../db";
import { sendEmail, emailTemplates } from "../_core/email";

// ============================================================================
// OPERATIONS TIMELINE ROUTER
// ============================================================================

// ============================================================================
// STAFF TASKS ROUTER (general office to-dos)
// ============================================================================

// ============================================================================
// REPORTS ROUTER (Smart Reports — Morning Briefing)
// ============================================================================

export const reportsRouter = router({
  morningBriefing: staffProcedure.query(async ({ ctx }) => {
    try {
      return await db.getMorningBriefingData();
    } catch (error) {
      console.error("Error generating morning briefing:", error);
      throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    }
  }),

  emailMorningBriefing: staffProcedure.mutation(async ({ ctx }) => {
    try {
      const data = await db.getMorningBriefingData();
      if (ctx.user.email) {
        await sendEmail({
          to: ctx.user.email,
          subject: "{{COMPANY_NAME}} — Morning Briefing",
          html: emailTemplates.morningBriefing(data),
        });
      }
      return { success: true } as const;
    } catch (error) {
      console.error("Error emailing morning briefing:", error);
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: "The briefing could not be emailed. Check email settings under Administration and try again.",
      });
    }
  }),

  endOfDaySummary: staffProcedure.query(async ({ ctx }) => {
    return await db.getEndOfDaySummaryData();
  }),
  weeklyOperationsReport: staffProcedure.query(async ({ ctx }) => {
    return await db.getWeeklyOperationsReportData();
  }),
  outstandingPayments: staffProcedure.query(async ({ ctx }) => {
    return await db.getOutstandingPaymentsData();
  }),
  outstandingQuotes: staffProcedure.query(async ({ ctx }) => {
    return await db.getOutstandingQuotesData();
  }),
  materialRequirements: staffProcedure.query(async ({ ctx }) => {
    return await db.getMaterialRequirementsData();
  }),
  inventoryStatus: staffProcedure.query(async ({ ctx }) => {
    return await db.getInventoryStatusData();
  }),
  upcomingServices: staffProcedure.query(async ({ ctx }) => {
    return await db.getUpcomingServicesData();
  }),
  technicianPerformance: staffProcedure.query(async ({ ctx }) => {
    return await db.getTechnicianPerformanceData();
  }),
  workshopCapacity: staffProcedure.query(async ({ ctx }) => {
    return await db.getWorkshopCapacityData();
  }),
});
