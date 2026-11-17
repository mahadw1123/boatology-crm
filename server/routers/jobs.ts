import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { protectedProcedure, staffProcedure, router } from "../_core/trpc";
import * as db from "../db";
import { emailTemplates } from "../_core/email";
import { getJobEligibility } from "../_core/workflow";
import { hasRole } from "../_core/permissions";
import { ENV } from "../_core/env";
import { isAssignableEmployeeRole, logAudit, logCreateAudit, formatSequenceNumber, nextSequenceFor, requireTechnicianJobAccess, safeDeleteMessage, sendJobEmail, technicianAssignedJobs, technicianIsAssigned } from "./_shared";

function scopedJobView(job: NonNullable<Awaited<ReturnType<typeof db.getJobById>>>) {
  return {
    id: job.id, customerId: job.customerId, vesselId: job.vesselId, jobNumber: job.jobNumber,
    status: job.status, description: job.description, estimatedLaborHours: job.estimatedLaborHours,
    actualLaborHours: job.actualLaborHours, priority: job.priority, dueDate: job.dueDate,
    createdAt: job.createdAt, updatedAt: job.updatedAt, completedAt: job.completedAt,
    additionalWorkRequested: job.additionalWorkRequested, additionalWorkApproved: job.additionalWorkApproved,
    additionalWorkDeclined: job.additionalWorkDeclined, additionalWorkNotes: job.additionalWorkNotes,
    additionalWorkDeclineReason: job.additionalWorkDeclineReason,
  };
}

// Jobs previously got a client-suggested "J-{year}-{random 4 digits}"
// number that staff could freely edit — meaning two jobs created back to
// back could read J-2026-7381 then J-2026-2904, with no way to tell which
// came first from the number alone. Quotes and invoices already generate
// their numbers server-side, sequentially, unedited (see
// createInvoiceWithGeneratedNumber below and quotes' own create mutation)
// — this brings jobs in line with that same convention instead of being
// the one inconsistent case.
async function createJobWithGeneratedNumber(data: Parameters<typeof db.createJob>[0]) {
  const year = new Date().getFullYear();
  for (let attempt = 0; attempt < 20; attempt++) {
    const jobNumber = formatSequenceNumber(`J-${year}-`, nextSequenceFor("job", `J-${year}-`) + attempt);
    try {
      return await db.createJob({ ...data, jobNumber });
    } catch (error: any) {
      const duplicate = error?.message?.includes("UNIQUE constraint failed") && error.message.includes("jobNumber");
      if (!duplicate || attempt === 19) throw error;
    }
  }
  throw new Error("Could not allocate a job number.");
}

// ============================================================================
// JOBS ROUTER
// ============================================================================

const jobStatusEnum = z.enum([
  "inspection",
  "quote",
  "approval",
  "deposit",
  "created",
  "scheduled",
  "in_progress",
  "waiting_customer",
  "waiting_parts",
  "completed",
  "final_invoice",
  "customer_collection",
  "closed",
  "cancelled",
]);

// jobStatusEnum above also carries pre-job-creation stages (inspection,
// quote, approval, deposit) and post-completion accounting stages
// (final_invoice, customer_collection) — kept only so a historical/CSV-
// imported record that predates the current model can still store its
// original label (see the Data Import allowedStatuses list). None of those
// are valid to select on a job that already exists: the pre-job stages
// don't apply once a Job row exists at all, and "cancelled" is deliberately
// excluded too — it has its own dedicated mutation (jobs.cancel) that
// captures a reason and notifies the customer/technician, which setting the
// status directly here would silently skip.
const jobUpdateStatusEnum = z.enum([
  "created",
  "scheduled",
  "in_progress",
  "waiting_customer",
  "waiting_parts",
  "completed",
  "closed",
]);

// Which statuses a job currently in status X may move to next — without
// this, jobs.update accepted any status jump with no validation at all
// (created → closed, completed → scheduled, etc.). A job whose current
// status isn't one of these keys (imported historical data still carrying
// one of the legacy labels above) can move to any real operational status
// once, to bring it into the normal model.
const JOB_STATUS_TRANSITIONS: Record<string, readonly string[]> = {
  created: ["scheduled", "in_progress"],
  scheduled: ["created", "in_progress"],
  in_progress: ["scheduled", "waiting_customer", "waiting_parts", "completed"],
  waiting_customer: ["in_progress"],
  waiting_parts: ["in_progress"],
  // Reopening a completed job is allowed (work turned out not to be done);
  // jobs.update refuses it once a real invoice has been issued.
  completed: ["closed", "in_progress"],
  closed: [],
};

function assertValidJobStatusTransition(from: string, to: string) {
  if (from === to) return;
  const allowed = JOB_STATUS_TRANSITIONS[from];
  if (allowed === undefined) return;
  if (!allowed.includes(to)) {
    const options = allowed.length > 0 ? allowed.join(", ") : "nothing — this job is finished";
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `A job can't move from "${from}" straight to "${to}". From here it can go to: ${options}.`,
    });
  }
}

// Notifies a technician's linked user account, if any — employees created
// purely as a payroll/HR record with no login (`userId` null) simply have
// nothing to notify.
async function notifyTechnicianOfJob(
  employeeId: number,
  type: "job_assigned" | "job_unassigned" | "job_updated" | "job_cancelled",
  title: string,
  message: string,
  jobId: number
) {
  try {
    // Employees and login accounts are linked via users.employeeId, not the
    // other way around — employees has no userId column. Looking that up
    // directly here (the old code checked a field that doesn't exist and
    // so silently never sent a single one of these notifications). There
    // can be more than one login linked to the same employee, so notify
    // all of them rather than an arbitrary first match.
    const technicianUsers = await db.getUsersByEmployeeId(employeeId);
    for (const technicianUser of technicianUsers) {
      await db.createNotification({
        userId: technicianUser.id,
        type,
        title,
        message,
        relatedEntityType: "job",
        relatedEntityId: jobId,
      });
    }
  } catch (error) {
    console.error(`Failed to create ${type} notification:`, error);
  }
}

export const jobsRouter = router({
  myJobs: protectedProcedure.query(async ({ ctx }) => {
    if (!ctx.user.employeeId) return [];
    try {
      return (await db.getJobsForEmployee(ctx.user.employeeId)).map(scopedJobView);
    } catch (error) {
      console.error("Error fetching my jobs:", error);
      throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    }
  }),

  list: protectedProcedure
    .input(z.object({ customerId: z.number().optional(), status: jobStatusEnum.optional() }).optional())
    .query(async ({ input, ctx }) => {
      try {
        if (ctx.user.role === "technician") {
          const assigned = await technicianAssignedJobs(ctx.user.employeeId);
          return assigned.filter((job) =>
            (!input?.customerId || job.customerId === input.customerId) &&
            (!input?.status || job.status === input.status)
          ).map(scopedJobView);
        }
        const scopedCustomerId = ctx.user.role === "customer" ? ctx.user.customerId ?? -1 : input?.customerId;
        const records = await db.getJobs(scopedCustomerId ?? undefined, input?.status);
        return ctx.user.role === "customer" ? records.map(scopedJobView) : records;
      } catch (error) {
        console.error("Error fetching jobs:", error);
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      }
    }),

  getById: protectedProcedure.input(z.number()).query(async ({ input, ctx }) => {
    try {
      const job = await db.getJobById(input);
      if (!job) throw new TRPCError({ code: "NOT_FOUND" });
      if (ctx.user.role === "customer" && ctx.user.customerId !== job.customerId) {
        throw new TRPCError({ code: "FORBIDDEN" });
      }
      if (ctx.user.role === "technician" && !(await technicianIsAssigned(ctx.user.employeeId, job.id))) {
        throw new TRPCError({ code: "FORBIDDEN" });
      }
      if (ctx.user.role === "technician" && ctx.user.employeeId) {
        // Fire-and-forget — clears the "new job assigned, not opened yet"
        // reminder the moment they actually load it, never blocks the page.
        db.markJobAssignmentViewed(job.id, ctx.user.employeeId).catch((error) =>
          console.error("Failed to stamp job assignment view time:", error)
        );
      }
      return ctx.user.role === "customer" || ctx.user.role === "technician" ? scopedJobView(job) : job;
    } catch (error) {
      if (error instanceof TRPCError) throw error;
      console.error("Error fetching job:", error);
      throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    }
  }),

  // Lets the UI show "why can't I create this job yet" before the staff
  // member even opens the create-job form, using the same eligibility
  // rule the create mutation itself enforces — one definition, two callers.
  getEligibility: staffProcedure.input(z.object({ quoteId: z.number() })).query(async ({ input, ctx }) => {
    return await getJobEligibility(input.quoteId);
  }),

  create: staffProcedure
    .input(
      z.object({
        quoteId: z.number().optional(),
        customerId: z.number(),
        vesselId: z.number().optional(),
        description: z.string().max(10000).optional(),
        estimatedLaborHours: z.number().optional(),
        priority: z.enum(["low", "medium", "high", "urgent"]).optional(),
        dueDate: z.string().max(10000).optional(),
        assignedUserId: z.number().nullable().optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {

      // Neither SQLite nor the schema enforces referential integrity here,
      // so this is the only thing standing between a typo/bug and a job
      // permanently orphaned from any real customer.
      const customerExists = await db.getCustomerById(input.customerId);
      if (!customerExists) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "That customer doesn't exist." });
      }
      if (input.vesselId) {
        const vesselExists = await db.getVesselById(input.vesselId);
        if (!vesselExists) {
          throw new TRPCError({ code: "BAD_REQUEST", message: "That vessel doesn't exist." });
        }
        if (vesselExists.customerId !== input.customerId) {
          throw new TRPCError({ code: "BAD_REQUEST", message: "That vessel does not belong to the selected customer." });
        }
      }

      // Mandatory deposit workflow: if this job is tied to a quote, that
      // quote's deposit must be paid before any job can be created against
      // it — prevents work (and cost) starting before payment.
      if (input.quoteId) {
        const quote = await db.getQuoteById(input.quoteId);
        if (!quote) {
          throw new TRPCError({ code: "BAD_REQUEST", message: "That quote doesn't exist." });
        }
        if (quote.customerId !== input.customerId) {
          throw new TRPCError({ code: "BAD_REQUEST", message: "That quote does not belong to the selected customer." });
        }
        if (input.vesselId && quote.vesselId && quote.vesselId !== input.vesselId) {
          throw new TRPCError({ code: "BAD_REQUEST", message: "The selected vessel does not match the quote." });
        }
        const eligibility = await getJobEligibility(input.quoteId);
        if (!eligibility.eligible) {
          throw new TRPCError({ code: "BAD_REQUEST", message: eligibility.reasons.join(" ") });
        }
      }

      try {
        const job = await createJobWithGeneratedNumber(input);
        await logCreateAudit(ctx, "job", job.id);
        const customer = await db.getCustomerById(input.customerId);
        if (customer?.email) {
          await sendJobEmail(
            job.id,
            customer.email,
            `Your Job Has Been Created`,
            emailTemplates.jobCreated(customer.name, job.jobNumber || "", job.dueDate)
          );
        }
        return job;
      } catch (error: any) {
        console.error("Error creating job:", error);
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Failed to create job. Please try again." });
      }
    }),

  update: protectedProcedure
    .input(
      z.object({
        id: z.number(),
        status: jobUpdateStatusEnum.optional(),
        description: z.string().max(10000).optional(),
        priority: z.enum(["low", "medium", "high", "urgent"]).optional(),
        dueDate: z.string().max(10000).optional(),
        estimatedLaborHours: z.number().nonnegative().max(100000).optional(),
        actualLaborHours: z.number().nonnegative().max(100000).optional(),
        quoteId: z.number().nullable().optional(),
        vesselId: z.number().optional(),
        assignedUserId: z.number().nullable().optional(),
        notifyTechnician: z.boolean().default(false),
      })
    )
    .mutation(async ({ input, ctx }) => {
      if (!hasRole(ctx.user.role, "OPERATIONAL")) {
        throw new TRPCError({ code: "FORBIDDEN" });
      }
      try {
        const { id, notifyTechnician, ...data } = input;
        const existingJob = await db.getJobById(id);
        if (!existingJob) throw new TRPCError({ code: "NOT_FOUND", message: "Job not found." });

        if (ctx.user.role === "technician") {
          if (!(await technicianIsAssigned(ctx.user.employeeId, id))) {
            throw new TRPCError({ code: "FORBIDDEN", message: "You can only update jobs assigned to you." });
          }
          if (data.description !== undefined || data.priority !== undefined || data.dueDate !== undefined || data.estimatedLaborHours !== undefined || data.quoteId !== undefined || data.vesselId !== undefined || data.assignedUserId !== undefined) {
            throw new TRPCError({
              code: "FORBIDDEN",
              message: "You can update job progress and actual hours only. Ask office staff to change job details, dates, quotes, or vessels.",
            });
          }
          if (data.status !== undefined && !["scheduled", "in_progress", "waiting_customer", "waiting_parts", "completed"].includes(data.status)) {
            throw new TRPCError({
              code: "FORBIDDEN",
              message: "Technicians cannot move a job into a billing, collection, or closed stage. Mark the work completed, then ask office staff to continue the workflow.",
            });
          }
        }

        if (data.vesselId !== undefined) {
          const vessel = await db.getVesselById(data.vesselId);
          if (!vessel || vessel.customerId !== existingJob.customerId) {
            throw new TRPCError({ code: "BAD_REQUEST", message: "That vessel does not belong to this job's customer." });
          }
        }
        if (data.quoteId !== undefined && data.quoteId !== null && data.quoteId !== existingJob.quoteId) {
          const quote = await db.getQuoteById(data.quoteId);
          if (!quote || quote.customerId !== existingJob.customerId) {
            throw new TRPCError({ code: "BAD_REQUEST", message: "That quote does not belong to this job's customer." });
          }
          // A job was only ever allowed to be created against a quote whose
          // deposit is paid (see jobs.create / getJobEligibility) — changing
          // quoteId on an existing job later must satisfy the exact same
          // rule, or that gate is just a one-time check that can be
          // sidestepped by editing the job afterward instead.
          const eligibility = await getJobEligibility(data.quoteId);
          if (!eligibility.eligible) {
            throw new TRPCError({ code: "BAD_REQUEST", message: eligibility.reasons.join(" ") });
          }
        }
        if (data.status !== undefined) {
          assertValidJobStatusTransition(existingJob.status, data.status);
        }
        let patchCompletedReset = false;
        if (data.status === "completed" && existingJob.status !== "completed") {
          const jobTasks = await db.getTasksForJob(id);
          const openTasks = jobTasks.filter((t) => t.status !== "completed");
          if (openTasks.length > 0) {
            throw new TRPCError({
              code: "BAD_REQUEST",
              message: `This job still has ${openTasks.length} task${openTasks.length === 1 ? "" : "s"} not marked complete. Finish them first, or remove them if they're no longer needed.`,
            });
          }
        }
        if (data.status === "closed") {
          // "Closed" means the job is genuinely finished, including
          // financially — otherwise it's just "completed" with an
          // outstanding invoice waiting to be chased, and closing it would
          // let that invoice quietly stop showing up as work still owed.
          // A job with no invoice at all (no charge) or a void/refunded one
          // isn't blocked — only a real invoice still awaiting payment is.
          const jobInvoice = await db.getInvoiceByJob(id);
          if (jobInvoice && !["paid", "void", "refunded", "reversed"].includes(jobInvoice.status)) {
            throw new TRPCError({
              code: "BAD_REQUEST",
              message: `This job's invoice (${jobInvoice.invoiceNumber}) hasn't been paid yet. Close it once payment is received, or void the invoice first.`,
            });
          }
        }
        if (data.status === "in_progress" && existingJob.status === "completed") {
          const reopenInvoice = await db.getInvoiceByJob(id);
          if (reopenInvoice && !["draft", "void", "reversed"].includes(reopenInvoice.status)) {
            throw new TRPCError({
              code: "BAD_REQUEST",
              message: `This job's invoice (${reopenInvoice.invoiceNumber}) has already been issued, so the job can't be reopened. Void the invoice first if the work genuinely isn't finished.`,
            });
          }
          patchCompletedReset = true;
        }
        const finishedStatuses = ["completed", "final_invoice", "customer_collection", "closed"];
        if (data.status !== undefined && !finishedStatuses.includes(data.status) && finishedStatuses.includes(existingJob.status)) {
          // The job was reverted — the "raise final invoice" to-do no longer applies.
          const { resolveTask } = await import("../_core/taskRules");
          await resolveTask(`JOB_NEEDS_FINAL_INVOICE:${id}`);
        }
        const enteringCompleted = data.status === "completed" && existingJob.status !== "completed";
        const patch: Record<string, unknown> = { ...data };
        if (patchCompletedReset) patch.completedAt = null;
        // Only stamp completedAt the moment a job first becomes completed —
        // closing it afterward (completed → closed is the only way in here)
        // must not overwrite the real completion date with today's date.
        if (enteringCompleted) patch.completedAt = new Date().toISOString();
        // Tracks how long a job has actually been stuck waiting on parts —
        // set the moment it enters that status, cleared the moment it
        // leaves, so "Waiting On Parts Too Long" measures real elapsed
        // time rather than assuming today's update is when it started.
        if (data.status === "waiting_parts" && existingJob.status !== "waiting_parts") {
          patch.waitingPartsSince = new Date().toISOString();
        } else if (data.status !== undefined && data.status !== "waiting_parts" && existingJob.status === "waiting_parts") {
          patch.waitingPartsSince = null;
        }
        await db.updateJob(id, patch);
        const job = await db.getJobById(id);

        if (job && notifyTechnician) {
          const assignments = await db.getJobAssignments(job.id);
          for (const assignment of assignments) {
            await notifyTechnicianOfJob(
              assignment.employeeId,
              "job_updated",
              `Job updated: ${job.jobNumber}`,
              `${ctx.user.name || "A staff member"} updated job ${job.jobNumber}.`,
              job.id
            );
            const employee = await db.getEmployeeById(assignment.employeeId);
            if (employee?.email) {
              await sendJobEmail(
                job.id,
                employee.email,
                `Job ${job.jobNumber} updated`,
                emailTemplates.jobUpdated(job.jobNumber || "", `${ctx.user.name || "A staff member"} updated the details of this job.`)
              );
            }
          }
        }

        if (job && enteringCompleted) {
          const customer = await db.getCustomerById(job.customerId);
          if (customer?.email) {
            await sendJobEmail(job.id, customer.email, `Your Job Has Been Completed`, emailTemplates.jobCompleted(job.jobNumber || ""));
          }

          // Internal visibility — management shouldn't have to check every
          // job individually to know one just wrapped up.
          try {
            const staff = await db.getStaffUsers();
            for (const staffUser of staff) {
              if (staffUser.id === ctx.user.id) continue;
              await db.createNotification({
                userId: staffUser.id,
                type: "job_completed",
                title: `Job completed: ${job.jobNumber}`,
                message: `${customer?.name || "A customer's"} job was marked complete by ${ctx.user.name || "a staff member"}.`,
                relatedEntityType: "job",
                relatedEntityId: job.id,
              });
            }
          } catch (notificationError) {
            console.error("Job was updated, but staff notifications could not be created:", notificationError);
          }
        }

        return job;
      } catch (error) {
        if (error instanceof TRPCError) throw error;
        console.error("Error updating job:", error);
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      }
    }),

  assignTechnician: staffProcedure
    .input(z.object({ jobId: z.number(), employeeId: z.number() }))
    .mutation(async ({ input, ctx }) => {
      try {
        const [job, employee] = await Promise.all([
          db.getJobById(input.jobId),
          db.getEmployeeById(input.employeeId),
        ]);
        if (!job) {
          throw new TRPCError({ code: "NOT_FOUND", message: "That job no longer exists. Return to Jobs and refresh the list." });
        }
        if (!employee) {
          throw new TRPCError({ code: "NOT_FOUND", message: "That employee no longer exists. Return to Administration → Employees and refresh the list." });
        }
        if (!isAssignableEmployeeRole(employee.role) || !employee.isActive) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "Only an active technician or subcontractor can be assigned. Update the employee in Administration → Employees, then try again.",
          });
        }
        const assignment = await db.assignJobToEmployee(input.jobId, input.employeeId);
        await notifyTechnicianOfJob(
          input.employeeId,
          "job_assigned",
          `New job assigned: ${job.jobNumber}`,
          `You've been assigned to job ${job.jobNumber}${job.dueDate ? ` (due ${job.dueDate})` : ""}.`,
          job.id
        );
        return assignment;
      } catch (error) {
        if (error instanceof TRPCError) throw error;
        const message = error instanceof Error && /unique|duplicate/i.test(error.message)
          ? "This technician is already assigned to the job. Refresh the assignment list."
          : "The technician could not be assigned. Refresh the job and try again.";
        console.error("Error assigning technician:", error);
        throw new TRPCError({ code: "CONFLICT", message });
      }
    }),

  // Who is working on each job, for the Jobs list: { [jobId]: ["Name", ...] }.
  technicianNames: staffProcedure.query(async ({ ctx }) => {
    const [assignments, employeeList] = await Promise.all([db.getAllJobAssignments(), db.getEmployees()]);
    const nameById = new Map(employeeList.map((e) => [e.id, e.name]));
    const result: Record<number, string[]> = {};
    for (const a of assignments) {
      const name = nameById.get(a.employeeId);
      if (!name) continue;
      (result[a.jobId] ||= []).push(name);
    }
    return result;
  }),

  getAssignments: protectedProcedure.input(z.number()).query(async ({ input, ctx }) => {
    try {
      if (ctx.user.role === "customer") {
        const job = await db.getJobById(input);
        if (!job || job.customerId !== ctx.user.customerId) throw new TRPCError({ code: "FORBIDDEN" });
      }
      if (ctx.user.role === "technician" && !(await technicianIsAssigned(ctx.user.employeeId, input))) {
        throw new TRPCError({ code: "FORBIDDEN" });
      }
      return await db.getJobAssignmentsWithEmployee(input);
    } catch (error) {
      if (error instanceof TRPCError) throw error;
      console.error("Error fetching job assignments:", error);
      throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    }
  }),

  unassignTechnician: staffProcedure.input(z.object({ assignmentId: z.number() })).mutation(async ({ input, ctx }) => {
    try {
      const assignment = await db.getJobAssignmentById(input.assignmentId);
      await db.unassignJobFromEmployee(input.assignmentId);
      if (assignment) {
        const job = await db.getJobById(assignment.jobId);
        if (job) {
          await notifyTechnicianOfJob(
            assignment.employeeId,
            "job_unassigned",
            `Removed from job: ${job.jobNumber}`,
            `You've been unassigned from job ${job.jobNumber}.`,
            job.id
          );
        }
      }
      return { success: true } as const;
    } catch (error) {
      console.error("Error unassigning technician:", error);
      throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    }
  }),

  // One user-facing action ("reassign") implemented as unassign+assign
  // together so both the outgoing and incoming technician are notified from
  // a single call, rather than requiring the UI to make two separate
  // requests and risk only one notification firing if the second fails.
  reassignTechnician: staffProcedure
    .input(z.object({ jobId: z.number(), fromAssignmentId: z.number().optional(), toEmployeeId: z.number() }))
    .mutation(async ({ input, ctx }) => {
      try {
        const [job, employee] = await Promise.all([
          db.getJobById(input.jobId),
          db.getEmployeeById(input.toEmployeeId),
        ]);
        if (!job) throw new TRPCError({ code: "NOT_FOUND", message: "That job no longer exists." });
        if (!employee || !isAssignableEmployeeRole(employee.role) || !employee.isActive) {
          throw new TRPCError({ code: "BAD_REQUEST", message: "Only an active technician or subcontractor can be assigned." });
        }

        // Checked before anything is removed: otherwise the old assignment
        // was deleted and the new one then failed on the duplicate, leaving
        // the job with one technician fewer and a generic error.
        const alreadyAssigned = (await db.getJobAssignments(input.jobId)).some(
          (existing) => existing.employeeId === input.toEmployeeId && existing.id !== input.fromAssignmentId
        );
        if (alreadyAssigned) {
          throw new TRPCError({ code: "CONFLICT", message: "This technician is already assigned to the job. Refresh the assignment list." });
        }

        if (input.fromAssignmentId) {
          const oldAssignment = await db.getJobAssignmentById(input.fromAssignmentId);
          // Without this, a crafted request naming a real assignment that
          // actually belongs to a different job could remove that other
          // job's assignment instead — the two ids were never checked
          // against each other.
          if (oldAssignment && oldAssignment.jobId !== input.jobId) {
            throw new TRPCError({ code: "BAD_REQUEST", message: "That assignment does not belong to this job." });
          }
          await db.unassignJobFromEmployee(input.fromAssignmentId);
          if (oldAssignment) {
            await notifyTechnicianOfJob(
              oldAssignment.employeeId,
              "job_unassigned",
              `Removed from job: ${job.jobNumber}`,
              `You've been reassigned off job ${job.jobNumber}.`,
              job.id
            );
          }
        }

        const assignment = await db.assignJobToEmployee(input.jobId, input.toEmployeeId);
        await notifyTechnicianOfJob(
          input.toEmployeeId,
          "job_assigned",
          `New job assigned: ${job.jobNumber}`,
          `You've been assigned to job ${job.jobNumber}${job.dueDate ? ` (due ${job.dueDate})` : ""}.`,
          job.id
        );
        return assignment;
      } catch (error) {
        if (error instanceof TRPCError) throw error;
        console.error("Error reassigning technician:", error);
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      }
    }),

  cancel: staffProcedure
    .input(z.object({ id: z.number(), reason: z.string().max(10000).optional() }))
    .mutation(async ({ input, ctx }) => {
      try {
        const existingJob = await db.getJobById(input.id);
        if (!existingJob) throw new TRPCError({ code: "NOT_FOUND", message: "Job not found." });
        if (existingJob.status === "closed" || existingJob.status === "cancelled") {
          throw new TRPCError({ code: "BAD_REQUEST", message: `This job is already ${existingJob.status}.` });
        }

        await db.updateJob(input.id, {
          status: "cancelled",
          cancellationReason: input.reason || null,
          cancelledAt: new Date().toISOString(),
        });
        const job = await db.getJobById(input.id);
        const cancelledAtIso = new Date().toISOString();

        // A cancelled job needs to actually stop being live operational
        // work, not just change a status label — otherwise the calendar
        // still shows tomorrow's now-pointless appointment, and a
        // technician can still be sitting there clocked in against work
        // that no longer exists.
        const activeEntries = (await db.getTimeEntriesByJob(input.id)).filter((e) => e.clockInTime && !e.clockOutTime);
        for (const entry of activeEntries) {
          const hoursWorked = Math.max(0, (Date.parse(cancelledAtIso) - Date.parse(entry.clockInTime!)) / (60 * 60 * 1000));
          const note = "Clocked out automatically — the job was cancelled while this entry was active.";
          await db.updateTimeEntry(entry.id, {
            clockOutTime: cancelledAtIso,
            hoursWorked: Math.round(hoursWorked * 100) / 100,
            notes: entry.notes ? `${entry.notes}\n${note}` : note,
          });
        }

        const upcomingSchedules = (await db.getSchedulesByJob(input.id)).filter(
          (s) => s.status !== "completed" && s.status !== "cancelled"
        );
        for (const s of upcomingSchedules) {
          await db.updateSchedule(s.id, { status: "cancelled" });
        }

        // A task left "in progress"/"paused" on a now-cancelled job is stale
        // state — there's no "cancelled" status for tasks, so reset them
        // back to not-started rather than leaving a dead timer running.
        const liveTasks = (await db.getTasksForJob(input.id)).filter(
          (t) => t.status === "in_progress" || t.status === "paused"
        );
        for (const t of liveTasks) {
          await db.updateTask(t.id, { status: "not_started", startedAt: null, pausedAt: null });
        }

        // A part requested for work that's no longer happening isn't
        // something to approve or order — auto-decline it rather than
        // leaving it sitting in the queue as if the job were still live.
        const pendingMaterialRequests = (await db.getMaterialRequestsForJob(input.id)).filter((r) => r.status === "pending");
        for (const r of pendingMaterialRequests) {
          await db.updateMaterialRequest(r.id, {
            status: "rejected",
            rejectionReason: "Job was cancelled.",
          });
        }

        const customer = await db.getCustomerById(existingJob.customerId);
        if (customer?.email) {
          await sendJobEmail(
            input.id,
            customer.email,
            `Your Job Has Been Cancelled`,
            emailTemplates.jobCancelled(existingJob.jobNumber || "", input.reason)
          );
        }

        const assignments = await db.getJobAssignments(input.id);
        for (const assignment of assignments) {
          await notifyTechnicianOfJob(
            assignment.employeeId,
            "job_cancelled",
            `Job cancelled: ${existingJob.jobNumber}`,
            `Job ${existingJob.jobNumber} has been cancelled${input.reason ? `: ${input.reason}` : "."}`,
            input.id
          );
        }

        await logAudit({ userId: ctx.user.id, action: "cancel", entityType: "job", entityId: input.id, changes: { reason: input.reason || null }, ipAddress: ctx.req?.ip || null });

        return job;
      } catch (error) {
        if (error instanceof TRPCError) throw error;
        console.error("Error cancelling job:", error);
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      }
    }),

  // Manual, one-click version of "let the customer know this is running
  // long" — surfaced as an action on the Today's Agenda "Job Running Long"
  // item so the office doesn't have to draft that email by hand.
  notifyDelay: staffProcedure
    .input(z.object({ id: z.number(), note: z.string().trim().max(2000).optional() }))
    .mutation(async ({ input, ctx }) => {
      const job = await db.getJobById(input.id);
      if (!job) throw new TRPCError({ code: "NOT_FOUND", message: "Job not found." });
      const customer = await db.getCustomerById(job.customerId);
      if (!customer?.email) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "This customer has no email address on file." });
      }
      const sent = await sendJobEmail(
        input.id,
        customer.email,
        `An Update On Your Job`,
        emailTemplates.jobDelayed(customer.name, job.jobNumber || "", input.note)
      );
      if (!sent) {
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "The delay email could not be sent. Check email settings under Administration and try again." });
      }
      return { success: true } as const;
    }),

  // A technician finds extra work is needed mid-job (something beyond the
  // accepted quote's scope) and needs the customer's sign-off before going
  // ahead with it — separate from, and earlier than, the final invoice
  // approval step (that one's about the bill after the fact; this one's
  // about the work itself, before it happens). Pauses the job at
  // "waiting_customer" until they respond.
  requestAdditionalWork: protectedProcedure
    .input(z.object({ jobId: z.number(), notes: z.string().trim().min(1).max(2000) }))
    .mutation(async ({ input, ctx }) => {
      if (!hasRole(ctx.user.role, "OPERATIONAL")) throw new TRPCError({ code: "FORBIDDEN" });
      await requireTechnicianJobAccess(ctx.user.role, ctx.user.employeeId, input.jobId);
      const job = await db.getJobById(input.jobId);
      if (!job) throw new TRPCError({ code: "NOT_FOUND", message: "Job not found." });
      if (["completed", "closed", "cancelled"].includes(job.status)) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "This job is already finished — extra work can't be requested on it." });
      }

      const patch: Record<string, unknown> = {
        additionalWorkRequested: true,
        additionalWorkApproved: false,
        additionalWorkDeclined: false,
        additionalWorkNotes: input.notes,
        additionalWorkRequestedAt: new Date().toISOString(),
        additionalWorkRespondedAt: null,
        additionalWorkDeclineReason: null,
      };
      if (job.status !== "waiting_customer") patch.status = "waiting_customer";
      await db.updateJob(input.jobId, patch);

      const customer = await db.getCustomerById(job.customerId);
      if (customer?.email) {
        const portalUrl = `${ENV.appUrl}/customer-portal`;
        await sendJobEmail(
          job.id,
          customer.email,
          `Extra Work Needs Your Approval`,
          emailTemplates.additionalWorkRequested(customer.name, job.jobNumber || "", input.notes, portalUrl)
        );
      }

      // Staff need to know this happened right away too — not just once the
      // customer eventually responds. Once it's approved, whoever owns this
      // job's paperwork is the one who'll need to go adjust the invoice for
      // it, so they should already know it's coming.
      try {
        const staff = await db.getStaffUsers();
        const recipients = job.assignedUserId
          ? staff.filter((s) => s.id === job.assignedUserId || s.role === "admin")
          : staff;
        for (const s of recipients) {
          await db.createNotification({
            userId: s.id,
            type: "system",
            title: `Extra work requested: ${job.jobNumber}`,
            message: `${ctx.user.name || "A technician"} flagged extra work and sent it to the customer for approval: ${input.notes.length > 150 ? `${input.notes.slice(0, 150)}…` : input.notes}`,
            relatedEntityType: "job",
            relatedEntityId: job.id,
          });
        }
      } catch (notificationError) {
        console.error("Failed to notify staff of additional work request:", notificationError);
      }

      return await db.getJobById(input.jobId);
    }),

  // Customer's response to the above — approving un-pauses the job
  // (back to in_progress) so the technician can actually pick the work
  // back up; declining leaves it paused for staff to sort out with the
  // customer directly rather than silently dropping the request.
  respondToAdditionalWork: protectedProcedure
    .input(z.object({ jobId: z.number(), approved: z.boolean(), declineReason: z.string().trim().max(1000).optional() }))
    .mutation(async ({ input, ctx }) => {
      if (ctx.user.role !== "customer") throw new TRPCError({ code: "FORBIDDEN" });
      const job = await db.getJobById(input.jobId);
      if (!job) throw new TRPCError({ code: "NOT_FOUND", message: "Job not found." });
      if (job.customerId !== ctx.user.customerId) throw new TRPCError({ code: "FORBIDDEN" });
      if (!job.additionalWorkRequested || job.additionalWorkApproved || job.additionalWorkDeclined) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "There's no pending extra-work request on this job to respond to." });
      }
      if (!input.approved && !input.declineReason?.trim()) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Let us know why, so staff can follow up with you directly." });
      }

      await db.updateJob(input.jobId, {
        additionalWorkApproved: input.approved,
        additionalWorkDeclined: !input.approved,
        additionalWorkRespondedAt: new Date().toISOString(),
        additionalWorkDeclineReason: input.approved ? null : input.declineReason!.trim(),
        ...(input.approved && job.status === "waiting_customer" ? { status: "in_progress" as const } : {}),
      });

      try {
        const staff = await db.getStaffUsers();
        const recipients = job.assignedUserId
          ? staff.filter((s) => s.id === job.assignedUserId || s.role === "admin")
          : staff;
        for (const s of recipients) {
          await db.createNotification({
            userId: s.id,
            type: "system",
            title: `Extra work ${input.approved ? "approved" : "declined"}: ${job.jobNumber}`,
            message: input.approved
              ? "The customer approved the extra work — the job is back in progress."
              : `The customer declined: ${input.declineReason}`,
            relatedEntityType: "job",
            relatedEntityId: job.id,
          });
        }
      } catch (error) {
        console.error("Failed to notify staff of additional work response:", error);
      }

      return await db.getJobById(input.jobId);
    }),

  deletePreview: staffProcedure.input(z.number()).query(async ({ input, ctx }) => {
    const jobTasks = await db.getTasksForJob(input);
    return { taskCount: jobTasks.length };
  }),

  delete: staffProcedure.input(z.object({ id: z.number(), deleteTasks: z.boolean().optional() })).mutation(async ({ input, ctx }) => {
    try {
      await db.deleteJob(input.id, { deleteTasks: input.deleteTasks });
      await logAudit({ userId: ctx.user.id, action: "delete", entityType: "job", entityId: input.id, changes: null, ipAddress: ctx.req?.ip || null });
      return { success: true } as const;
    } catch (error) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: safeDeleteMessage(error, "job", "Jobs"),
      });
    }
  }),
});
