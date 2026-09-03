import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Mic, Square, Plus, Trash2, ListPlus, Lightbulb } from "lucide-react";
import { useVoiceInput } from "@/hooks/useVoiceInput";
import { trpc } from "@/lib/trpc";
import { toast } from "sonner";

export type LineItem = {
  id: string;
  description: string;
  quantity: number;
  unitPrice: number;
};

function extractPrice(text: string): number | null {
  const match = text.match(/\$?\s?(\d+(?:\.\d{1,2})?)/);
  return match ? parseFloat(match[1]) : null;
}

function extractQuantity(text: string): number | null {
  const match = text.match(/(\d+(?:\.\d+)?)\s*(?:hours?|hrs?|x|units?|litres?|liters?)/i);
  return match ? parseFloat(match[1]) : null;
}

function useDebouncedValue<T>(value: T, delayMs: number) {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(t);
  }, [value, delayMs]);
  return debounced;
}

function PriceSuggestion({ description }: { description: string }) {
  const debounced = useDebouncedValue(description.trim(), 500);
  const suggestionQuery = trpc.predictions.suggestForText.useQuery(debounced, {
    enabled: debounced.length > 2,
    staleTime: 60_000,
  });

  const stats = suggestionQuery.data?.priceStats;
  if (!debounced || debounced.length <= 2 || !stats) return null;

  return (
    <p className="mt-1 flex items-center gap-1 text-xs text-ink-light">
      <Lightbulb className="h-3 w-3 text-amber-500" />
      Similar line items averaged ${stats.avgUnitPrice.toFixed(2)} (based on {stats.sampleCount} past{" "}
      {stats.sampleCount === 1 ? "quote" : "quotes"})
    </p>
  );
}

export function LineItemsEditor({
  items,
  onChange,
}: {
  items: LineItem[];
  onChange: (items: LineItem[]) => void;
}) {
  const { isListening, isSupported, transcript, start, stop } = useVoiceInput();
  const [catalogValue, setCatalogValue] = useState("");
  const servicesQuery = trpc.administration.services.useQuery();

  const addItem = (item: Partial<LineItem> = {}) => {
    onChange([
      ...items,
      {
        id: crypto.randomUUID(),
        description: item.description || "",
        quantity: item.quantity ?? 1,
        unitPrice: item.unitPrice ?? 0,
      },
    ]);
  };

  const updateItem = (id: string, patch: Partial<LineItem>) => {
    onChange(items.map((item) => (item.id === id ? { ...item, ...patch } : item)));
  };

  const removeItem = (id: string) => {
    onChange(items.filter((item) => item.id !== id));
  };

  const handleVoiceToggle = () => {
    if (isListening) {
      stop();
      if (transcript.trim()) {
        const price = extractPrice(transcript);
        const quantity = extractQuantity(transcript);
        addItem({
          description: transcript.trim(),
          quantity: quantity || 1,
          unitPrice: price || 0,
        });
        toast.success("Added line item from voice — check the price/quantity before saving");
      }
    } else {
      if (!isSupported) {
        toast.error("Voice input isn't supported in this browser. Try Chrome or Edge.");
        return;
      }
      start();
    }
  };

  const handleAddFromCatalog = (serviceId: string) => {
    const service = (servicesQuery.data || []).find((s: any) => s.id.toString() === serviceId);
    if (!service) return;
    addItem({ description: service.name, quantity: 1, unitPrice: service.defaultPrice || 0 });
    setCatalogValue("");
  };

  const total = items.reduce((sum, item) => sum + item.quantity * item.unitPrice, 0);

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <label className="block text-sm font-medium text-slate-900">Line Items</label>
        <div className="flex flex-wrap justify-end gap-2">
          {(servicesQuery.data || []).length > 0 && (
            <Select value={catalogValue} onValueChange={handleAddFromCatalog}>
              <SelectTrigger className="h-8 w-56 border-slate-200 text-xs">
                <div className="flex items-center gap-1.5">
                  <ListPlus className="h-3.5 w-3.5 text-slate-500" />
                  <SelectValue placeholder="Add from catalog..." />
                </div>
              </SelectTrigger>
              <SelectContent>
                {(servicesQuery.data || []).map((s: any) => (
                  <SelectItem key={s.id} value={s.id.toString()}>
                    {s.name} — ${(s.defaultPrice || 0).toFixed(2)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          {isSupported && (
            <Button
              type="button"
              variant={isListening ? "destructive" : "outline"}
              size="sm"
              onClick={handleVoiceToggle}
            >
              {isListening ? (
                <>
                  <Square className="mr-1.5 h-3.5 w-3.5" /> Stop
                </>
              ) : (
                <>
                  <Mic className="mr-1.5 h-3.5 w-3.5" /> Speak to add
                </>
              )}
            </Button>
          )}
          <Button type="button" variant="outline" size="sm" onClick={() => addItem()}>
            <Plus className="mr-1.5 h-3.5 w-3.5" /> Add row
          </Button>
        </div>
      </div>

      {isListening && (
        <div className="rounded-lg border border-blue-200 bg-blue-50 px-3 py-2 text-sm text-blue-800">
          Listening... "{transcript || "say what to add, e.g. replace impeller, 2 hours, $180"}"
        </div>
      )}

      {items.length === 0 ? (
        <p className="rounded-lg border border-dashed border-slate-200 p-4 text-center text-sm text-slate-500">
          No line items yet. Use "Speak to add," pick from the catalog, or "Add row" to build the quote.
        </p>
      ) : (
        <div className="space-y-2">
          <div className="flex items-center gap-2 px-2 text-xs font-medium text-slate-500">
            <span className="flex-1">Description</span>
            <span className="w-20 text-center">Qty</span>
            <span className="w-24 text-center">Unit Price ($)</span>
            <span className="w-9" />
          </div>
          {items.map((item) => (
            <div key={item.id} className="rounded-lg border border-slate-200 p-2">
              <div className="flex items-center gap-2">
                <Input
                  value={item.description}
                  onChange={(e) => updateItem(item.id, { description: e.target.value })}
                  placeholder="Description"
                  className="flex-1 border-slate-200"
                />
                <Input
                  type="number"
                  step="0.5"
                  value={item.quantity}
                  onChange={(e) => updateItem(item.id, { quantity: parseFloat(e.target.value) || 0 })}
                  placeholder="Qty"
                  title="Quantity"
                  className="w-20 border-slate-200"
                />
                <Input
                  type="number"
                  step="0.01"
                  value={item.unitPrice}
                  onChange={(e) => updateItem(item.id, { unitPrice: parseFloat(e.target.value) || 0 })}
                  placeholder="Unit $"
                  title="Unit price in dollars"
                  className="w-24 border-slate-200"
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  onClick={() => removeItem(item.id)}
                  className="shrink-0 text-red-500 hover:bg-red-50 hover:text-red-600"
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
              <PriceSuggestion description={item.description} />
            </div>
          ))}
          <div className="flex justify-end pt-1 text-sm font-medium text-slate-700">
            Line items total: ${total.toFixed(2)}
          </div>
        </div>
      )}
    </div>
  );
}
