/**
 * Single source of truth for the quote "must be sent" gate. Deliberately
 * has zero dependencies (not even on db.ts) so both `server/db.ts` and
 * `server/routers.ts` can import it without a circular-import cycle —
 * `server/_core/workflow.ts` (which DOES depend on db.ts, for job
 * eligibility) re-exports this for callers that want both from one place.
 *
 * Before this existed, "a quote must be in the sent state to be accepted
 * or rejected" was independently re-typed as the literal string "sent" in
 * three places (the pre-check in the quotes router, and inside both
 * `acceptQuoteAndEnsureDeposit` and `rejectQuoteIfSent` in db.ts) —
 * consistent today, but nothing stopped them drifting apart as the code
 * evolved. Every one of those call sites now reads this constant instead.
 */
export const QUOTE_SENT_STATUS = "sent" as const;

/** Thrown as the string "QUOTE_NOT_SENT" (matching the error-message
 * contract every existing caller already catches) when a quote isn't in
 * the state required for an accept/reject/deposit action. */
export function assertQuoteIsSent(status: string): void {
  if (status !== QUOTE_SENT_STATUS) {
    throw new Error("QUOTE_NOT_SENT");
  }
}
