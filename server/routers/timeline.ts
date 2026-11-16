import { TRPCError } from "@trpc/server";
import { staffProcedure, router } from "../_core/trpc";
import * as db from "../db";

export const timelineRouter = router({
  overview: staffProcedure.query(async ({ ctx }) => {
    try {
      const [jobs, customers, vessels, assignments, employees] = await Promise.all([
        db.getJobs(),
        db.getCustomers(),
        db.getVessels(),
        db.getAllJobAssignments(),
        db.getEmployees(),
      ]);

      const customersById = new Map(customers.map((c) => [c.id, c]));
      const vesselsById = new Map(vessels.map((v) => [v.id, v]));
      const employeesById = new Map(employees.map((e) => [e.id, e]));
      const assignmentsByJob = new Map<number, number[]>();
      for (const a of assignments) {
        const list = assignmentsByJob.get(a.jobId) || [];
        list.push(a.employeeId);
        assignmentsByJob.set(a.jobId, list);
      }

      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const todayStr = today.toISOString().slice(0, 10);
      const tomorrowStr = new Date(today.getTime() + 86400000).toISOString().slice(0, 10);
      const weekEndStr = new Date(today.getTime() + 7 * 86400000).toISOString().slice(0, 10);
      const nextWeekEndStr = new Date(today.getTime() + 14 * 86400000).toISOString().slice(0, 10);

      const buckets: Record<string, any[]> = {
        overdue: [],
        today: [],
        tomorrow: [],
        thisWeek: [],
        nextWeek: [],
        upcoming: [],
      };

      const activeJobs = jobs.filter((j) => j.dueDate && j.status !== "completed" && j.status !== "closed");
      for (const job of activeJobs) {
        const customer = customersById.get(job.customerId);
        const vessel = job.vesselId ? vesselsById.get(job.vesselId) : null;
        const techIds = assignmentsByJob.get(job.id) || [];
        const techNames = techIds.map((id) => employeesById.get(id)?.name).filter(Boolean);

        const event = {
          jobId: job.id,
          jobNumber: job.jobNumber,
          dueDate: job.dueDate,
          customerName: customer?.name || "Unknown",
          vesselName: vessel?.name || null,
          location: vessel?.location || null,
          technicians: techNames,
          priority: job.priority,
          status: job.status,
        };

        const due = job.dueDate!;
        if (due < todayStr) buckets.overdue.push(event);
        else if (due === todayStr) buckets.today.push(event);
        else if (due === tomorrowStr) buckets.tomorrow.push(event);
        else if (due <= weekEndStr) buckets.thisWeek.push(event);
        else if (due <= nextWeekEndStr) buckets.nextWeek.push(event);
        else buckets.upcoming.push(event);
      }

      for (const key of Object.keys(buckets)) {
        buckets[key].sort((a, b) => (a.dueDate || "").localeCompare(b.dueDate || ""));
      }

      return buckets;
    } catch (error) {
      console.error("Error computing operations timeline:", error);
      throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    }
  }),
});
