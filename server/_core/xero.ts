import crypto from "crypto";
import { ENV } from "./env";
import * as db from "../db";

const XERO_AUTH_URL = "https://login.xero.com/identity/connect/authorize";
const XERO_TOKEN_URL = "https://identity.xero.com/connect/token";
const XERO_CONNECTIONS_URL = "https://api.xero.com/connections";
const XERO_API_BASE = "https://api.xero.com/api.xro/2.0";

const SETTINGS_KEY = "xero_tokens";

type XeroTokens = {
  accessToken: string;
  refreshToken: string;
  expiresAt: number; // epoch ms
  tenantId: string | null;
  tenantName: string | null;
};

export function isXeroConfigured() {
  return Boolean(ENV.xeroClientId && ENV.xeroClientSecret);
}

export function getXeroAuthUrl(state: string) {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: ENV.xeroClientId,
    redirect_uri: ENV.xeroRedirectUri,
    scope: "openid profile email accounting.contacts accounting.invoices offline_access",
    state,
  });
  return `${XERO_AUTH_URL}?${params.toString()}`;
}

const ENCRYPTED_PREFIX = "enc:v1";

function encryptionKey() {
  return crypto.createHash("sha256").update(ENV.integrationEncryptionKey).digest();
}

function encryptTokens(tokens: XeroTokens) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(tokens), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [ENCRYPTED_PREFIX, iv.toString("base64url"), tag.toString("base64url"), ciphertext.toString("base64url")].join(":");
}

function decryptTokens(value: string): XeroTokens {
  const [prefix, version, ivText, tagText, ciphertextText] = value.split(":");
  if (`${prefix}:${version}` !== ENCRYPTED_PREFIX || !ivText || !tagText || !ciphertextText) {
    throw new Error("Unsupported encrypted Xero token format");
  }
  const decipher = crypto.createDecipheriv("aes-256-gcm", encryptionKey(), Buffer.from(ivText, "base64url"));
  decipher.setAuthTag(Buffer.from(tagText, "base64url"));
  const plaintext = Buffer.concat([decipher.update(Buffer.from(ciphertextText, "base64url")), decipher.final()]);
  return JSON.parse(plaintext.toString("utf8")) as XeroTokens;
}

async function saveTokens(tokens: XeroTokens) {
  await db.upsertSetting(SETTINGS_KEY, encryptTokens(tokens), "Encrypted Xero OAuth tokens");
}

async function loadTokens(): Promise<XeroTokens | null> {
  const rows = await db.getSettings();
  const row = rows.find((r) => r.key === SETTINGS_KEY);
  if (!row?.value) return null;
  try {
    if (row.value.startsWith(`${ENCRYPTED_PREFIX}:`)) return decryptTokens(row.value);

    // One-time migration for installations created before token encryption.
    // The plaintext value is replaced immediately and is never returned to a client.
    const legacyTokens = JSON.parse(row.value) as XeroTokens;
    await saveTokens(legacyTokens);
    return legacyTokens;
  } catch (error) {
    console.error("[Xero] Stored OAuth tokens could not be decrypted. Reconnect Xero from Administration.", error);
    return null;
  }
}

export async function getXeroStatus() {
  const tokens = await loadTokens();
  return {
    configured: isXeroConfigured(),
    connected: Boolean(tokens?.accessToken && tokens?.tenantId),
    tenantName: tokens?.tenantName || null,
  };
}

export async function disconnectXero() {
  await db.upsertSetting(SETTINGS_KEY, "", "Xero OAuth tokens (disconnected)");
}

export async function handleXeroCallback(code: string) {
  const res = await fetch(XERO_TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${Buffer.from(`${ENV.xeroClientId}:${ENV.xeroClientSecret}`).toString("base64")}`,
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: ENV.xeroRedirectUri,
    }),
  });

  if (!res.ok) {
    throw new Error(`Xero token exchange failed: ${res.status} ${await res.text()}`);
  }

  const json = (await res.json()) as {
    access_token: string;
    refresh_token: string;
    expires_in: number;
  };

  const tenants = await fetchTenants(json.access_token);
  const primaryTenant = tenants[0];

  await saveTokens({
    accessToken: json.access_token,
    refreshToken: json.refresh_token,
    expiresAt: Date.now() + json.expires_in * 1000,
    tenantId: primaryTenant?.tenantId || null,
    tenantName: primaryTenant?.tenantName || null,
  });
}

async function fetchTenants(accessToken: string) {
  const res = await fetch(XERO_CONNECTIONS_URL, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) return [];
  return (await res.json()) as { tenantId: string; tenantName: string }[];
}

async function refreshAccessToken(tokens: XeroTokens): Promise<XeroTokens> {
  const res = await fetch(XERO_TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${Buffer.from(`${ENV.xeroClientId}:${ENV.xeroClientSecret}`).toString("base64")}`,
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: tokens.refreshToken,
    }),
  });

  if (!res.ok) {
    throw new Error(`Xero token refresh failed: ${res.status} ${await res.text()}`);
  }

  const json = (await res.json()) as {
    access_token: string;
    refresh_token: string;
    expires_in: number;
  };

  const updated: XeroTokens = {
    ...tokens,
    accessToken: json.access_token,
    refreshToken: json.refresh_token,
    expiresAt: Date.now() + json.expires_in * 1000,
  };
  await saveTokens(updated);
  return updated;
}

async function getValidTokens(): Promise<XeroTokens> {
  let tokens = await loadTokens();
  if (!tokens?.accessToken || !tokens.tenantId) {
    throw new Error("Xero is not connected yet. Connect it from Administration first.");
  }
  if (Date.now() > tokens.expiresAt - 60_000) {
    tokens = await refreshAccessToken(tokens);
  }
  return tokens;
}

async function findOrCreateXeroContact(
  headers: Record<string, string>,
  customer: { name: string; email?: string | null }
) {
  const contactRes = await fetch(
    `${XERO_API_BASE}/Contacts?where=${encodeURIComponent(`Name=="${customer.name.replace(/"/g, "")}"`)}`,
    { headers }
  );
  const contactJson = contactRes.ok ? await contactRes.json() : { Contacts: [] };
  let contactId = contactJson.Contacts?.[0]?.ContactID as string | undefined;

  if (!contactId) {
    const createContactRes = await fetch(`${XERO_API_BASE}/Contacts`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        Contacts: [{ Name: customer.name, EmailAddress: customer.email || undefined }],
      }),
    });
    if (!createContactRes.ok) {
      throw new Error(`Failed to create Xero contact: ${await createContactRes.text()}`);
    }
    const created = await createContactRes.json();
    contactId = created.Contacts?.[0]?.ContactID;
  }

  if (!contactId) throw new Error("Could not resolve a Xero contact for this customer");
  return contactId;
}

/**
 * Creates a Xero Quote for an internal quote, using its real line items.
 */
export async function createXeroQuoteForQuote(quoteId: number) {
  const tokens = await getValidTokens();
  const quote = await db.getQuoteById(quoteId);
  if (!quote) throw new Error("Quote not found");
  const customer = await db.getCustomerById(quote.customerId);
  if (!customer) throw new Error("Customer not found for this quote");

  const headers = {
    Authorization: `Bearer ${tokens.accessToken}`,
    "Xero-tenant-id": tokens.tenantId!,
    "Content-Type": "application/json",
    Accept: "application/json",
  };

  const contactId = await findOrCreateXeroContact(headers, customer);

  const rawLineItems = Array.isArray(quote.lineItems) ? quote.lineItems : [];
  const lineItems =
    rawLineItems.length > 0
      ? rawLineItems.map((item: any) => ({
          Description: item.description || "Service",
          Quantity: item.quantity || 1,
          UnitAmount: item.unitPrice || 0,
          AccountCode: "200",
        }))
      : [
          {
            Description: quote.notes || `Quote ${quote.quoteNumber}`,
            Quantity: 1,
            UnitAmount: quote.totalAmount || 0,
            AccountCode: "200",
          },
        ];

  const quoteRes = await fetch(`${XERO_API_BASE}/Quotes`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      Quotes: [
        {
          Contact: { ContactID: contactId },
          LineItems: lineItems,
          Date: new Date().toISOString().slice(0, 10),
          ExpiryDate: quote.expiryDate || undefined,
          Status: "SENT",
          Reference: quote.quoteNumber,
          Title: `Quote ${quote.quoteNumber}`,
          Summary: quote.notes || undefined,
        },
      ],
    }),
  });

  if (!quoteRes.ok) {
    throw new Error(`Failed to create Xero quote: ${await quoteRes.text()}`);
  }

  const quoteJson = await quoteRes.json();
  const quoteNumber = quoteJson.Quotes?.[0]?.QuoteNumber as string | undefined;
  const xeroQuoteId = quoteJson.Quotes?.[0]?.QuoteID as string | undefined;
  const ref = quoteNumber || xeroQuoteId || "unknown";

  await db.updateQuote(quoteId, { xeroQuoteRef: ref });
  return { xeroQuoteRef: ref };
}

/**
 * Pulls a simple revenue summary from Xero's live Invoices, for the
 * Analytics page. Read-only — does not write anything back to Xero.
 */
export async function getXeroRevenueSummary() {
  const status = await getXeroStatus();
  if (!status.connected) {
    return { connected: false as const };
  }

  const tokens = await getValidTokens();
  const headers = {
    Authorization: `Bearer ${tokens.accessToken}`,
    "Xero-tenant-id": tokens.tenantId!,
    Accept: "application/json",
  };

  const res = await fetch(`${XERO_API_BASE}/Invoices?where=Type=="ACCREC"&order=Date DESC`, { headers });
  if (!res.ok) {
    throw new Error(`Failed to fetch Xero invoices: ${await res.text()}`);
  }
  const json = await res.json();
  const invoices = (json.Invoices || []) as any[];

  const totalInvoiced = invoices.reduce((sum, inv) => sum + (inv.Total || 0), 0);
  const totalPaid = invoices
    .filter((inv) => inv.Status === "PAID")
    .reduce((sum, inv) => sum + (inv.Total || 0), 0);
  const totalOutstanding = invoices
    .filter((inv) => inv.Status === "AUTHORISED")
    .reduce((sum, inv) => sum + (inv.AmountDue ?? inv.Total ?? 0), 0);

  return {
    connected: true as const,
    tenantName: status.tenantName,
    invoiceCount: invoices.length,
    totalInvoiced,
    totalPaid,
    totalOutstanding,
  };
}

/**
 * Creates (or finds) a Xero contact for the customer, then raises an ACCREC
 * invoice for the job, and returns the Xero invoice number to store against
 * the job record.
 */
export async function createXeroInvoiceForJob(jobId: number) {
  const tokens = await getValidTokens();
  const job = await db.getJobById(jobId);
  if (!job) throw new Error("Job not found");
  const customer = await db.getCustomerById(job.customerId);
  if (!customer) throw new Error("Customer not found for this job");

  const headers = {
    Authorization: `Bearer ${tokens.accessToken}`,
    "Xero-tenant-id": tokens.tenantId!,
    "Content-Type": "application/json",
    Accept: "application/json",
  };

  const contactId = await findOrCreateXeroContact(headers, customer);

  // Use the real quote line items when this job came from a quote.
  const linkedQuote = job.quoteId ? await db.getQuoteById(job.quoteId) : null;
  const rawLineItems = linkedQuote && Array.isArray(linkedQuote.lineItems) ? linkedQuote.lineItems : [];

  const lineItems =
    rawLineItems.length > 0
      ? rawLineItems.map((item: any) => ({
          Description: item.description || "Service",
          Quantity: item.quantity || 1,
          UnitAmount: item.unitPrice || 0,
          AccountCode: "200",
        }))
      : [
          {
            Description: job.description || `Job ${job.jobNumber}`,
            Quantity: 1,
            UnitAmount: job.estimatedLaborHours ? job.estimatedLaborHours * 120 : 1,
            AccountCode: "200",
          },
        ];

  const invoiceRes = await fetch(`${XERO_API_BASE}/Invoices`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      Invoices: [
        {
          Type: "ACCREC",
          Contact: { ContactID: contactId },
          LineItems: lineItems,
          Status: "AUTHORISED",
          Reference: job.jobNumber,
        },
      ],
    }),
  });

  if (!invoiceRes.ok) {
    throw new Error(`Failed to create Xero invoice: ${await invoiceRes.text()}`);
  }

  const invoiceJson = await invoiceRes.json();
  const invoiceNumber = invoiceJson.Invoices?.[0]?.InvoiceNumber as string | undefined;
  const invoiceId = invoiceJson.Invoices?.[0]?.InvoiceID as string | undefined;
  const ref = invoiceNumber || invoiceId || "unknown";

  await db.updateJob(jobId, { xeroInvoiceRef: ref });
  return { xeroInvoiceRef: ref };
}
