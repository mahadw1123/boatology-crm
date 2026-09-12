import cron from "node-cron";
import fs from "fs";
import * as db from "../db";
import { sendEmail, emailTemplates } from "./email";
import { ENV } from "./env";
import { runScheduledStripeReconciliationCheck } from "./paymentReconciliation";
import { runAllTaskRules } from "./taskRules";
import { recordHeartbeat } from "./health";
import { createDatabaseSnapshot } from "./backup";
import { captureSystemError } from "./monitoring";

/** Email addresses that should receive the daily Morning Briefing —
 * staff accounts plus any manually-added external addresses. Configured in
 * Administration → Settings:
 * - morning_briefing_recipient_ids (comma-separated user ids) — an
 *   empty/unset setting means "every active admin, office staff, and
 *   management user", the original default behaviour, kept so this never
 *   silently goes to nobody.
 * - morning_briefing_extra_emails (comma-separated raw email addresses) —
 *   for anyone who should get the briefing without needing a login (an
 *   owner checking in from outside the CRM, an accountant, etc). */
async function getMorningBriefingRecipientEmails(): Promise<string[]> {
  const staff = await db.getStaffUsers();
  const allSettings = await db.getSettings();
  const rawIds = allSettings.find((s) => s.key === "morning_briefing_recipient_ids")?.value?.trim();
  const staffRecipients = rawIds
    ? staff.filter((u) => new Set(rawIds.split(",").map((id) => parseInt(id.trim(), 10))).has(u.id))
    : staff;
  const staffEmails = staffRecipients.map((u) => u.email).filter((e): e is string => !!e);

  const rawExtra = allSettings.find((s) => s.key === "morning_briefing_extra_emails")?.value?.trim();
  const extraEmails = rawExtra ? rawExtra.split(",").map((e) => e.trim()).filter(Boolean) : [];

  return [...new Set([...staffEmails, ...extraEmails])];
}

async function sendScheduledMorningBriefing() {
  try {
    const recipientEmails = await getMorningBriefingRecipientEmails();
    const data = await db.getMorningBriefingData();
    // The exact same template as the on-demand "Email to Me" button, so
    // scheduled and manual delivery never drift apart.
    const html = emailTemplates.morningBriefing(data);
    let sent = 0;
    for (const email of recipientEmails) {
      await sendEmail({ to: email, subject: "{{COMPANY_NAME}} — Morning Briefing", html });
      sent++;
    }
    console.log(`[Scheduler] Morning Briefing sent to ${sent} recipient(s).`);
    await recordHeartbeat("morning_briefing", "ok", `Sent to ${sent} recipient(s).`);
  } catch (error) {
    console.error("[Scheduler] Failed to send scheduled Morning Briefing:", error);
    await recordHeartbeat("morning_briefing", "failed", error instanceof Error ? error.message : "Unknown error");
  }
}

async function runScheduledReminderCheck() {
  try {
    const { remindersCreated } = await db.runUnsentQuoteReminderCheckForAllStaff();
    console.log(`[Scheduler] Reminder check complete — ${remindersCreated} new reminder(s) created.`);
    await recordHeartbeat("reminder_check", "ok", `${remindersCreated} new reminder(s).`);
  } catch (error) {
    console.error("[Scheduler] Failed to run scheduled reminder check:", error);
    await recordHeartbeat("reminder_check", "failed", error instanceof Error ? error.message : "Unknown error");
  }
}

async function runScheduledReconciliation() {
  try {
    const { checked, mismatches } = await runScheduledStripeReconciliationCheck();
    console.log(`[Scheduler] Stripe reconciliation check complete — ${checked} invoice(s) checked, ${mismatches} mismatch(es) found.`);
    await recordHeartbeat("stripe_reconciliation", "ok", `${checked} checked, ${mismatches} mismatch(es).`);
  } catch (error) {
    console.error("[Scheduler] Stripe reconciliation check failed:", error);
    await recordHeartbeat("stripe_reconciliation", "failed", error instanceof Error ? error.message : "Unknown error");
  }
}

async function runScheduledTaskRules() {
  try {
    const result = await runAllTaskRules();
    console.log(`[Scheduler] Task rules complete — ${result.totalCreated} new task(s) created.`);
    await recordHeartbeat("task_rules", "ok", `${result.totalCreated} new task(s).`);
  } catch (error) {
    console.error("[Scheduler] Task rules run failed:", error);
    await recordHeartbeat("task_rules", "failed", error instanceof Error ? error.message : "Unknown error");
  }
}

const MAX_SHIFT_HOURS = 8;

/** A forgotten clock-out otherwise sits open forever, silently inflating
 * whatever job it's tied to by a full extra day (or more) of labour cost
 * every time someone looks at it — this is the same bug class as the
 * corrupted-hours issue fixed earlier (computing hours from a clock-in
 * that was never properly closed), just the "still happening" version.
 * Caps any entry open longer than a standard shift at exactly 8 hours,
 * clocked out at the point it actually hit that mark — not "now", which
 * would just re-introduce a smaller version of the same inflation. */
async function runScheduledAutoClockOut() {
  try {
    const stale = await db.getStaleActiveTimeEntries(MAX_SHIFT_HOURS);
    for (const entry of stale) {
      const clockOutTime = new Date(new Date(entry.clockInTime!).getTime() + MAX_SHIFT_HOURS * 60 * 60 * 1000).toISOString();
      const note = "Auto clocked out after 8 hours — no manual clock-out was recorded.";
      await db.updateTimeEntry(entry.id, {
        clockOutTime,
        hoursWorked: MAX_SHIFT_HOURS,
        notes: entry.notes ? `${entry.notes}\n${note}` : note,
      });
    }
    if (stale.length > 0) console.log(`[Scheduler] Auto clock-out closed ${stale.length} stale time entr${stale.length === 1 ? "y" : "ies"}.`);
    await recordHeartbeat("auto_clock_out", "ok", `${stale.length} closed.`);
  } catch (error) {
    console.error("[Scheduler] Auto clock-out sweep failed:", error);
    await recordHeartbeat("auto_clock_out", "failed", error instanceof Error ? error.message : "Unknown error");
  }
}

// Resend accepts attachments up to ~40MB per request, but base64 inflates
// the raw file by roughly a third and a request that large is slow and
// fragile over email generally — capped well under that so a growing
// database degrades into a loud, actionable failure (see the alert this
// throws into) long before it silently stops actually working.
const MAX_BACKUP_ATTACHMENT_BYTES = 18 * 1024 * 1024;

/** Daily off-server database backup — emailed as an attachment to whoever's
 * configured in Administration → Settings, using the email infrastructure
 * that's already set up rather than requiring a separate cloud storage
 * account and SDK just to get one file off the server periodically. This
 * is deliberately not a scheduled cloud-storage upload: it works the
 * moment email is configured, on any host, with no extra credentials —
 * if the database grows past what's practical to email (see the size cap
 * above), that's the point at which a dedicated S3-compatible upload
 * becomes worth the extra setup, not before. */
async function runScheduledDatabaseBackup() {
  let snapshotPath: string | null = null;
  try {
    const settings = await db.getSettings();
    const recipient = settings.find((s) => s.key === "backup_recipient_email")?.value?.trim();
    if (!recipient) {
      console.log("[Scheduler] Database backup skipped — no backup_recipient_email configured in Administration → Settings.");
      await recordHeartbeat("database_backup", "ok", "Skipped — no recipient configured.");
      return;
    }

    snapshotPath = await createDatabaseSnapshot();
    const stat = fs.statSync(snapshotPath);
    if (stat.size > MAX_BACKUP_ATTACHMENT_BYTES) {
      const error = new Error(
        `Database snapshot is ${(stat.size / (1024 * 1024)).toFixed(1)}MB — too large to email safely. Set up an S3-compatible upload for backups instead of the email-based one.`
      );
      captureSystemError(error, { source: "backup", severity: "fatal", route: "scheduled_backup" });
      await recordHeartbeat("database_backup", "failed", error.message);
      return;
    }

    const content = fs.readFileSync(snapshotPath).toString("base64");
    const today = new Date().toISOString().slice(0, 10);
    await sendEmail({
      to: recipient,
      subject: `{{COMPANY_NAME}} database backup — ${today}`,
      html: `<p>Attached is today's automatic database backup (${(stat.size / (1024 * 1024)).toFixed(2)}MB).</p>
             <p>Keep these somewhere safe outside your email inbox too if you can — this email is the off-server copy, not the only one that should exist.</p>`,
      attachments: [{ filename: `boatology-backup-${today}.db`, content }],
    });

    console.log(`[Scheduler] Database backup emailed to ${recipient} (${(stat.size / (1024 * 1024)).toFixed(2)}MB).`);
    await recordHeartbeat("database_backup", "ok", `Sent to ${recipient}, ${(stat.size / (1024 * 1024)).toFixed(2)}MB.`);
  } catch (error) {
    console.error("[Scheduler] Database backup failed:", error);
    captureSystemError(error, { source: "backup", severity: "fatal", route: "scheduled_backup" });
    await recordHeartbeat("database_backup", "failed", error instanceof Error ? error.message : "Unknown error");
  } finally {
    if (snapshotPath) {
      try {
        fs.unlinkSync(snapshotPath);
      } catch (cleanupError) {
        console.error("[Scheduler] Failed to remove temporary backup snapshot:", cleanupError);
      }
    }
  }
}

let started = false;

/** Starts the background schedule. Safe to call once at server boot — a
 * second call is a no-op, since re-registering the same cron jobs would
 * otherwise double up every scheduled run. */
export function startScheduler() {
  if (started) return;
  started = true;

  const timezone = ENV.schedulerTimezone;

  // 7:00am daily: the Morning Briefing, genuinely automatic — no one needs
  // to click anything, unlike the on-demand "Email to Me" button.
  cron.schedule("0 7 * * *", sendScheduledMorningBriefing, { timezone });

  // 7:15am daily: the reminder check, for every staff member regardless of
  // who's actually logged in that day — this is what closes the gap the
  // implementation report flagged (reminders previously only fired when
  // someone's own dashboard happened to load).
  cron.schedule("15 7 * * *", runScheduledReminderCheck, { timezone });

  // Every 30 minutes: catches a payment that succeeded in Stripe but never
  // got marked paid in Boatology (a missed/delayed webhook) well before
  // the next morning briefing would surface it. Detection only — the
  // actual fix stays a reviewed admin action, not something a cron job
  // decides on its own.
  cron.schedule("*/30 * * * *", runScheduledReconciliation, { timezone });

  // Every 30 minutes: the automatic task rules (unpaid deposits, unassigned
  // jobs, jobs missing a final invoice, materials approved but not
  // ordered). Each rule dedups on its own ruleKey and resolves its own
  // task once the underlying condition clears, so this is safe to run
  // repeatedly without accumulating duplicates or stale tasks.
  cron.schedule("*/30 * * * *", runScheduledTaskRules, { timezone });

  // Every 30 minutes: close out anyone still clocked in 8+ hours after
  // starting, since nobody should ever need to remember to clock out —
  // this makes it happen on its own instead of just reminding someone.
  cron.schedule("*/30 * * * *", runScheduledAutoClockOut, { timezone });

  // 3:00am daily: an off-server database backup, emailed to whoever's
  // configured in Administration → Settings. Quiet no-op until a recipient
  // is actually set, so this is safe to ship without forcing setup first.
  cron.schedule("0 3 * * *", runScheduledDatabaseBackup, { timezone });

  console.log(`[Scheduler] Started — Morning Briefing, reminder checks, Stripe reconciliation, task rules, auto clock-out, and database backup scheduled (${timezone}).`);
}

// Exported for testing — lets a test trigger a run immediately rather than
// waiting for the actual scheduled time.
export const _internal = {
  sendScheduledMorningBriefing,
  runScheduledReminderCheck,
  runScheduledReconciliation,
  runScheduledTaskRules,
  runScheduledAutoClockOut,
  runScheduledDatabaseBackup,
};
