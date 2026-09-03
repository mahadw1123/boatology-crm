import type { Request } from "express";
import { parse as parseCookieHeader } from "cookie";
import { COOKIE_NAME } from "@shared/const";
import { verifySessionToken } from "./auth";
import * as db from "../db";

export async function requireAuthUser(req: Request) {
  const cookies = parseCookieHeader(req.headers.cookie || "");
  const token = cookies[COOKIE_NAME];
  if (!token) return null;
  const session = await verifySessionToken(token);
  if (!session) return null;
  const user = await db.getUserById(session.userId);
  if (!user || !user.isActive || user.sessionVersion !== session.sessionVersion) return null;
  return user;
}
