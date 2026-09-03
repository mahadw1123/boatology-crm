import { ENV } from "./env";

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

export function getSessionCookieOptions() {
  return {
    httpOnly: true,
    secure: ENV.isProd,
    sameSite: "lax" as const,
    maxAge: THIRTY_DAYS_MS,
    path: "/",
  };
}
