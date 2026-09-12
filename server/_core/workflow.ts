import * as db from "../db";

export { QUOTE_SENT_STATUS, assertQuoteIsSent } from "./quoteStatus";

export type JobEligibility = {
  eligible: boolean;
  reasons: string[];
};

/**
 * Centralizes what "eligible for job creation" means for a quote-linked
 * job, so this definition lives in exactly one place instead of being
 * reimplemented inline at every call site that needs to know it (job
 * creation today; the eligibility-preview endpoint and any future admin
 * override flow tomorrow). A job with no source quote is always eligible —
 * this only gates the quote-linked path.
 */
export async function getJobEligibility(quoteId: number | null | undefined): Promise<JobEligibility> {
  if (!quoteId) return { eligible: true, reasons: [] };

  const quote = await db.getQuoteById(quoteId);
  if (!quote) {
    return { eligible: false, reasons: ["That quote doesn't exist."] };
  }

  const deposit = await db.getDepositInvoiceForQuote(quoteId);
  if (!deposit) {
    // No deposit invoice exists in exactly one legitimate case: the quote
    // was accepted while the deposit percentage was configured as 0% (no
    // deposit required), so acceptance never created one. Any other status
    // means it genuinely hasn't been accepted yet.
    if (quote.status === "accepted") return { eligible: true, reasons: [] };
    return {
      eligible: false,
      reasons: ["This quote doesn't have a deposit invoice yet — it needs to be accepted by the customer first, which generates the deposit automatically."],
    };
  }
  if (deposit.status !== "paid") {
    return {
      eligible: false,
      reasons: [`The deposit (${deposit.invoiceNumber}, $${deposit.totalDue.toFixed(2)}) hasn't been paid yet — a job can't be created until it's received.`],
    };
  }

  return { eligible: true, reasons: [] };
}
