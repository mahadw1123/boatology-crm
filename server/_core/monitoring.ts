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
    source?: "server" | "browser" | "payment" | "email" | "background";
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
    }

    return recorded;
  } catch (monitoringError) {
    // Monitoring must never take down the application it is observing.
    console.error("[Monitoring] Failed to record error:", monitoringError);
    return null;
  }
}
