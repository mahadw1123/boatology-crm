import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { GST_RATE, quoteBreakdown, type QuoteDiscountType, type QuoteTaxMode } from "@shared/quoteMath";
import type { LineItem } from "@/components/LineItemsEditor";

export type QuotePricing = {
  taxMode: QuoteTaxMode;
  discountType: QuoteDiscountType;
  discountValue: string;
  paymentTermsDays: string;
};

export const DEFAULT_QUOTE_PRICING: QuotePricing = {
  taxMode: "exclusive",
  discountType: "none",
  discountValue: "",
  paymentTermsDays: "7",
};

export function quotePricingPayload(p: QuotePricing) {
  return {
    taxMode: p.taxMode,
    discountType: p.discountType,
    discountValue: p.discountType === "none" ? 0 : parseFloat(p.discountValue) || 0,
    paymentTermsDays: parseInt(p.paymentTermsDays) || 0,
  };
}

export function computeQuoteMoney(items: LineItem[], labour: number, parts: number, p: QuotePricing, gstPercent?: number) {
  return quoteBreakdown({
    gstRate: gstPercent != null ? gstPercent / 100 : undefined,
    lineItems: items,
    laborCost: labour,
    partsCost: parts,
    taxMode: p.taxMode,
    discountType: p.discountType,
    discountValue: p.discountType === "none" ? 0 : parseFloat(p.discountValue) || 0,
  });
}

const money = (n: number) => `$${n.toFixed(2)}`;

export function QuotePricingFields({
  value,
  onChange,
  breakdown,
  showBreakdown,
  gstPercent,
}: {
  gstPercent?: number;
  value: QuotePricing;
  onChange: (v: QuotePricing) => void;
  breakdown: ReturnType<typeof quoteBreakdown>;
  showBreakdown: boolean;
}) {
  const pct = gstPercent ?? Math.round(GST_RATE * 1000) / 10;
  return (
    <div className="space-y-3 rounded-lg border border-slate-200 p-3">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <div>
          <label className="block text-xs font-medium text-slate-900">Tax</label>
          <Select value={value.taxMode} onValueChange={(v) => onChange({ ...value, taxMode: v as QuoteTaxMode })}>
            <SelectTrigger className="mt-1 h-9 border-slate-200">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="exclusive">Tax exclusive (+{pct}% GST on top)</SelectItem>
              <SelectItem value="inclusive">Tax inclusive (GST in prices)</SelectItem>
              <SelectItem value="none">No tax</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div>
          <label className="block text-xs font-medium text-slate-900">Discount</label>
          <div className="mt-1 flex gap-2">
            <Select value={value.discountType} onValueChange={(v) => onChange({ ...value, discountType: v as QuoteDiscountType })}>
              <SelectTrigger className="h-9 w-28 border-slate-200">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">None</SelectItem>
                <SelectItem value="percent">Percent %</SelectItem>
                <SelectItem value="fixed">Fixed $</SelectItem>
              </SelectContent>
            </Select>
            <Input
              type="number"
              step="0.01"
              min="0"
              disabled={value.discountType === "none"}
              value={value.discountValue}
              onChange={(e) => onChange({ ...value, discountValue: e.target.value })}
              className="h-9 border-slate-200"
            />
          </div>
        </div>
        <div>
          <label className="block text-xs font-medium text-slate-900">Payment terms</label>
          <Select value={value.paymentTermsDays} onValueChange={(v) => onChange({ ...value, paymentTermsDays: v })}>
            <SelectTrigger className="mt-1 h-9 border-slate-200">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="0">Due on receipt</SelectItem>
              <SelectItem value="7">Net 7 days</SelectItem>
              <SelectItem value="14">Net 14 days</SelectItem>
              <SelectItem value="30">Net 30 days</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>
      {showBreakdown && (
        <dl className="ml-auto w-full max-w-xs space-y-1 text-sm">
          <div className="flex justify-between text-slate-600">
            <dt>Subtotal</dt>
            <dd>{money(breakdown.subtotal)}</dd>
          </div>
          {breakdown.discountAmount > 0 && (
            <div className="flex justify-between text-slate-600">
              <dt>Discount</dt>
              <dd>-{money(breakdown.discountAmount)}</dd>
            </div>
          )}
          {value.taxMode !== "none" && (
            <div className="flex justify-between text-slate-600">
              <dt>{value.taxMode === "inclusive" ? "Includes GST" : "GST"}</dt>
              <dd>{money(breakdown.taxAmount)}</dd>
            </div>
          )}
          <div className="flex justify-between border-t border-slate-200 pt-1 font-semibold text-slate-900">
            <dt>Total</dt>
            <dd>{money(breakdown.total)}</dd>
          </div>
        </dl>
      )}
    </div>
  );
}
