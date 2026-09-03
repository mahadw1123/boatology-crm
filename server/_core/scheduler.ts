import cron from "node-cron";
import * as db from "../db";
import { sendEmail } from "./email";
import { ENV } from "./env";
import { runBackup } from "./backup";

/** Builds the same Morning Briefing HTML used by the on-demand "Email to
 * Me" button, so scheduled and manual delivery never drift apart. */
function buildMorningBriefingHtml(data: Awaited<ReturnType<typeof db.getMorningBriefingData>>) {
  return `
    <h2>{{COMPANY_NAME}} — Morning Briefing</h2>
    <p style="color:#666;font-size:12px;">${new Date(data.generatedAt).toLocaleString("en-AU")}</p>
    <h3>Overdue Jobs (${data.jobsOverdue.length})</h3>
    <ul>${data.jobsOverdue.map((j) => `<li>${j.jobNumber} — ${j.customerName}</li>`).join("") || "<li>None</li>"}</ul>
    <h3>Jobs Due Today (${data.jobsToday.length})</h3>
    <ul>${data.jobsToday.map((j) => `<li>${j.jobNumber} — ${j.customerName}</li>`).join("") || "<li>None</li>"}</ul>
    <h3>Quotes Awaiting Approval (${data.quotesAwaiting.length})</h3>
    <ul>${data.quotesAwaiting.map((q) => `<li>${q.quoteNumber} — $${q.amount.toFixed(2)}</li>`).join("") || "<li>None</li>"}</ul>
    <h3>Deposits Unpaid (${data.depositsUnpaid.length})</h3>
    <ul>${data.depositsUnpaid.map((i) => `<li>${i.invoiceNumber} — $${i.amount.toFixed(2)}</li>`).join("") || "<li>None</li>"}</ul>
    <h3>Invoices Outstanding (${data.invoicesUnpaid.length})</h3>
    <ul>${data.invoicesUnpaid.map((i) => `<li>${i.invoiceNumber} — $${i.amount.toFixed(2)}</li>`).join("") || "<li>None</li>"}</ul>
    <h3>Low Stock (${data.lowStock.length})</h3>
    <ul>${data.lowStock.map((i) => `<li>${i.name} — ${i.currentStock}/${i.minimumStock}</li>`).join("") || "<li>None</li>"}</ul>
    <h3>Material Requests Pending (${data.pendingMaterialRequests.length})</h3>
    <ul>${data.pendingMaterialRequests.map((r) => `<li>${r.quantity}x ${r.materialName} (${r.urgency})</li>`).join("") || "<li>None</li>"}</ul>
  `;
}

async function sendScheduledMorningBriefing() {
  try {
    const staff = await db.getStaffUsers();
    const data = await db.getMorningBriefingData();
    const html = buildMorningBriefingHtml(data);
    let sent = 0;
    for (const user of staff) {
      if (!user.email) continue;
      await sendEmail({ to: user.email, subject: "{{COMPANY_NAME}} — Morning Briefing", html });
      sent++;
    }
    console.log(`[Scheduler] Morning Briefing sent to ${sent} staff member(s).`);
  } catch (error) {
    console.error("[Scheduler] Failed to send scheduled Morning Briefing:", error);
  }
}

async function runScheduledReminderCheck() {
  try {
    const { remindersCreated } = await db.runUnsentQuoteReminderCheckForAllStaff();
    console.log(`[Scheduler] Reminder check complete — ${remindersCreated} new reminder(s) created.`);
  } catch (error) {
    console.error("[Scheduler] Failed to run scheduled reminder check:", error);
  }
}

async function runScheduledBackup() {
  try {
    const result = await runBackup();
    console.log(
      `[Scheduler] Backup complete — db: ${result.dbBackedUp ? "ok" : "FAILED"}, ${result.filesBackedUp} file(s) backed up, saved to ${result.folder}.`
    );
  } catch (error) {
    console.error("[Scheduler] Backup failed:", error);
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

  // 3:00am daily: a quiet hour, unlikely to overlap with anyone actively
  // working, when copying the database and files is least likely to
  // compete with real usage.
  cron.schedule("0 3 * * *", runScheduledBackup, { timezone });

  console.log(`[Scheduler] Started — Morning Briefing and reminder checks scheduled daily at 7:00am/7:15am (${timezone}).`);
}

// Exported for testing — lets a test trigger a run immediately rather than
// waiting for the actual scheduled time.
export const _internal = { sendScheduledMorningBriefing, runScheduledReminderCheck, runScheduledBackup };
