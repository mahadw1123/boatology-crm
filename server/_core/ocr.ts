import Anthropic from "@anthropic-ai/sdk";
import { ENV } from "./env";

let client: Anthropic | null = null;
function getClient() {
  if (!ENV.anthropicApiKey) return null;
  if (!client) client = new Anthropic({ apiKey: ENV.anthropicApiKey });
  return client;
}

export function isOcrConfigured() {
  return !!ENV.anthropicApiKey;
}

export type ExtractedReceiptItem = {
  description: string;
  quantity: number;
  unitPrice: number;
};

export type ExtractedReceipt = {
  supplier: string | null;
  invoiceNumber: string | null;
  purchaseDate: string | null;
  items: ExtractedReceiptItem[];
  gstAmount: number | null;
  totalAmount: number | null;
};

const EXTRACTION_PROMPT = `You are reading a photo of a supplier receipt or invoice for a marine repair business. Extract the following as JSON only — no markdown, no commentary, no code fences, just the raw JSON object:

{
  "supplier": string or null,
  "invoiceNumber": string or null,
  "purchaseDate": string (YYYY-MM-DD) or null,
  "items": [{ "description": string, "quantity": number, "unitPrice": number }],
  "gstAmount": number or null,
  "totalAmount": number or null
}

Rules:
- If a field genuinely isn't visible or legible, use null — never guess or invent a value.
- "quantity" and "unitPrice" must be numbers, not strings.
- If the receipt shows only a single lump total with no itemised breakdown, return one item with your best description and the total as unitPrice with quantity 1.
- Return ONLY the JSON object, nothing else.`;

/** Reads a receipt/invoice image and extracts structured cost data using
 * Claude's vision capability. Staff must still review and confirm the
 * result before it's saved as a real Job Cost entry — this is assistance,
 * not blind auto-entry, since it's real financial data. */
export async function extractReceiptData(base64Image: string, mediaType: string): Promise<ExtractedReceipt> {
  const anthropic = getClient();
  if (!anthropic) {
    throw new Error("OCR is not configured — ANTHROPIC_API_KEY is not set.");
  }

  const validMediaType = ["image/jpeg", "image/png", "image/gif", "image/webp"].includes(mediaType)
    ? (mediaType as "image/jpeg" | "image/png" | "image/gif" | "image/webp")
    : "image/jpeg";

  const message = await anthropic.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 1024,
    messages: [
      {
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: validMediaType, data: base64Image } },
          { type: "text", text: EXTRACTION_PROMPT },
        ],
      },
    ],
  });

  const textBlock = message.content.find((b) => b.type === "text");
  if (!textBlock || textBlock.type !== "text") {
    throw new Error("OCR extraction returned no readable content.");
  }

  const cleaned = textBlock.text.replace(/```json|```/g, "").trim();
  let parsed: ExtractedReceipt;
  try {
    parsed = JSON.parse(cleaned);
  } catch (e) {
    throw new Error("OCR extraction did not return valid JSON — the receipt may be too unclear to read.");
  }

  return {
    supplier: parsed.supplier || null,
    invoiceNumber: parsed.invoiceNumber || null,
    purchaseDate: parsed.purchaseDate || null,
    items: Array.isArray(parsed.items) ? parsed.items : [],
    gstAmount: typeof parsed.gstAmount === "number" ? parsed.gstAmount : null,
    totalAmount: typeof parsed.totalAmount === "number" ? parsed.totalAmount : null,
  };
}
