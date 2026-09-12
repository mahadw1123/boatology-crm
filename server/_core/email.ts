import { ENV } from "./env";
import * as db from "../db";
import { captureSystemError } from "./monitoring";

export type SendEmailInput = {
  to: string;
  subject: string;
  html: string;
  text?: string;
  // Base64-encoded file content — used for the scheduled database backup
  // email today, but generic enough for anything else that needs to attach
  // a file (a report export, say) later.
  attachments?: { filename: string; content: string }[];
};

export function escapeHtml(value: unknown) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function safeHttpUrl(value: string) {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? escapeHtml(url.toString()) : "#";
  } catch {
    return "#";
  }
}

function htmlToText(html: string) {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Sends an email via Resend's REST API. Missing configuration is treated as
 * a real delivery failure so quote/invoice workflows cannot claim an email
 * was sent when it was not. Callers that intentionally degrade gracefully
 * (for example password reset enumeration protection) catch this error.
 */
export async function sendEmail({ to, subject, html, text, attachments }: SendEmailInput) {
  // The real, admin-configured company name (Administration → Settings) —
  // substituted here, once, rather than threading it through every single
  // template function. Falls back to "Boatology" if never set.
  let companyName = "Boatology";
  try {
    const settings = await db.getSettings();
    const setting = settings.find((s) => s.key === "company_name");
    if (setting?.value) companyName = setting.value;
  } catch (error) {
    console.error("Failed to read company_name setting, using default:", error);
  }
  const finalHtml = html.split("{{COMPANY_NAME}}").join(escapeHtml(companyName));
  // Keep admin-configured/company-supplied values out of email headers. Resend
  // also validates headers, but stripping CR/LF here prevents header injection
  // and gives every subject a predictable maximum size.
  const finalSubject = subject
    .split("{{COMPANY_NAME}}")
    .join(companyName)
    .replace(/[\r\n]+/g, " ")
    .trim()
    .slice(0, 200);

  const recipientDomain = to.includes("@") ? to.split("@").pop() : "unknown";
  if (!ENV.resendApiKey) {
    const error = new Error("Email is not configured. Add RESEND_API_KEY before sending customer emails.");
    captureSystemError(error, { source: "email", severity: "warning", route: "resend.send", context: { recipientDomain, subject: finalSubject } });
    throw error;
  }

  const payload = JSON.stringify({
    from: ENV.emailFrom,
    to: [to],
    subject: finalSubject,
    html: finalHtml,
    text: text || htmlToText(finalHtml),
    ...(attachments && attachments.length > 0 ? { attachments } : {}),
  });

  // A brief Resend outage or a dropped connection shouldn't fail a
  // customer-facing send outright — retry twice (three attempts total)
  // with a short backoff before giving up. Only for transient failures: a
  // network-level throw, or a 429/5xx from Resend itself. A 4xx like a bad
  // recipient address will never succeed on retry, so those fail fast.
  const maxAttempts = 3;
  let res: Response | undefined;
  let lastNetworkError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${ENV.resendApiKey}`,
          "Content-Type": "application/json",
        },
        body: payload,
      });
      lastNetworkError = undefined;
    } catch (error) {
      lastNetworkError = error;
      res = undefined;
    }

    const shouldRetry = attempt < maxAttempts && (lastNetworkError !== undefined || (res && (res.status === 429 || res.status >= 500)));
    if (!shouldRetry) break;
    await new Promise((resolve) => setTimeout(resolve, attempt * 750));
  }

  if (lastNetworkError !== undefined || !res) {
    captureSystemError(lastNetworkError, { source: "email", route: "resend.send", context: { recipientDomain, subject: finalSubject } });
    throw lastNetworkError instanceof Error ? lastNetworkError : new Error("Could not reach the email provider.");
  }

  if (!res.ok) {
    const body = await res.text();
    console.error(`[Email] Resend API error (${res.status}):`, body);

    let providerMessage = "";
    try {
      const parsed = JSON.parse(body) as { message?: string; name?: string };
      providerMessage = parsed.message || parsed.name || "";
    } catch {
      providerMessage = body.trim();
    }

    let userMessage = `Email provider rejected the message (${res.status}).`;
    if (res.status === 401) {
      userMessage = "Resend rejected the API key. Replace RESEND_API_KEY in the server .env file, then restart the CRM.";
    } else if (res.status === 403) {
      userMessage = ENV.emailFrom.includes("onboarding@resend.dev")
        ? "Resend blocked this email because onboarding@resend.dev can only send to the address registered on your Resend account. Verify your business domain in Resend, set EMAIL_FROM to an address on that domain, then restart the CRM."
        : "Resend blocked this sender. Confirm that the domain used by EMAIL_FROM is verified in Resend and that the API key has sending permission, then restart the CRM.";
    } else if (res.status === 422) {
      userMessage = "Resend rejected the email details. Check the customer email address and confirm EMAIL_FROM uses a verified sender domain.";
    } else if (res.status === 429) {
      userMessage = "Resend is temporarily rate-limiting email delivery. Wait a minute, then send the email again.";
    } else if (res.status >= 500) {
      userMessage = "Resend is temporarily unavailable. Wait a few minutes, then retry from the quote or invoice page.";
    }
    if (providerMessage) userMessage += ` Provider message: ${providerMessage.slice(0, 300)}`;

    const error = new Error(userMessage);
    captureSystemError(error, {
      source: "email",
      route: "resend.send",
      context: { recipientDomain, subject: finalSubject, status: res.status },
    });
    throw error;
  }

  return (await res.json()) as { id: string };
}

// Boatology's own logo, hosted on the company's live marketing site — a
// white mark, meant for the navy header bar below. Email clients need a
// hosted image URL (inline SVG/data URIs render inconsistently across
// Gmail/Outlook), so this hotlinks the real asset rather than embedding one.
const LOGO_URL = "https://boatology.com.au/wp-content/uploads/2026/02/boatology-white-logo.png";

function wrapLayout(title: string, bodyHtml: string) {
  return `
    <div style="font-family: -apple-system, Helvetica, Arial, sans-serif; max-width: 560px; margin: 0 auto; color: #2F3B45;">
      <div style="background:#0c1e38; padding: 20px 24px; border-radius: 8px 8px 0 0; text-align:center;">
        <img src="${LOGO_URL}" alt="{{COMPANY_NAME}}" height="32" style="height:32px; width:auto; display:inline-block;" />
      </div>
      <div style="border:1px solid #D9E1E8; border-top:none; border-radius: 0 0 8px 8px; padding: 24px;">
        <h2 style="color:#0c1e38; margin-top:0;">${title}</h2>
        ${bodyHtml}
      </div>
      <p style="color:#5B6B78; font-size:12px; margin-top:16px;">
        {{COMPANY_NAME}} Management System — this is an automated message.
      </p>
    </div>
  `;
}

export const emailTemplates = {
  // customerName/quoteNumber/jobNumber/invoiceNumber params below are kept
  // even where no longer rendered, so every call site (routers.ts) doesn't
  // need to change argument order — internal reference numbers are
  // deliberately never shown to customers (staff-facing surfaces like the
  // Morning Briefing still show them; this is customer email content only).
  quoteSent: (customerName: string, _quoteNumber: string, totalAmount: number, expiryDate: string | null | undefined, reviewUrl: string) =>
    wrapLayout(
      "New quote ready for your review",
      `<p>Hi ${escapeHtml(customerName)},</p>
       <p>Your quote is ready — total <strong>$${totalAmount.toFixed(2)} AUD</strong>.</p>
       ${expiryDate ? `<p>This quote is valid until <strong>${escapeHtml(expiryDate)}</strong>.</p>` : ""}
       <p>Open the quote below to review the work, line items, and total before accepting or declining it.</p>
       <p style="margin-top:20px;">
         <a href="${safeHttpUrl(reviewUrl)}" style="background:#0c1e38;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;display:inline-block;">Review Your Quote</a>
       </p>
       <p style="margin-top:16px;font-size:12px;color:#5B6B78;">If the button doesn't work, copy this link: ${safeHttpUrl(reviewUrl)}</p>`
    ),
  quoteAccepted: (_quoteNumber: string) =>
    wrapLayout(
      "Quote accepted",
      `<p>Your quote has been accepted. We will contact you with the next steps shortly.</p>`
    ),
  quoteRejected: (_quoteNumber: string, reason?: string | null) =>
    wrapLayout(
      "Quote declined",
      `<p>Your quote was declined.${reason ? ` Reason recorded: &quot;${escapeHtml(reason)}&quot;` : ""}</p>`
    ),
  jobScheduled: (_jobNumber: string, scheduledDate: string) =>
    wrapLayout(
      "Job scheduled",
      `<p>Your job has been scheduled for <strong>${escapeHtml(scheduledDate)}</strong>.</p>`
    ),
  jobCreated: (customerName: string, _jobNumber: string, dueDate?: string | null) =>
    wrapLayout(
      "Your job has been created",
      `<p>Hi ${escapeHtml(customerName)},</p>
       <p>We've created a job for your vessel.</p>
       ${dueDate ? `<p>Estimated completion date: <strong>${escapeHtml(dueDate)}</strong>.</p>` : ""}
       <p>We'll keep you updated with progress photos as the work is completed — you can check in any time through your customer portal.</p>`
    ),
  jobCompleted: (_jobNumber: string) =>
    wrapLayout(
      "Job completed",
      `<p>Your job has been marked complete. Your invoice will follow shortly.</p>`
    ),
  jobDelayed: (customerName: string, _jobNumber: string, note?: string | null) =>
    wrapLayout(
      "An update on your job",
      `<p>Hi ${escapeHtml(customerName)},</p>
       <p>We wanted to let you know your job is taking a little longer than originally estimated.</p>
       ${note ? `<p>${escapeHtml(note)}</p>` : ""}
       <p>We're on it and will keep you posted — thanks for your patience.</p>`
    ),
  additionalWorkRequested: (customerName: string, _jobNumber: string, notes: string, portalUrl: string) =>
    wrapLayout(
      "Extra work needs your approval",
      `<p>Hi ${escapeHtml(customerName)},</p>
       <p>While working on your vessel, our technician found some
       additional work that needs your approval before it can go ahead:</p>
       <p style="margin:16px 0;padding:16px;background:#F5F7FA;border-radius:8px;">${escapeHtml(notes).replace(/\n/g, "<br>")}</p>
       <p>Work on this job is paused until you approve or decline this — please review it in your
       customer portal as soon as you can so we can keep things moving.</p>
       <p style="margin-top:20px;">
         <a href="${safeHttpUrl(portalUrl)}" style="background:#0c1e38;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;display:inline-block;">Review and respond</a>
       </p>`
    ),
  customerMessageReply: (customerName: string, originalMessage: string, reply: string) =>
    wrapLayout(
      "Reply to your message",
      `<p>Hi ${escapeHtml(customerName)},</p>
       <p>${escapeHtml(reply).replace(/\n/g, "<br>")}</p>
       <p style="margin-top:24px;padding:12px 16px;border-left:3px solid #d0d5dd;color:#5B6B78;font-size:13px;">
         <strong>Your message:</strong><br>${escapeHtml(originalMessage).replace(/\n/g, "<br>")}
       </p>`
    ),
  staffInvite: (roleLabel: string, acceptUrl: string) =>
    wrapLayout(
      "You've been invited to {{COMPANY_NAME}}",
      `<p>You've been invited to join {{COMPANY_NAME}} as <strong>${escapeHtml(roleLabel)}</strong>.</p>
       <p>Click the button below to set your name and password and activate your account. This link expires in 7 days.</p>
       <p style="margin-top:20px;">
         <a href="${safeHttpUrl(acceptUrl)}" style="background:#0c1e38;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;display:inline-block;">Accept invite</a>
       </p>
       <p style="margin-top:20px;font-size:12px;color:#5B6B78;">If the button doesn't work, copy this link: ${safeHttpUrl(acceptUrl)}</p>`
    ),
  passwordReset: (name: string, resetUrl: string) =>
    wrapLayout(
      "Reset your password",
      `<p>Hi ${escapeHtml(name)},</p>
       <p>We received a request to reset your {{COMPANY_NAME}} password. Click the button below to choose a new one. This link expires in 1 hour.</p>
       <p style="margin-top:20px;">
         <a href="${safeHttpUrl(resetUrl)}" style="background:#0c1e38;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;display:inline-block;">Reset Password</a>
       </p>
       <p style="margin-top:20px;font-size:12px;color:#5B6B78;">If you didn't request this, you can safely ignore this email — your password won't change unless you click the link above and set a new one.</p>
       <p style="margin-top:8px;font-size:12px;color:#5B6B78;">If the button doesn't work, copy this link: ${safeHttpUrl(resetUrl)}</p>`
    ),
  depositInvoiceSent: (
    customerName: string,
    _invoiceNumber: string,
    depositAmount: number,
    quoteTotal: number,
    depositPercentage: number,
    payUrl: string
  ) =>
    wrapLayout(
      `${depositPercentage}% deposit required to begin work`,
      `<p>Hi ${escapeHtml(customerName)},</p>
       <p>Thanks for accepting your quote — before we can schedule and begin work, we require a
       <strong>${depositPercentage}% deposit</strong>.</p>
       <div style="margin:16px 0;padding:16px;background:#F5F7FA;border-radius:8px;">
         <div style="display:flex;justify-content:space-between;font-size:14px;"><span>Quote total</span><strong>$${quoteTotal.toFixed(2)}</strong></div>
         <div style="display:flex;justify-content:space-between;font-size:14px;margin-top:6px;"><span>Deposit due now (${depositPercentage}%)</span><strong>$${depositAmount.toFixed(2)}</strong></div>
       </div>
       <p>Once the deposit is received, we'll schedule your job and get started — the remaining
       balance is invoiced once the work is complete.</p>
       <p style="margin-top:20px;">
         <a href="${safeHttpUrl(payUrl)}" style="background:#0c1e38;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;display:inline-block;">Pay Deposit</a>
       </p>`
    ),
  zeroBalanceInvoice: (customerName: string, _invoiceNumber: string) =>
    wrapLayout(
      "Invoice settled — no payment required",
      `<p>Hi ${escapeHtml(customerName)},</p>
       <p>Your invoice has a zero balance after deposits and discounts.</p>
       <p>No payment is required.</p>`
    ),
  paymentReceipt: (customerName: string, _invoiceNumber: string, amount: number, method: string) =>
    wrapLayout(
      "Payment received",
      `<p>Hi ${escapeHtml(customerName)},</p>
       <p>We've received your payment of <strong>$${amount.toFixed(2)} AUD</strong>.</p>
       <p>Payment method: <strong>${escapeHtml(method)}</strong>.</p>
       <p>Thank you — no further payment is required for this invoice.</p>`
    ),
  invoiceSent: (
    customerName: string,
    _invoiceNumber: string,
    totalDue: number,
    payUrl: string,
    reviewOfferActive: boolean,
    discountAmount: number,
    adjustment?: { originalAmount: number; reason: string }
  ) =>
    wrapLayout(
      "Your invoice is ready",
      `<p>Hi ${escapeHtml(customerName)},</p>
       <p>Your invoice is ready — total due <strong>$${totalDue.toFixed(2)} AUD</strong>.</p>
       ${
         adjustment
           ? `<div style="margin-top:16px;padding:16px;background:#FFF4E5;border-radius:8px;">
                <p style="margin:0;font-weight:600;color:#92400E;">This amount is different from your original quote</p>
                <p style="margin:8px 0 0;font-size:14px;">Original quote: $${adjustment.originalAmount.toFixed(2)}. ${adjustment.reason ? `Reason: ${escapeHtml(adjustment.reason)}` : ""}</p>
                <p style="margin:8px 0 0;font-size:14px;">Please review and approve the new amount before paying — you'll see this when you open the invoice.</p>
              </div>`
           : ""
       }
       <p style="margin-top:20px;">
         <a href="${safeHttpUrl(payUrl)}" style="background:#0c1e38;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;display:inline-block;">${adjustment ? "Review invoice" : "Pay this invoice"}</a>
       </p>
       ${
         reviewOfferActive
           ? `<div style="margin-top:24px;padding:16px;background:#EAFAFA;border-radius:8px;">
                <p style="margin:0;font-weight:600;color:#0c1e38;">Leave a review, save $${discountAmount.toFixed(0)}</p>
                <p style="margin:8px 0 0;font-size:14px;">Leave us a review on Google and we'll take $${discountAmount.toFixed(0)} off this invoice — just click "Pay this invoice" and you'll see the option there.</p>
              </div>`
           : ""
       }`
    ),
  welcomeEmail: (customerName: string) =>
    wrapLayout(
      "Welcome to {{COMPANY_NAME}}",
      `<p>Hi ${escapeHtml(customerName)},</p>
       <p>Thanks for choosing {{COMPANY_NAME}} — you've been added as a customer in our system.</p>
       <p>We'll reach out here by email as your quotes, jobs, and invoices are ready, and you can review and act on them any time through your customer portal.</p>`
    ),
  jobCancelled: (_jobNumber: string, reason?: string | null) =>
    wrapLayout(
      "Job cancelled",
      `<p>Your job has been cancelled.${reason ? ` Reason: &quot;${escapeHtml(reason)}&quot;` : ""}</p>
       <p>If you believe this is a mistake or have any questions, please get in touch.</p>`
    ),
  jobUpdated: (jobNumber: string, summary: string) =>
    wrapLayout(
      "Job details updated",
      `<p>Job <strong>${escapeHtml(jobNumber)}</strong> has been updated.</p>
       <p>${escapeHtml(summary)}</p>`
    ),
  testEmail: () =>
    wrapLayout(
      "Test email from {{COMPANY_NAME}}",
      `<p>This is a test email sent from the Administration &rarr; Settings page.</p>
       <p>If you received this, outgoing email is configured correctly.</p>`
    ),
  morningBriefing: (data: {
    generatedAt: string;
    jobsOverdue: { jobNumber: string | null; customerName: string }[];
    jobsToday: { jobNumber: string | null; customerName: string }[];
    quotesAwaiting: { quoteNumber: string | null; amount: number }[];
    depositsUnpaid: { invoiceNumber: string | null; amount: number }[];
    invoicesUnpaid: { invoiceNumber: string | null; amount: number }[];
    lowStock: { name: string; currentStock: number; minimumStock: number }[];
    pendingMaterialRequests: { materialName: string; quantity: number; urgency: string }[];
    unassignedTasks: { title: string; priority: string | null }[];
  }) =>
    wrapLayout(
      "Morning Briefing",
      `<p style="color:#5B6B78; font-size:12px; margin-top:-8px;">${escapeHtml(new Date(data.generatedAt).toLocaleString("en-AU"))}</p>
       ${briefingSection("Overdue Jobs", data.jobsOverdue.map((j) => briefingRow(j.jobNumber || "—", j.customerName)))}
       ${briefingSection("Jobs Due Today", data.jobsToday.map((j) => briefingRow(j.jobNumber || "—", j.customerName)))}
       ${briefingSection("Quotes Awaiting Approval", data.quotesAwaiting.map((q) => briefingRow(q.quoteNumber || "—", `$${q.amount.toFixed(2)}`)))}
       ${briefingSection("Deposits Unpaid", data.depositsUnpaid.map((i) => briefingRow(i.invoiceNumber || "—", `$${i.amount.toFixed(2)}`)))}
       ${briefingSection("Invoices Outstanding", data.invoicesUnpaid.map((i) => briefingRow(i.invoiceNumber || "—", `$${i.amount.toFixed(2)}`)))}
       ${briefingSection("Low Stock", data.lowStock.map((i) => briefingRow(i.name, `${i.currentStock}/${i.minimumStock}`)))}
       ${briefingSection("Material Requests Pending", data.pendingMaterialRequests.map((r) => briefingRow(`${r.quantity}x ${r.materialName}`, r.urgency)))}
       ${briefingSection("Task Centre — Unassigned", data.unassignedTasks.map((t) => briefingRow(t.title, t.priority || "—")))}`
    ),
};

/** One labelled section of the morning briefing — a plain title, a count,
 * and either a stack of item rows or a quiet "Empty" line. Deliberately
 * plain: no emoji, no all-caps, no colour-coded "good news" framing —
 * just the facts, the same way every other section reads. */
function briefingSection(title: string, rows: string[]) {
  return `
    <div style="margin-top:18px;">
      <p style="margin:0 0 8px; font-size:14px; font-weight:600; color:#0c1e38;">
        ${escapeHtml(title)} <span style="color:#8A97A3; font-weight:400;">(${rows.length})</span>
      </p>
      ${
        rows.length === 0
          ? `<div style="padding:10px 12px; background:#F7F9FA; border-radius:6px; color:#8A97A3; font-size:13px;">Empty</div>`
          : `<div style="border:1px solid #E7ECF0; border-radius:8px; overflow:hidden;">${rows.join("")}</div>`
      }
    </div>
  `;
}

function briefingRow(left: string, right: string) {
  // A table, not flexbox — desktop Outlook's Word rendering engine ignores
  // flex/grid entirely, and this needs to lay out correctly there too.
  return `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-bottom:1px solid #EEF2F5;">
      <tr>
        <td style="padding:9px 12px; font-size:13px; color:#2F3B45;">${escapeHtml(left)}</td>
        <td style="padding:9px 12px; font-size:13px; color:#5B6B78; text-align:right; white-space:nowrap;">${escapeHtml(right)}</td>
      </tr>
    </table>
  `;
}
