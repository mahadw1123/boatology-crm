import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { protectedProcedure, router } from "../_core/trpc";
import * as db from "../db";
import { getXeroStatus } from "../_core/xero";

// ============================================================================
// AGENDA ROUTER (the "Operations Intelligence" rules engine)
// ============================================================================

type AgendaItem = {
  id: string;
  title: string;
  category: string;
  urgency: "info" | "normal" | "high" | "urgent";
  linkType: "quote" | "invoice" | "job" | "task" | "materialRequest" | "inventory" | "customer";
  linkId: number;
  // Which slice of staff this item is actually relevant to, mirroring the
  // ops/accounts split already used on the Dashboard's Role Focus panel —
  // office staff don't need "technician workload" nudges, and management
  // doesn't need "chase this unpaid deposit" nudges. Admins see everything
  // regardless, same as they do everywhere else. Left undefined only for
  // the technician/customer branches, which are already fully personal.
  audience?: "ops" | "accounts";
  // The specific staff member who owns this item, from that quote/job/
  // invoice/inventory item/material request's assignedUserId. When set,
  // the item is personal — shown only to that user (and admin). When
  // unset (nobody's claimed ownership yet), it falls back to the
  // role-based audience split above so nothing silently disappears.
  assignedTo?: number | null;
  // A handful of items are urgent enough to interrupt rather than wait to
  // be noticed in the list — right now, just "customer stuck across 3+
  // quote revisions with no resolution." The Dashboard shows these as a
  // blocking dialog on load instead of just another agenda row.
  popup?: boolean;
};

export const agendaRouter = router({
  today: protectedProcedure.query(async ({ ctx }) => {
    try {
      const items: AgendaItem[] = [];
      const todayStr = new Date().toISOString().slice(0, 10);
      const tomorrowStr = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
      const order = { urgent: 0, high: 1, normal: 2, info: 3 };
      // Without this, a category nobody on this account acts on just
      // resurfaces every single day forever with no way to quiet it down.
      const mutedCategories = new Set(((ctx.user as any).mutedAgendaCategories as string[] | null) || []);
      const withoutMuted = (list: AgendaItem[]) => list.filter((i) => !mutedCategories.has(i.category));

      if (ctx.user.role === "technician") {
        if (!ctx.user.employeeId) return items;
        const myJobs = await db.getJobsForEmployee(ctx.user.employeeId);
        const myJobIds = new Set(myJobs.map((j) => j.id));
        const allTasks = await db.getTasksForEmployee(ctx.user.employeeId);

        for (const t of allTasks) {
          if (t.status === "completed") continue;
          if (t.dueDate && t.dueDate < todayStr) {
            items.push({ id: `task-overdue-${t.id}`, title: `Task overdue: ${t.name}`, category: "Tasks Overdue", urgency: "urgent", linkType: "job", linkId: t.jobId });
          } else if (t.dueDate === todayStr) {
            items.push({ id: `task-today-${t.id}`, title: `Due today: ${t.name}`, category: "Due Today", urgency: "high", linkType: "job", linkId: t.jobId });
          }
        }
        for (const j of myJobs) {
          if (j.status === "completed" || j.status === "closed") continue;
          if (j.dueDate === tomorrowStr) {
            items.push({ id: `job-tomorrow-${j.id}`, title: `Job starts tomorrow: ${j.jobNumber}`, category: "Starting Tomorrow", urgency: "normal", linkType: "job", linkId: j.id });
          }
        }

        // "You were assigned this and haven't even opened it" — easy to
        // miss beyond the notification bell, and unlike a notification
        // (which clears the moment it's marked read, whether or not they
        // actually looked at the job) this only clears once they genuinely
        // load the job page.
        const myAssignments = await db.getJobAssignmentsForEmployee(ctx.user.employeeId);
        for (const a of myAssignments) {
          if (a.viewedAt) continue;
          const job = myJobs.find((j) => j.id === a.jobId);
          if (!job || ["completed", "closed", "cancelled"].includes(job.status)) continue;
          items.push({ id: `job-unopened-${a.id}`, title: `New job assigned, not opened yet: ${job.jobNumber}`, category: "New Job Assigned", urgency: "high", linkType: "job", linkId: job.id });
        }

        // Mirrors the admin-side auto-clock-out (which force-closes at 8
        // hours) with a heads-up before that happens — better to remind
        // someone to clock out themselves than to only ever silently do it
        // for them.
        const myActiveEntry = await db.getActiveTimeEntry(ctx.user.employeeId);
        if (myActiveEntry) {
          const hoursSinceClockIn = (Date.now() - new Date(myActiveEntry.clockInTime!).getTime()) / (60 * 60 * 1000);
          if (hoursSinceClockIn >= 6) {
            items.push({
              id: "clocked-in-too-long",
              title: `You've been clocked in for ${Math.floor(hoursSinceClockIn)}+ hours — remember to clock out`,
              category: "Remember To Clock Out",
              urgency: "normal",
              linkType: "job",
              linkId: myActiveEntry.jobId || 0,
            });
          }
        }

        // A material request they raised themselves was actioned — approved
        // (so they know it's coming / to go collect it once ordered) or
        // rejected (so they see why, rather than just wondering why nothing
        // showed up). Only rejections from the last few days, so a decline
        // from months ago doesn't sit here forever; approvals clear
        // themselves naturally once staff mark it "ordered".
        const myMaterialRequests = (await db.getMaterialRequests()).filter((r) => r.requestedBy === ctx.user.id);
        const threeDaysAgoForMaterials = new Date(Date.now() - 3 * 86400000).toISOString();
        for (const r of myMaterialRequests) {
          if (r.status === "approved") {
            items.push({ id: `my-material-approved-${r.id}`, title: `Approved: ${r.materialName} — check in with the office once it's ordered`, category: "Your Material Requests", urgency: "normal", linkType: "job", linkId: r.jobId });
          } else if (r.status === "rejected" && r.createdAt >= threeDaysAgoForMaterials) {
            items.push({ id: `my-material-rejected-${r.id}`, title: `Rejected: ${r.materialName}${r.rejectionReason ? ` — ${r.rejectionReason}` : ""}`, category: "Your Material Requests", urgency: "normal", linkType: "job", linkId: r.jobId });
          }
        }

        // A completed antifouling job with nothing recorded in the
        // dedicated technical record is real data loss for a boat shop —
        // paint brand, coats, prep work, none of it captured anywhere once
        // the job's closed out. Keyword-matched off the job/quote rather
        // than a job "type" field, since none exists — imperfect, but
        // catches the real case without flagging every unrelated job.
        const completedMine = myJobs.filter((j) => j.status === "completed");
        for (const j of completedMine) {
          const mentionsAntifouling = (text: string | null | undefined) => !!text && /antifoul/i.test(text);
          let relevant = mentionsAntifouling(j.description);
          if (!relevant && j.quoteId) {
            const quote = await db.getQuoteById(j.quoteId);
            relevant =
              mentionsAntifouling(quote?.notes) ||
              (Array.isArray(quote?.lineItems) &&
                (quote!.lineItems as any[]).some((li) => mentionsAntifouling(li?.description || li?.name)));
          }
          if (!relevant) continue;
          const details = await db.getAntifoulingDetailsForJob(j.id);
          if (details) continue;
          items.push({ id: `antifouling-missing-${j.id}`, title: `Add antifouling details for completed job: ${j.jobNumber}`, category: "Antifouling Details Missing", urgency: "normal", linkType: "job", linkId: j.id });
        }
        return withoutMuted(items);
      }

      // A customer previously got nothing here at all — no proactive
      // reminder about money they owe or a decision they're sitting on,
      // just whatever they happened to notice by clicking into each tab.
      // This is deliberately a small, curated list (what genuinely needs
      // THEM to act), not a mirror of the staff-side business view.
      if (ctx.user.role === "customer") {
        if (!ctx.user.customerId) return items;
        const [myInvoices, myJobsForCustomer] = await Promise.all([
          db.getInvoicesByCustomer(ctx.user.customerId),
          db.getJobs(ctx.user.customerId),
        ]);

        const unpaidInvoices = myInvoices.filter((i) => i.status === "sent");
        for (const inv of unpaidInvoices) {
          const daysSinceSent = inv.sentAt ? Math.floor((Date.now() - new Date(inv.sentAt).getTime()) / 86400000) : 0;
          const overdue = daysSinceSent >= 14;
          items.push({
            id: `my-invoice-payment-due-${inv.id}`,
            title: overdue
              ? `Payment overdue: $${inv.totalDue.toFixed(2)}`
              : `Payment due: $${inv.totalDue.toFixed(2)}`,
            category: "Payment Due",
            urgency: overdue ? "urgent" : "normal",
            linkType: "invoice",
            linkId: inv.id,
          });
        }

        const jobsAwaitingMyApproval = myJobsForCustomer.filter(
          (j) => j.additionalWorkRequested && !j.additionalWorkApproved && !j.additionalWorkDeclined
        );
        for (const j of jobsAwaitingMyApproval) {
          items.push({
            id: `my-extra-work-approval-${j.id}`,
            title: `Extra work needs your approval on job ${j.jobNumber}`,
            category: "Needs Your Approval",
            urgency: "high",
            linkType: "job",
            linkId: j.id,
          });
        }

        items.sort((a, b) => (order[a.urgency] ?? 3) - (order[b.urgency] ?? 3));
        return withoutMuted(items);
      }

      // Staff (admin / office_staff / management) — business-wide view,
      // filtered by audience further down so office staff and management
      // each only see the half that's actually theirs to act on.
      const [quotes, invoices, jobs, tasks, materialReqs, inventory, jobAssignments, customerMessages, documents, vessels, allStaffTasks, waitingPartsAlertDays] = await Promise.all([
        db.getQuotes(),
        db.getAllInvoices(),
        db.getJobs(),
        db.getTasksForJobs((await db.getJobs()).map((j) => j.id)),
        db.getMaterialRequests(),
        db.getInventoryItems(),
        db.getAllJobAssignments(),
        db.getCustomerMessages(),
        db.getDocuments(),
        db.getVessels(),
        db.getStaffTasks(),
        db.getWaitingPartsAlertDays(),
      ]);

      // Real "reminds the responsible person" behavior — nudges whoever
      // sent a quote if it's had no customer response in a while. A
      // scheduled job (see server/_core/scheduler.ts) also runs this daily
      // for every staff member regardless of who's logged in; this call
      // additionally catches it the moment the responsible person's own
      // dashboard loads, and the dedup means the two never double up.
      await db.runUnsentQuoteReminderCheckForAllStaff();

      const quotesAwaiting = quotes.filter((q) => q.status === "sent");
      for (const q of quotesAwaiting) {
        items.push({
          id: `quote-awaiting-${q.id}`,
          title: `Awaiting customer approval: ${q.quoteNumber}`,
          category: "Quotes Awaiting Approval",
          urgency: "normal",
          linkType: "quote",
          linkId: q.id,
          audience: "accounts",
          assignedTo: (q as any).assignedUserId,
        });
      }

      // Only surfaced when Xero is actually connected — otherwise every
      // invoice is trivially "not synced" and the reminder would just be
      // noise. Lives on the invoice, not the quote — a quote can still
      // change, but an issued invoice is the final document Xero should see.
      const xeroStatusForAgenda = await getXeroStatus();
      if (xeroStatusForAgenda.connected) {
        const invoicesNotSyncedToXero = invoices.filter(
          (i) => !["draft", "void", "refunded", "reversed"].includes(i.status) && (i.xeroSyncStatus === "not_synced" || i.xeroSyncStatus === "failed")
        );
        for (const inv of invoicesNotSyncedToXero) {
          items.push({ id: `invoice-not-synced-xero-${inv.id}`, title: `Invoice not synced to Xero: ${inv.invoiceNumber}`, category: "Xero Sync", urgency: "normal", linkType: "invoice", linkId: inv.id, audience: "accounts", assignedTo: (inv as any).assignedUserId });
        }

        // A refund can drift Boatology and Xero apart just as easily as an
        // unsynced invoice can — Xero still shows the original paid amount
        // until someone goes and fixes it there directly. There's no
        // "push a refund" API call built (voiding/adjusting an invoice
        // that's already been synced is a real, deliberate accounting
        // action, not something to automate silently), so this just makes
        // sure the correction doesn't get forgotten.
        const refundedButSynced = invoices.filter((i) => i.refundStatus && i.xeroSyncStatus === "synced");
        for (const inv of refundedButSynced) {
          items.push({
            id: `invoice-refund-not-resynced-${inv.id}`,
            title: `Refunded but still shows paid in Xero: ${inv.invoiceNumber} — adjust or remove it in Xero manually`,
            category: "Xero Sync",
            urgency: "high",
            linkType: "invoice",
            linkId: inv.id,
            audience: "accounts",
            assignedTo: (inv as any).assignedUserId,
          });
        }
      }

      const threeDaysOut = new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10);
      const quotesExpiringSoon = quotes.filter(
        (q) => q.status === "sent" && q.expiryDate && q.expiryDate >= todayStr && q.expiryDate <= threeDaysOut
      );
      for (const q of quotesExpiringSoon) {
        items.push({ id: `quote-expiring-${q.id}`, title: `Quote expires soon: ${q.quoteNumber}`, category: "Quotes Expiring Soon", urgency: "high", linkType: "quote", linkId: q.id, audience: "accounts", assignedTo: (q as any).assignedUserId });
      }

      // A quote being "accepted" only auto-creates its deposit invoice —
      // nothing about the actual job (technician assignment, scheduling,
      // tasks) happens until staff manually creates it from Jobs. Without
      // this, an accepted quote can just sit there indefinitely: the
      // customer thinks work is booked in and has already been asked for a
      // deposit, but nobody's actually scheduled anything.
      const jobbedQuoteIds = new Set(jobs.filter((j) => j.quoteId).map((j) => j.quoteId));
      const acceptedNoJob = quotes.filter((q) => q.status === "accepted" && !jobbedQuoteIds.has(q.id));
      for (const q of acceptedNoJob) {
        items.push({ id: `quote-accepted-no-job-${q.id}`, title: `Accepted, no job created yet: ${q.quoteNumber}`, category: "Job Not Created", urgency: "high", linkType: "quote", linkId: q.id, audience: "ops", assignedTo: (q as any).assignedUserId });
      }

      // A deposit is calculated as a percentage of the quote total at the
      // moment it's paid. If the quote is later revised — revisions only
      // ever go up, never down — the deposit already collected is now short
      // against the new total, and nothing currently notices: revising a
      // quote just supersedes the old one, it doesn't touch the deposit
      // invoice already tied to it. Group quotes into revision chains
      // (parentQuoteId always points at the original) and flag any chain
      // where a deposit was paid against an earlier revision than the
      // current one, and nobody's raised a deposit against the new total.
      const revisionChainsByRoot = new Map<number, typeof quotes>();
      for (const q of quotes) {
        const rootId = q.parentQuoteId ?? q.id;
        const chain = revisionChainsByRoot.get(rootId);
        if (chain) chain.push(q);
        else revisionChainsByRoot.set(rootId, [q]);
      }
      for (const chain of revisionChainsByRoot.values()) {
        if (chain.length < 2) continue;
        const latest = chain.reduce((a, b) => ((b.revisionNumber || 1) > (a.revisionNumber || 1) ? b : a));
        const depositForLatest = invoices.find((i) => i.invoiceType === "deposit" && i.quoteId === latest.id);
        if (depositForLatest) continue;
        const staleDeposit = invoices.find(
          (i) => i.invoiceType === "deposit" && i.status === "paid" && i.quoteId !== latest.id && chain.some((q) => q.id === i.quoteId)
        );
        if (!staleDeposit) continue;
        const staleQuote = chain.find((q) => q.id === staleDeposit.quoteId);
        if (!staleQuote || (latest.totalAmount || 0) <= (staleQuote.totalAmount || 0)) continue;
        items.push({
          id: `deposit-stale-${latest.id}`,
          title: `Deposit paid on an older total: ${latest.quoteNumber}`,
          category: "Deposit Needs Reconciling",
          urgency: "high",
          linkType: "quote",
          linkId: latest.id,
          audience: "accounts",
          assignedTo: (latest as any).assignedUserId,
        });
      }

      // A customer stuck across 3+ revisions of the same quote (the
      // original plus 2+ follow-up revisions) with nothing resolved yet is
      // a sign the back-and-forth over email/portal isn't working — this is
      // urgent enough to interrupt with a popup asking staff to just call
      // them, not sit quietly in the agenda list. Clears itself the moment
      // staff mark the call made (quotes.dismissRevisionFollowUp), and
      // naturally re-arms if the quote is revised again afterward, since
      // that creates a new row with its own unset dismissal.
      for (const chain of revisionChainsByRoot.values()) {
        if (chain.length < 3) continue;
        const latest = chain.reduce((a, b) => ((b.revisionNumber || 1) > (a.revisionNumber || 1) ? b : a));
        if (latest.status === "accepted" || latest.status === "rejected") continue;
        if ((latest as any).revisionFollowUpResolvedAt) continue;
        items.push({
          id: `quote-revision-callback-${latest.id}`,
          title: `${chain.length} revisions with no resolution yet: ${latest.quoteNumber} — give the customer a call`,
          category: "Quote Stuck In Revisions",
          urgency: "urgent",
          linkType: "quote",
          linkId: latest.id,
          audience: "accounts",
          assignedTo: (latest as any).assignedUserId,
          popup: true,
        });
      }

      // A quote that was drafted and never sent isn't "waiting on the
      // customer" (that's the "No Response" check below, which only looks
      // at quotes that were actually sent) — it's just been forgotten
      // before the customer ever saw it.
      const twoDaysAgoIso = new Date(Date.now() - 2 * 86400000).toISOString();
      const staleDrafts = quotes.filter((q) => q.status === "draft" && q.createdAt < twoDaysAgoIso);
      for (const q of staleDrafts) {
        items.push({
          id: `quote-draft-stale-${q.id}`,
          title: `Still in draft, never sent: ${q.quoteNumber}`,
          category: "Quote Never Sent",
          urgency: "normal",
          linkType: "quote",
          linkId: q.id,
          audience: "accounts",
          assignedTo: (q as any).assignedUserId,
        });
      }

      const jobsAwaitingMaterials = new Set(materialReqs.filter((r) => r.status === "pending").map((r) => r.jobId));
      for (const jobId of jobsAwaitingMaterials) {
        const job = jobs.find((j) => j.id === jobId);
        if (job && job.status !== "completed" && job.status !== "closed") {
          items.push({ id: `job-awaiting-materials-${jobId}`, title: `Job awaiting materials: ${job.jobNumber}`, category: "Awaiting Materials", urgency: "normal", linkType: "job", linkId: jobId, audience: "ops", assignedTo: (job as any).assignedUserId });
        }
      }

      // "Quote #1032 has had no response in over a week" — a quote sent to
      // the customer that's just sitting there, easy to lose track of once
      // it's off the top of the list. (Previously this checked for quotes
      // stuck in "draft" — but quotes now send the moment they're created,
      // so nothing could ever actually be in that state; this replaces it
      // with the equivalent check that's still reachable given that.)
      const fiveDaysAgo = new Date(Date.now() - 5 * 86400000).toISOString();
      const staleQuotes = quotes.filter((q) => q.status === "sent" && q.sentAt && q.sentAt < fiveDaysAgo);
      for (const q of staleQuotes) {
        items.push({ id: `quote-stale-${q.id}`, title: `No response yet: ${q.quoteNumber}`, category: "No Response", urgency: "normal", linkType: "quote", linkId: q.id, audience: "accounts", assignedTo: (q as any).assignedUserId });
      }

      // "Boat has arrived but work hasn't started" — due today or overdue,
      // has tasks, but not one has actually been started yet.
      const dueButNotStarted = jobs.filter((j) => {
        if (!j.dueDate || j.dueDate > todayStr) return false;
        if (j.status === "completed" || j.status === "closed") return false;
        const jobTasks = tasks.filter((t: any) => t.jobId === j.id);
        return jobTasks.length > 0 && jobTasks.every((t: any) => t.status === "not_started");
      });
      for (const j of dueButNotStarted) {
        items.push({ id: `job-not-started-${j.id}`, title: `Due but not started: ${j.jobNumber}`, category: "Not Started", urgency: "high", linkType: "job", linkId: j.id, audience: "ops", assignedTo: (j as any).assignedUserId });
      }

      // "Final invoice hasn't been generated" — job's done, only a deposit
      // has been invoiced so far, nothing's chasing the remaining balance.
      const finalInvoicedJobIds = new Set(invoices.filter((i) => i.invoiceType === "final" || i.invoiceType === "standalone").map((i) => i.jobId));
      const completedNoFinalInvoice = jobs.filter(
        (j) => j.status === "completed" && !finalInvoicedJobIds.has(j.id)
      );
      for (const j of completedNoFinalInvoice) {
        items.push({ id: `final-invoice-missing-${j.id}`, title: `Final invoice not generated: ${j.jobNumber}`, category: "Final Invoice Missing", urgency: "high", linkType: "job", linkId: j.id, audience: "accounts", assignedTo: (j as any).assignedUserId });
      }

      // "Job's done but nobody documented it" — no before/after photos on a
      // completed job is a real risk for a boat-repair shop specifically:
      // it's the evidence you'd want if a customer later disputes what
      // condition the vessel was in or what work was actually done.
      const jobIdsWithPhotos = new Set(documents.filter((d) => d.documentType === "photo" && d.jobId).map((d) => d.jobId));
      const completedNoPhotos = jobs.filter((j) => j.status === "completed" && !jobIdsWithPhotos.has(j.id));
      for (const j of completedNoPhotos) {
        items.push({ id: `job-no-photos-${j.id}`, title: `No photos on file: ${j.jobNumber}`, category: "Missing Photos", urgency: "normal", linkType: "job", linkId: j.id, audience: "ops", assignedTo: (j as any).assignedUserId });
      }

      const disputedInvoices = invoices.filter((i) => i.disputeStatus === "open");
      for (const inv of disputedInvoices) {
        items.push({ id: `dispute-open-${inv.id}`, title: `Payment disputed: ${inv.invoiceNumber}`, category: "Payment Disputes", urgency: "urgent", linkType: "invoice", linkId: inv.id, audience: "accounts", assignedTo: (inv as any).assignedUserId });
      }

      const depositsUnpaid = invoices.filter((i) => i.invoiceType === "deposit" && !["paid", "void", "refunded"].includes(i.status));
      for (const inv of depositsUnpaid) {
        items.push({ id: `deposit-unpaid-${inv.id}`, title: `Deposit unpaid: ${inv.invoiceNumber}`, category: "Deposits Unpaid", urgency: "high", linkType: "invoice", linkId: inv.id, audience: "accounts", assignedTo: (inv as any).assignedUserId });
      }

      // The customer hasn't approved a revised final invoice amount yet —
      // Stripe checkout is hard-blocked on this (see invoices.createPaymentIntent),
      // so an un-approved invoice isn't just unpaid, it's UNPAYABLE until
      // they respond. Same shape as "No Response" on stale quotes, just a
      // shorter fuse (3 days) since it's blocking money that's already
      // been earned, not still being negotiated.
      const threeDaysAgoForApproval = new Date(Date.now() - 3 * 86400000).toISOString();
      const invoicesAwaitingApproval = invoices.filter(
        (i) => i.requiresApproval && !i.approvedAt && i.status === "sent" && i.sentAt && i.sentAt < threeDaysAgoForApproval
      );
      for (const inv of invoicesAwaitingApproval) {
        items.push({
          id: `invoice-awaiting-approval-${inv.id}`,
          title: `Customer hasn't approved the revised amount: ${inv.invoiceNumber} — resend it`,
          category: "Invoice Awaiting Approval",
          urgency: "high",
          linkType: "invoice",
          linkId: inv.id,
          audience: "accounts",
          assignedTo: (inv as any).assignedUserId,
        });
      }

      const invoicesOverdue = invoices.filter((i) => {
        if (i.status === "paid" || i.status === "void" || i.invoiceType === "deposit") return false;
        const sent = i.sentAt ? new Date(i.sentAt) : new Date(i.createdAt);
        const daysSince = Math.floor((Date.now() - sent.getTime()) / 86400000);
        return daysSince >= 14;
      });
      for (const inv of invoicesOverdue) {
        const sent = inv.sentAt ? new Date(inv.sentAt) : new Date(inv.createdAt);
        const daysSince = Math.floor((Date.now() - sent.getTime()) / 86400000);
        items.push({ id: `invoice-overdue-${inv.id}`, title: `Invoice overdue by ${daysSince} days: ${inv.invoiceNumber}`, category: "Invoices Overdue", urgency: "urgent", linkType: "invoice", linkId: inv.id, audience: "accounts", assignedTo: (inv as any).assignedUserId });
      }

      const jobsOverdue = jobs.filter((j) => j.dueDate && j.dueDate < todayStr && j.status !== "completed" && j.status !== "closed");
      for (const j of jobsOverdue) {
        items.push({ id: `job-overdue-${j.id}`, title: `Job overdue: ${j.jobNumber}`, category: "Jobs Overdue", urgency: "urgent", linkType: "job", linkId: j.id, audience: "ops", assignedTo: (j as any).assignedUserId });
      }

      const jobsTomorrow = jobs.filter((j) => j.dueDate === tomorrowStr && j.status !== "completed" && j.status !== "closed");
      for (const j of jobsTomorrow) {
        items.push({ id: `job-tomorrow-${j.id}`, title: `Job starts tomorrow: ${j.jobNumber}`, category: "Starting Tomorrow", urgency: "normal", linkType: "job", linkId: j.id, audience: "ops", assignedTo: (j as any).assignedUserId });
      }

      // "Nobody's actually been told to do this job" — created, still open,
      // but zero technicians assigned. Easy to lose track of once a job
      // slips off the top of the Jobs list.
      const assignedJobIds = new Set(jobAssignments.map((a: any) => a.jobId));
      const unassignedJobs = jobs.filter(
        (j) => !assignedJobIds.has(j.id) && j.status !== "completed" && j.status !== "closed" && j.status !== "cancelled"
      );
      for (const j of unassignedJobs) {
        items.push({ id: `job-unassigned-${j.id}`, title: `No technician assigned: ${j.jobNumber}`, category: "Unassigned Jobs", urgency: "high", linkType: "job", linkId: j.id, audience: "ops", assignedTo: (j as any).assignedUserId });
      }

      // Cancelling a job never touches a deposit invoice already paid
      // against it — someone needs to actually decide whether that money
      // gets refunded, it doesn't happen on its own.
      const cancelledWithDeposit = jobs.filter((j) => j.status === "cancelled" && j.quoteId);
      for (const j of cancelledWithDeposit) {
        const paidDeposit = invoices.find(
          (i) => i.invoiceType === "deposit" && i.quoteId === j.quoteId && i.status === "paid"
        );
        if (!paidDeposit) continue;
        items.push({
          id: `job-cancelled-refund-owed-${j.id}`,
          title: `Job cancelled, deposit paid — refund may be owed: ${j.jobNumber}`,
          category: "Refund May Be Owed",
          urgency: "high",
          linkType: "invoice",
          linkId: paidDeposit.id,
          audience: "accounts",
          assignedTo: (j as any).assignedUserId,
        });
      }

      // "Waiting on Parts" is a status staff set manually when work is
      // blocked on a delivery — admin-configurable (default a week) since
      // how long is normal before it's worth chasing the supplier varies by
      // business. waitingPartsSince is set the moment a job enters this
      // status (see jobs.update), not just inferred from a generic
      // updatedAt, which never reliably reflects when the status actually
      // changed.
      const waitingPartsAlertCutoff = new Date(Date.now() - waitingPartsAlertDays * 86400000).toISOString();
      const jobsWaitingOnPartsTooLong = jobs.filter(
        (j) => j.status === "waiting_parts" && (j as any).waitingPartsSince && (j as any).waitingPartsSince < waitingPartsAlertCutoff
      );
      for (const j of jobsWaitingOnPartsTooLong) {
        items.push({
          id: `job-waiting-parts-${j.id}`,
          title: `Still waiting on parts after ${waitingPartsAlertDays}+ days: ${j.jobNumber} — check with the supplier`,
          category: "Waiting On Parts Too Long",
          urgency: "high",
          linkType: "job",
          linkId: j.id,
          audience: "ops",
          assignedTo: (j as any).assignedUserId,
        });
      }

      // The job is paused waiting on the customer to approve extra work a
      // technician found — a shorter fuse than parts (2 days, not a week),
      // since the customer usually just needs to see the request, not wait
      // on a supplier. Chasing this is an accounts-style follow-up (get the
      // customer to actually respond), same shape as "No Response" on
      // stale quotes, so it lives there rather than with ops.
      const additionalWorkAlertCutoff = new Date(Date.now() - 2 * 86400000).toISOString();
      const jobsAwaitingExtraWorkApproval = jobs.filter(
        (j) =>
          (j as any).additionalWorkRequested &&
          !(j as any).additionalWorkApproved &&
          !(j as any).additionalWorkDeclined &&
          (j as any).additionalWorkRequestedAt &&
          (j as any).additionalWorkRequestedAt < additionalWorkAlertCutoff
      );
      for (const j of jobsAwaitingExtraWorkApproval) {
        items.push({
          id: `job-extra-work-awaiting-approval-${j.id}`,
          title: `Customer hasn't approved extra work yet: ${j.jobNumber}`,
          category: "Extra Work Awaiting Approval",
          urgency: "high",
          linkType: "job",
          linkId: j.id,
          audience: "accounts",
          assignedTo: (j as any).assignedUserId,
        });
      }

      // The customer approved the extra work itself — now someone needs to
      // actually go raise or adjust the invoice for it, or the job stays
      // billed for the original quote forever. This is the second half of
      // the loop: work gets approved first, then its cost gets approved
      // separately via the invoice's own requiresApproval flow above.
      const jobsApprovedNotInvoiced = jobs.filter(
        (j) => (j as any).additionalWorkApproved && !(j as any).additionalWorkInvoicedAt
      );
      for (const j of jobsApprovedNotInvoiced) {
        items.push({
          id: `job-extra-work-needs-invoice-${j.id}`,
          title: `Extra work approved — update the invoice: ${j.jobNumber}`,
          category: "Extra Work Needs Invoicing",
          urgency: "high",
          linkType: "job",
          linkId: j.id,
          audience: "accounts",
          assignedTo: (j as any).assignedUserId,
        });
      }

      // "This job is taking longer than expected" — actual hours logged
      // already exceed the estimate by a real margin, even before the due
      // date arrives, so the office can get ahead of a delay instead of
      // reacting to it after the customer notices.
      const runningOverEstimate = jobs.filter((j) => {
        if (j.status === "completed" || j.status === "closed" || j.status === "cancelled") return false;
        if (!j.estimatedLaborHours || j.estimatedLaborHours <= 0 || !j.actualLaborHours) return false;
        return j.actualLaborHours > j.estimatedLaborHours * 1.2;
      });
      for (const j of runningOverEstimate) {
        const overBy = Math.round((j.actualLaborHours! - j.estimatedLaborHours!) * 10) / 10;
        items.push({
          id: `job-over-estimate-${j.id}`,
          title: `Running over estimate by ${overBy}h: ${j.jobNumber} — consider notifying the customer of a delay`,
          category: "Job Running Long",
          urgency: "high",
          linkType: "job",
          linkId: j.id,
          audience: "ops",
          assignedTo: (j as any).assignedUserId,
        });
      }

      const tasksOverdue = tasks.filter((t: any) => t.dueDate && t.dueDate < todayStr && t.status !== "completed");
      if (tasksOverdue.length > 0) {
        items.push({
          id: "tasks-overdue",
          title: `${tasksOverdue.length} task${tasksOverdue.length > 1 ? "s" : ""} overdue`,
          category: "Tasks Overdue",
          urgency: "urgent",
          linkType: "job",
          linkId: (tasksOverdue[0] as any).jobId,
          audience: "ops",
        });
      }

      const pendingRequests = materialReqs.filter((r) => r.status === "pending");
      if (pendingRequests.length > 0) {
        items.push({
          id: "material-requests-pending",
          title: `${pendingRequests.length} material request${pendingRequests.length > 1 ? "s" : ""} awaiting approval`,
          category: "Material Requests",
          urgency: "normal",
          linkType: "materialRequest",
          linkId: pendingRequests[0].id,
          audience: "ops",
        });
      }

      // A pending request sitting unactioned for days is a different,
      // sharper problem than the generic "N requests awaiting approval"
      // count above — that one never goes away and never says which
      // request or how urgent, so a two-day-old request looks the same as
      // one from this morning. This calls out each one individually, once
      // it's old enough to actually be blocking a job, personalized to
      // whoever's responsible for approving it (mirrors "No response yet"
      // for stale quotes, just on a much shorter fuse — parts block work).
      const twoDaysAgo = new Date(Date.now() - 2 * 86400000).toISOString();
      const overdueRequests = materialReqs.filter((r) => r.status === "pending" && r.createdAt < twoDaysAgo);
      for (const r of overdueRequests) {
        items.push({
          id: `material-request-overdue-${r.id}`,
          title: `Still awaiting approval: ${r.materialName}`,
          category: "Material Requests Overdue",
          urgency: "urgent",
          linkType: "materialRequest",
          linkId: r.id,
          audience: "ops",
          assignedTo: (r as any).assignedUserId,
        });
      }

      // Approved (someone signed off on buying it) but nobody's actually
      // placed the order yet — a distinct, easy-to-drop step between
      // "approved" and "ordered" that a pending-only check would miss.
      const approvedNotOrdered = materialReqs.filter((r) => r.status === "approved");
      for (const r of approvedNotOrdered) {
        items.push({
          id: `material-request-approved-${r.id}`,
          title: `Approved, not yet ordered: ${r.materialName}`,
          category: "Materials To Order",
          urgency: "high",
          linkType: "materialRequest",
          linkId: r.id,
          audience: "ops",
          assignedTo: (r as any).assignedUserId,
        });
      }

      const lowStock = inventory.filter((i) => i.currentStock <= i.minimumStock);
      for (const i of lowStock) {
        items.push({
          id: `low-stock-${i.id}`,
          title: `At or below minimum stock: ${i.name}`,
          category: "Stock Levels",
          urgency: "normal",
          linkType: "inventory",
          linkId: i.id,
          audience: "ops",
          assignedTo: (i as any).assignedUserId,
        });
      }

      // A customer used the "Contact Us" popup — unresolved until a staff
      // member actually deals with it, not just seen.
      const newCustomerMessages = customerMessages.filter((m) => m.status === "new");
      for (const m of newCustomerMessages) {
        items.push({
          id: `customer-message-${m.id}`,
          title: `${m.name} is trying to get in touch: "${m.message.length > 80 ? `${m.message.slice(0, 80)}…` : m.message}"`,
          category: "Customer Messages",
          urgency: "high",
          linkType: "customer",
          linkId: m.customerId,
          audience: "accounts",
        });
      }

      // A customer message no staff member has replied to within a day is a
      // different problem than a fresh one — the "Customer Messages" item
      // above already flags it the moment it arrives, but says nothing
      // about how long it's been sitting. Someone reaching out through the
      // portal and getting silence for a day-plus is exactly the kind of
      // thing that costs a repeat customer.
      const oneDayAgo = new Date(Date.now() - 86400000).toISOString();
      const overdueCustomerMessages = customerMessages.filter((m) => m.status === "new" && m.createdAt < oneDayAgo);
      for (const m of overdueCustomerMessages) {
        items.push({
          id: `customer-message-overdue-${m.id}`,
          title: `Still waiting on a reply: ${m.name}`,
          category: "Customer Messages Overdue",
          urgency: "urgent",
          linkType: "customer",
          linkId: m.customerId,
          audience: "accounts",
        });
      }

      // Insurance on a vessel about to have work done on it is worth
      // knowing about before, not after, something goes wrong — this is
      // ops-facing (whoever's actually scheduling/running the job), not
      // accounts. `insuranceExpiryDate` only exists on vessels where staff
      // have actually entered it; a vessel with nothing on file yet doesn't
      // get flagged here — that's a data-completeness gap, not an
      // expiry, and would just be noise for a shop that doesn't track this
      // for every boat.
      const insuranceCutoff = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);
      const vesselsInsuranceExpiringSoon = vessels.filter(
        (v: any) => v.insuranceExpiryDate && v.insuranceExpiryDate >= todayStr && v.insuranceExpiryDate <= insuranceCutoff
      );
      for (const v of vesselsInsuranceExpiringSoon) {
        items.push({
          id: `vessel-insurance-expiring-${v.id}`,
          title: `Insurance expiring soon on ${v.name}`,
          category: "Insurance Expiring",
          urgency: "normal",
          linkType: "customer",
          linkId: v.customerId,
          audience: "ops",
        });
      }

      // Overdue *office* to-dos (Task Centre / staffTasks) only ever lived
      // inside the Task Centre page itself — nothing pushed them back onto
      // Today's Agenda, so a staff member who doesn't happen to open that
      // page in a given day would never know anything was waiting there at
      // all. This is deliberately personal to the CURRENT user only (not
      // looped over every staff member like the rules above), since
      // "haven't viewed it today" only makes sense per-viewer — staffTasks.list
      // stamps lastTaskCentreViewAt each time this user actually loads it.
      const myOpenStaffTasks = allStaffTasks.filter(
        (t) => t.status !== "completed" && t.status !== "cancelled" && (t.ownerId === null || t.ownerId === ctx.user.id)
      );
      const lastViewed = (ctx.user as any).lastTaskCentreViewAt as string | null | undefined;
      const todayStartIso = `${todayStr}T00:00:00.000Z`;
      if (myOpenStaffTasks.length > 0 && (!lastViewed || lastViewed < todayStartIso)) {
        items.push({
          id: "task-centre-unread-today",
          title: `${myOpenStaffTasks.length} open Task Centre item${myOpenStaffTasks.length > 1 ? "s" : ""} — you haven't checked today`,
          category: "Task Centre Unread",
          urgency: "normal",
          linkType: "task",
          linkId: myOpenStaffTasks[0].id,
        });
      }

      // Personalize in two layers. First, and most specific: if a quote,
      // job, invoice, inventory item, or material request has a real owner
      // (assignedTo), this item is personal — only that person (and admin,
      // who sees everything regardless) sees it, full stop. Second, for
      // anything nobody's explicitly claimed yet, fall back to the
      // role-based accounts/ops split already used on the Dashboard's Role
      // Focus panel, so unowned items are still visible to the right team
      // rather than silently disappearing.
      let visibleItems = items;
      if (ctx.user.role !== "admin") {
        visibleItems = items.filter((i) => {
          if (i.assignedTo != null) return i.assignedTo === ctx.user.id;
          if (ctx.user.role === "office_staff") return i.audience !== "ops";
          if (ctx.user.role === "management") return i.audience !== "accounts";
          return true;
        });
      }

      // Most urgent first.
      visibleItems = withoutMuted(visibleItems);
      visibleItems.sort((a, b) => order[a.urgency] - order[b.urgency]);
      return visibleItems;
    } catch (error) {
      console.error("Error computing daily agenda:", error);
      throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    }
  }),

  // Personal, per-account — muting a category only affects what this user
  // sees, not the underlying reminder itself (it still fires for whoever
  // hasn't muted it, and the thing it's warning about still needs fixing).
  muteCategory: protectedProcedure.input(z.object({ category: z.string().min(1).max(80) })).mutation(async ({ input, ctx }) => {
    const current = new Set(((ctx.user as any).mutedAgendaCategories as string[] | null) || []);
    current.add(input.category);
    await db.updateUser(ctx.user.id, { mutedAgendaCategories: Array.from(current) as any });
    return { muted: Array.from(current) };
  }),

  unmuteCategory: protectedProcedure.input(z.object({ category: z.string().min(1).max(80) })).mutation(async ({ input, ctx }) => {
    const current = new Set(((ctx.user as any).mutedAgendaCategories as string[] | null) || []);
    current.delete(input.category);
    await db.updateUser(ctx.user.id, { mutedAgendaCategories: Array.from(current) as any });
    return { muted: Array.from(current) };
  }),

  mutedCategories: protectedProcedure.query(({ ctx }) => {
    return ((ctx.user as any).mutedAgendaCategories as string[] | null) || [];
  }),
});
