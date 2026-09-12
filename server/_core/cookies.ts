import { ENV } from "./env";

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

/** `rememberMe: false` omits maxAge entirely, making it a session cookie
 * that the browser drops when it closes — the actual behavior "Remember
 * me" on the login form controls, not just a label. Every other caller
 * (register, accept invite, admin bootstrap) keeps the 30-day default. */
export function getSessionCookieOptions(rememberMe: boolean = true) {
  return {
    httpOnly: true,
    secure: ENV.isProd,
    sameSite: "lax" as const,
    ...(rememberMe ? { maxAge: THIRTY_DAYS_MS } : {}),
    path: "/",
  };
}
