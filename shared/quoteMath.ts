// Single source of truth for quote money maths — imported by both the server
// (which validates/stores totals) and the client (which previews them), so
// the two can never disagree.
// Fallback only — the live rate is an admin setting (Administration → Settings)
// and is passed in as `gstRate` wherever quotes are calculated.
export const GST_RATE = 0.1;

export type QuoteTaxMode = "exclusive" | "inclusive" | "none";
export type QuoteDiscountType = "none" | "percent" | "fixed";

export type QuoteMathInput = {
  lineItems?: Array<{ quantity: number; unitPrice: number; gstApplicable?: boolean }> | null;
  laborCost?: number | null;
  partsCost?: number | null;
  taxMode?: QuoteTaxMode | null;
  discountType?: QuoteDiscountType | null;
  discountValue?: number | null;
  // GST as a fraction (0.1 = 10%). Defaults to GST_RATE when not given.
  gstRate?: number | null;
};

const round2 = (n: number) => Math.round(n * 100) / 100;

export function lineTotal(item: { quantity: number; unitPrice: number }) {
  return round2(item.quantity * item.unitPrice);
}

export function quoteBreakdown(input: QuoteMathInput) {
  const items = input.lineItems || [];
  const labour = input.laborCost || 0;
  const parts = input.partsCost || 0;
  const subtotal = round2(items.reduce((s, i) => s + i.quantity * i.unitPrice, 0) + labour + parts);
  const taxable = items.reduce((s, i) => (i.gstApplicable === false ? s : s + i.quantity * i.unitPrice), 0) + labour + parts;

  let discountAmount = 0;
  if (input.discountType === "percent") discountAmount = subtotal * Math.min(100, input.discountValue || 0) / 100;
  else if (input.discountType === "fixed") discountAmount = Math.min(subtotal, input.discountValue || 0);
  discountAmount = round2(Math.min(subtotal, discountAmount));

  const net = round2(subtotal - discountAmount);
  const ratio = subtotal > 0 ? net / subtotal : 1;
  const taxableNet = taxable * ratio;

  let taxAmount = 0;
  let total = net;
  const mode = input.taxMode || "none";
  const rate = input.gstRate != null && input.gstRate >= 0 ? input.gstRate : GST_RATE;
  if (mode === "exclusive") {
    taxAmount = round2(taxableNet * rate);
    total = round2(net + taxAmount);
  } else if (mode === "inclusive") {
    taxAmount = round2((taxableNet * rate) / (1 + rate));
  }
  return { subtotal, discountAmount, taxAmount, total, taxMode: mode };
}
