type ClientErrorContext = {
  componentStack?: string;
  route?: string;
  severity?: "warning" | "error";
};

function normalizeError(error: unknown) {
  if (error instanceof Error) return error;
  if (typeof error === "string") return new Error(error);
  try {
    return new Error(JSON.stringify(error));
  } catch {
    return new Error("Unknown browser error");
  }
}

/**
 * Sends unexpected browser failures to the CRM's small built-in monitoring
 * screen. This endpoint is authenticated, rate-limited, and deliberately
 * excludes form values, cookies, tokens, and customer records.
 */
export function reportClientError(error: unknown, context: ClientErrorContext = {}) {
  const normalized = normalizeError(error);
  const payload = JSON.stringify({
    message: normalized.message.slice(0, 1000),
    stack: normalized.stack?.slice(0, 8000),
    componentStack: context.componentStack?.slice(0, 8000),
    route: (context.route || window.location.pathname).slice(0, 500),
    severity: context.severity || "error",
  });

  try {
    if (navigator.sendBeacon) {
      const accepted = navigator.sendBeacon(
        "/api/client-errors",
        new Blob([payload], { type: "application/json" })
      );
      if (accepted) return;
    }
    void fetch("/api/client-errors", {
      method: "POST",
      credentials: "include",
      keepalive: true,
      headers: { "Content-Type": "application/json" },
      body: payload,
    }).catch(() => {
      // Monitoring must never create another visible error for the user.
    });
  } catch {
    // Ignore monitoring transport failures.
  }
}

let installed = false;
export function installGlobalErrorMonitoring() {
  if (installed || typeof window === "undefined") return;
  installed = true;

  window.addEventListener("error", (event) => {
    reportClientError(event.error || event.message, { route: window.location.pathname });
  });

  window.addEventListener("unhandledrejection", (event) => {
    reportClientError(event.reason, { route: window.location.pathname });
  });
}
