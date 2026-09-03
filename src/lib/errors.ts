import { toast } from "sonner";

type ErrorWithData = Error & {
  data?: { code?: string };
  action?: string;
  actionHref?: string;
};

const defaults: Record<string, string> = {
  UNAUTHORIZED: "Your session has expired. Sign in again to continue.",
  FORBIDDEN: "You don’t have permission to do that. Return to a page available for your account.",
  NOT_FOUND: "This record no longer exists. Return to the previous list and refresh.",
  CONFLICT: "This record changed or already exists. Refresh the page and try again.",
  BAD_REQUEST: "Some information wasn’t accepted. Review the form and try again.",
  PRECONDITION_FAILED: "Another step is required before this action can be completed.",
  INTERNAL_SERVER_ERROR: "We couldn’t complete that action. Try again, then contact an administrator if it continues.",
  TOO_MANY_REQUESTS: "Too many attempts were made. Wait for the time shown, then try again.",
};

function navigationAction(message: string) {
  const routes: Array<[RegExp, string, string]> = [
    [/open contacts|return to contacts/i, "Open Contacts", "/contacts"],
    [/open administration|administration →/i, "Open Administration", "/administration"],
    [/return to quotes|quotes tab|open the quote/i, "Open Quotes", "/quotes"],
    [/open the invoice|return to invoices|refresh the invoice/i, "Open Invoices", "/invoices"],
    [/return to jobs|open jobs/i, "Open Jobs", "/jobs"],
    [/time tracking/i, "Time Tracking", "/time-tracking"],
    [/return to analytics|refresh.*analytics/i, "Open Analytics", "/analytics"],
    [/return to forgot password|forgot password/i, "Reset password", "/forgot-password"],
  ];
  const match = routes.find(([pattern]) => pattern.test(message));
  return match ? { label: match[1], onClick: () => window.location.assign(match[2]) } : undefined;
}

function defaultAction(code?: string) {
  switch (code) {
    case "UNAUTHORIZED":
      return { label: "Sign in", onClick: () => window.location.assign("/") };
    case "FORBIDDEN":
      return { label: "Go back", onClick: () => window.history.back() };
    case "NOT_FOUND":
      return { label: "Dashboard", onClick: () => window.location.assign("/") };
    case "CONFLICT":
      return { label: "Refresh", onClick: () => window.location.reload() };
    case "INTERNAL_SERVER_ERROR":
      return { label: "Retry page", onClick: () => window.location.reload() };
    case "TOO_MANY_REQUESTS":
      return { label: "Back to sign in", onClick: () => window.location.assign("/") };
    default:
      return undefined;
  }
}

export function showErrorToast(error: unknown, fallback = "We couldn’t complete that action.") {
  const value = error as ErrorWithData | null;
  const code = value?.data?.code;
  const rawMessage = value?.message?.trim();
  const networkFailure = !!rawMessage && /failed to fetch|networkerror|load failed|network request failed/i.test(rawMessage);
  const message = networkFailure
    ? "The server could not be reached. Check your connection, then retry the page."
    : rawMessage || (code ? defaults[code] : undefined) || fallback;
  const action = networkFailure
    ? { label: "Retry page", onClick: () => window.location.reload() }
    : value?.action
      ? { label: value.action, onClick: () => value.actionHref ? window.location.assign(value.actionHref) : window.history.back() }
      : navigationAction(message) || defaultAction(code);

  toast.error(message, {
    description: code === "INTERNAL_SERVER_ERROR" ? "Refresh the relevant record before repeating the action, then contact an administrator if the problem continues." : undefined,
    action,
    duration: 7000,
  });
}

export async function throwApiError(response: Response, fallback = "The request could not be completed."): Promise<never> {
  const body = await response.json().catch(() => ({})) as { error?: string; action?: string; actionHref?: string };
  const error = new Error(body.error || fallback) as ErrorWithData;
  error.action = body.action;
  error.actionHref = body.actionHref;
  throw error;
}
