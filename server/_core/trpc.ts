import { TRPCError, initTRPC } from "@trpc/server";
import type * as trpcExpress from "@trpc/server/adapters/express";
import { parse as parseCookieHeader } from "cookie";
import { COOKIE_NAME } from "@shared/const";
import { verifySessionToken } from "./auth";
import * as db from "../db";
import type { User } from "../../drizzle/schema";

export async function createContext({ req, res }: trpcExpress.CreateExpressContextOptions) {
  const cookies = parseCookieHeader(req.headers.cookie || "");
  const token = cookies[COOKIE_NAME];
  let user: User | null = null;

  if (token) {
    const session = await verifySessionToken(token);
    if (session) {
      const candidate = (await db.getUserById(session.userId)) ?? null;
      if (candidate?.isActive && candidate.sessionVersion === session.sessionVersion) user = candidate;
    }
  }

  return { req, res, user };
}

type Context = Awaited<ReturnType<typeof createContext>>;

const t = initTRPC.context<Context>().create({
  // Strips the stack trace (absolute server file paths, library internals,
  // exact source lines) from every error the client actually receives.
  // The message and error code still come through fine — that's all a
  // legitimate client needs — but nothing here should ever help someone
  // map out the server's internal structure. The full error, stack
  // included, is still logged server-side via the individual console.error
  // calls throughout the routers, so nothing is lost for debugging.
  errorFormatter({ shape }) {
    const defaults: Partial<Record<string, string>> = {
      UNAUTHORIZED: "Your session has expired. Sign in again to continue.",
      FORBIDDEN: "You don’t have permission to do that. Return to a page available for your account.",
      NOT_FOUND: "This record no longer exists or was removed. Return to the previous list and refresh.",
      CONFLICT: "This record changed or already exists. Refresh the page and try again.",
      BAD_REQUEST: "Some information wasn’t accepted. Review the form and try again.",
      PRECONDITION_FAILED: "This action needs another step first. Follow the instructions shown and try again.",
      INTERNAL_SERVER_ERROR: "We couldn’t complete that action. Try again, then contact an administrator if it continues.",
    };
    const genericMessages = new Set([shape.data.code, "", "Internal server error"]);
    const message = genericMessages.has(shape.message) ? defaults[shape.data.code] || shape.message : shape.message;
    return {
      ...shape,
      message,
      data: {
        code: shape.data.code,
        httpStatus: shape.data.httpStatus,
        path: shape.data.path,
      },
    };
  },
});

export const router = t.router;
export const middleware = t.middleware;
export const publicProcedure = t.procedure;

const isAuthed = middleware(({ ctx, next }) => {
  if (!ctx.user || !ctx.user.isActive) {
    throw new TRPCError({ code: "UNAUTHORIZED" });
  }
  return next({ ctx: { ...ctx, user: ctx.user } });
});

export const protectedProcedure = t.procedure.use(isAuthed);

export function requireRole(...roles: User["role"][]) {
  return middleware(({ ctx, next }) => {
    if (!ctx.user || !roles.includes(ctx.user.role)) {
      throw new TRPCError({ code: "FORBIDDEN" });
    }
    return next({ ctx });
  });
}
