import * as db from "../db";
import { ENV } from "./env";
import { isStripeConfigured } from "./stripe";
import { getXeroStatus, isXeroConfigured } from "./xero";

const HEARTBEAT_PREFIX = "scheduler_heartbeat:";

/**
 * Every scheduled job records its own outcome here after each run, using
 * the existing settings key-value table rather than a new one — this is
 * genuinely lightweight state (one row per job), not worth a dedicated
 * table. Read back by the System Health page so "is the background
 * scheduler actually running" has a real, verifiable answer instead of
 * just trusting the server log.
 */
export async function recordHeartbeat(jobName: string, status: "ok" | "failed", detail?: string) {
  try {
    await db.upsertSetting(
      `${HEARTBEAT_PREFIX}${jobName}`,
      JSON.stringify({ status, detail: detail || null, at: new Date().toISOString() }),
      `Last run of the scheduled job "${jobName}"`
    );
  } catch (error) {
    // A heartbeat write failing must never break the job it's reporting on.
    console.error(`[Health] Failed to record heartbeat for ${jobName}:`, error);
  }
}

async function getSchedulerHeartbeats() {
  const all = await db.getSettings();
  return all
    .filter((s) => s.key.startsWith(HEARTBEAT_PREFIX))
    .map((s) => {
      let parsed: { status: string; detail: string | null; at: string } | null = null;
      try {
        parsed = JSON.parse(s.value || "{}");
      } catch {
        // Malformed heartbeat value — surfaced as unknown rather than thrown.
      }
      return { job: s.key.slice(HEARTBEAT_PREFIX.length), ...parsed };
    });
}

async function checkDatabase(): Promise<{ healthy: boolean; detail: string }> {
  try {
    await db.getSettings();
    return { healthy: true, detail: "Reachable." };
  } catch (error) {
    return { healthy: false, detail: error instanceof Error ? error.message : "Query failed." };
  }
}

export async function getSystemHealth() {
  const [databaseCheck, xeroStatus, errors, heartbeats] = await Promise.all([
    checkDatabase(),
    getXeroStatus(),
    db.getSystemErrors(false),
    getSchedulerHeartbeats(),
  ]);

  const errorsBySource = (source: string) => errors.filter((e) => e.source === source);

  const resendConfigured = Boolean(ENV.resendApiKey) && !ENV.emailFrom.includes("onboarding@resend.dev");

  return {
    database: databaseCheck,
    resend: {
      configured: resendConfigured,
      fromAddress: ENV.emailFrom,
      usingTestSender: ENV.emailFrom.includes("onboarding@resend.dev"),
      recentFailures: errorsBySource("email").length,
    },
    stripe: {
      configured: isStripeConfigured(),
      recentFailures: errorsBySource("payment").length,
    },
    xero: {
      configured: isXeroConfigured(),
      connected: xeroStatus.connected,
      tenantName: xeroStatus.tenantName,
      recentFailures: errorsBySource("background").length,
    },
    scheduler: {
      heartbeats,
    },
    errors: {
      unresolved: errors.length,
      fatal: errors.filter((e) => e.severity === "fatal").length,
      recent: errors.slice(0, 5).map((e) => ({ id: e.id, source: e.source, severity: e.severity, message: e.message, lastSeenAt: e.lastSeenAt })),
    },
  };
}
