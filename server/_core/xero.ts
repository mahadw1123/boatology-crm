import crypto from "crypto";
import { ENV } from "./env";
import * as db from "../db";
import { captureSystemError } from "./monitoring";

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
    // accounting.settings.read grants read access to the chart of accounts
    // (needed to look up a real revenue account code instead of guessing
    // one) — Quotes and Invoices scopes alone don't cover the Accounts
    // endpoint, which is why a connection made before this was added gets
    // a 401 from Xero on that specific call until it's reconnected.
    scope: "openid profile email accounting.contacts accounting.invoices accounting.settings.read offline_access",
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

let cachedRevenueAccountCode: string | null = null;

/**
 * Looks up a real, active revenue account from the connected Xero org,
 * instead of assuming account code "200" (Xero's common default) exists —
 * it doesn't in every org, and a hardcoded code silently breaks the moment
 * a business archives or renumbers their chart of accounts. Cached for the
 * life of the process since an org's revenue account rarely changes.
 */
async function resolveRevenueAccountCode(headers: Record<string, string>): Promise<string> {
  if (cachedRevenueAccountCode) return cachedRevenueAccountCode;

  const res = await fetch(`${XERO_API_BASE}/Accounts?where=${encodeURIComponent('Type=="REVENUE" AND Status=="ACTIVE"')}`, { headers });
  if (!res.ok) {
    throw new Error(`Could not look up a revenue account in Xero: ${await res.text()}`);
  }
  const json = await res.json();
  const accounts = (json.Accounts || []) as Array<{ Code?: string; Name?: string }>;
  // Prefer an account literally named "Sales" if there are several — the
  // conventional default — otherwise take the first active revenue account.
  const preferred = accounts.find((a) => a.Name?.toLowerCase() === "sales") || accounts[0];
  if (!preferred?.Code) {
    throw new Error(
      "No active revenue account was found in your connected Xero organisation. Add or unarchive a Revenue-type account in Xero, then try syncing again."
    );
  }
  cachedRevenueAccountCode = preferred.Code;
  return preferred.Code;
}

/**
 * Creates a Xero Quote for an internal quote, using its real line items.
 * Idempotent: if this quote already has a xeroQuoteRef, returns it instead
 * of creating a second Quote in Xero — a re-click (or a retried request)
 * must never duplicate the Xero-side record.
 */
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
 * the job record. Idempotent: if this job already has a xeroInvoiceRef,
 * returns it instead of creating a second Xero-side invoice.
 */
export async function createXeroInvoiceForInvoice(invoiceId: number) {
  const existing = await db.getInvoiceById(invoiceId);
  if (!existing) throw new Error("Invoice not found");
  if (existing.xeroInvoiceRef) {
    return { xeroInvoiceRef: existing.xeroInvoiceRef, alreadySynced: true as const };
  }

  await db.updateInvoice(invoiceId, { xeroSyncStatus: "syncing", xeroLastSyncError: null });

  try {
    const tokens = await getValidTokens();
    const invoice = existing;
    const customer = await db.getCustomerById(invoice.customerId);
    if (!customer) throw new Error("Customer not found for this invoice");

    const headers = {
      Authorization: `Bearer ${tokens.accessToken}`,
      "Xero-tenant-id": tokens.tenantId!,
      "Content-Type": "application/json",
      Accept: "application/json",
    };

    const contactId = await findOrCreateXeroContact(headers, customer);
    const accountCode = await resolveRevenueAccountCode(headers);

    // Use the real quote line items when this invoice came from one —
    // otherwise fall back to a single line covering the invoice subtotal.
    const linkedQuote = invoice.quoteId ? await db.getQuoteById(invoice.quoteId) : null;
    const rawLineItems = linkedQuote && Array.isArray(linkedQuote.lineItems) ? linkedQuote.lineItems : [];
    const job = invoice.jobId ? await db.getJobById(invoice.jobId) : null;

    const lineItems =
      rawLineItems.length > 0
        ? rawLineItems.map((item: any) => ({
            Description: item.description || "Service",
            Quantity: item.quantity || 1,
            UnitAmount: item.unitPrice || 0,
            AccountCode: accountCode,
          }))
        : [
            {
              Description: job?.description || `Invoice ${invoice.invoiceNumber}`,
              Quantity: 1,
              UnitAmount: invoice.subtotal,
              AccountCode: accountCode,
            },
          ];

    // An AUTHORISED invoice is rejected by Xero without both dates — 14-day
    // trade terms as a reasonable default; Boatology doesn't track its own
    // per-invoice due-date/terms concept yet to source this from instead.
    const invoiceDate = new Date();
    const dueDate = new Date(invoiceDate.getTime() + 14 * 86400000);
    const isoDate = (d: Date) => d.toISOString().slice(0, 10);

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
            Reference: invoice.invoiceNumber,
            Date: isoDate(invoiceDate),
            DueDate: isoDate(dueDate),
          },
        ],
      }),
    });

    if (!invoiceRes.ok) {
      throw new Error(`Failed to create Xero invoice: ${await invoiceRes.text()}`);
    }

    const invoiceJson = await invoiceRes.json();
    const invoiceNumber = invoiceJson.Invoices?.[0]?.InvoiceNumber as string | undefined;
    const xeroInvoiceId = invoiceJson.Invoices?.[0]?.InvoiceID as string | undefined;
    const ref = invoiceNumber || xeroInvoiceId || "unknown";

    await db.updateInvoice(invoiceId, { xeroInvoiceRef: ref, xeroSyncStatus: "synced", xeroLastSyncError: null });
    return { xeroInvoiceRef: ref, alreadySynced: false as const };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Xero sync failed";
    await db.updateInvoice(invoiceId, { xeroSyncStatus: "failed", xeroLastSyncError: message });
    captureSystemError(error, { source: "background", route: "xero.createXeroInvoiceForInvoice", context: { invoiceId } });
    throw error;
  }
}
