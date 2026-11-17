import { TRPCError } from "@trpc/server";
import { staffProcedure, router } from "../_core/trpc";
import * as db from "../db";

export const jobMapRouter = router({
  activeJobs: staffProcedure.query(async ({ ctx }) => {
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

      const jobCards = [];
      for (const job of jobs) {
        if (job.status === "completed" || job.status === "closed") continue;
        const vessel = job.vesselId ? vesselsById.get(job.vesselId) : null;
        const customer = customersById.get(job.customerId);
        const techIds = assignmentsByJob.get(job.id) || [];
        const technicians = techIds
          .map((id) => employeesById.get(id))
          .filter(Boolean)
          .map((e: any) => ({ id: e.id, name: e.name, phone: e.phone }));

        // Jobs without a vessel/coordinates still appear in the list panel
        // (so staff can see and act on them) — they just don't get a pin.
        const hasCoordinates = !!(vessel && vessel.latitude != null && vessel.longitude != null);

        jobCards.push({
          jobId: job.id,
          jobNumber: job.jobNumber,
          latitude: hasCoordinates ? vessel!.latitude : null,
          longitude: hasCoordinates ? vessel!.longitude : null,
          hasCoordinates,
          vesselName: vessel?.name || null,
          marina: vessel?.location || null,
          customerName: customer?.name || "Unknown",
          customerPhone: customer?.phone || null,
          technicians,
          status: job.status,
          priority: job.priority,
          dueDate: job.dueDate,
        });
      }

      return jobCards;
    } catch (error) {
      console.error("Error fetching job map data:", error);
      throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    }
  }),
});
