import * as db from "../db";

const REDACTED_KEYS = /password|secret|token|authorization|cookie|card|client[_-]?secret|api[_-]?key/i;

function scrubText(value: string) {
  return value
    .replace(/Bearer\s+[A-Za-z0-9._~+\/-]+=*/gi, "Bearer [redacted]")
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[email]")
    .replace(/([?&](?:token|code|secret|key)=)[^&\s]+/gi, "$1[redacted]")
    .slice(0, 12000);
}

function safeContext(value: unknown, depth = 0): unknown {
  if (depth > 4) return "[truncated]";
  if (value == null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return typeof value === "string" ? scrubText(value).slice(0, 1000) : value;
  }
  if (Array.isArray(value)) return value.slice(0, 20).map((item) => safeContext(item, depth + 1));
  if (typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>).slice(0, 40)) {
      result[key] = REDACTED_KEYS.test(key) ? "[redacted]" : safeContext(item, depth + 1);
    }
    return result;
  }
  return String(value).slice(0, 1000);
}

export function captureSystemError(
  error: unknown,
  details: {
    source?: "server" | "browser" | "payment" | "email" | "background" | "backup";
    severity?: "warning" | "error" | "fatal";
    route?: string | null;
    userId?: number | null;
    context?: Record<string, unknown>;
  } = {}
) {
  try {
    const normalized = error instanceof Error ? error : new Error(typeof error === "string" ? error : "Unknown error");
    const recorded = db.recordSystemError({
      source: details.source || "server",
      severity: details.severity || "error",
      message: scrubText(normalized.message || "Unknown error"),
      stack: normalized.stack ? scrubText(normalized.stack) : null,
      route: details.route || null,
      userId: details.userId || null,
      context: safeContext(details.context || null) as Record<string, unknown> | null,
    }) as { id: number; occurrenceCount: number; message: string } | null;

    if (recorded?.occurrenceCount === 1) {
      void db.getStaffUsers()
        .then((staff) => Promise.all(staff.map((member) => db.createNotification({
          userId: member.id,
          type: "system",
          title: "System error needs attention",
          message: `${recorded.message.slice(0, 180)} Review Administration → System Errors.`,
          relatedEntityType: "system_error",
          relatedEntityId: recorded.id,
        }))))
        .catch((notificationError) => console.error("[Monitoring] Failed to create administrator notification:", notificationError));

      // An in-app notification only reaches someone already logged into the
      // CRM — if the app itself is down, or nobody happens to be looking,
      // a fatal error was previously invisible to anyone outside it. This
      // is the one rung of alerting above that. Dynamically imported
      // (rather than a top-level import) specifically to avoid a circular
      // import: email.ts itself calls captureSystemError on its own
      // send failures.
      if (details.severity === "fatal") {
        void (async () => {
          try {
            const { sendEmail } = await import("./email");
            const staff = await db.getStaffUsers();
            for (const member of staff) {
              if (!member.email) continue;
              await sendEmail({
                to: member.email,
                subject: `{{COMPANY_NAME}} — a fatal error just happened`,
                html: `<p>Something serious went wrong and needs a human to look at it:</p>
                       <p style="margin:16px 0;padding:12px 16px;background:#F5F7FA;border-radius:8px;font-family:monospace;font-size:13px;">${recorded.message.slice(0, 500)}</p>
                       <p>Open Administration → System Errors in the CRM for the full detail.</p>`,
              }).catch((emailError) => console.error("[Monitoring] Failed to send fatal-error alert email:", emailError));
            }
          } catch (alertError) {
            console.error("[Monitoring] Fatal-error external alert failed:", alertError);
          }
        })();
      }
    }

    return recorded;
  } catch (monitoringError) {
    // Monitoring must never take down the application it is observing.
    console.error("[Monitoring] Failed to record error:", monitoringError);
    return null;
  }
}
