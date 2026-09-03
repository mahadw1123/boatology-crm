import { ENV } from "./env";
import * as db from "../db";
import { captureSystemError } from "./monitoring";

export type SendEmailInput = {
  to: string;
  subject: string;
  html: string;
  text?: string;
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
export async function sendEmail({ to, subject, html, text }: SendEmailInput) {
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

  let res: Response;
  try {
    res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${ENV.resendApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: ENV.emailFrom,
        to: [to],
        subject: finalSubject,
        html: finalHtml,
        text: text || htmlToText(finalHtml),
      }),
    });
  } catch (error) {
    captureSystemError(error, { source: "email", route: "resend.send", context: { recipientDomain, subject: finalSubject } });
    throw error;
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

function wrapLayout(title: string, bodyHtml: string) {
  return `
    <div style="font-family: -apple-system, Helvetica, Arial, sans-serif; max-width: 560px; margin: 0 auto; color: #2F3B45;">
      <div style="background:#0c1e38; padding: 20px 24px; border-radius: 8px 8px 0 0;">
        <span style="color:#fff; font-size:18px; font-weight:600;">{{COMPANY_NAME}}</span>
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
  quoteSent: (customerName: string, quoteNumber: string, totalAmount: number, expiryDate: string | null | undefined, reviewUrl: string) =>
    wrapLayout(
      "New quote ready for your review",
      `<p>Hi ${escapeHtml(customerName)},</p>
       <p>Your quote <strong>${escapeHtml(quoteNumber)}</strong> is ready — total <strong>$${totalAmount.toFixed(2)} AUD</strong>.</p>
       ${expiryDate ? `<p>This quote is valid until <strong>${escapeHtml(expiryDate)}</strong>.</p>` : ""}
       <p>Open the quote below to review the work, line items, and total before accepting or declining it.</p>
       <p style="margin-top:20px;">
         <a href="${safeHttpUrl(reviewUrl)}" style="background:#0c1e38;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;display:inline-block;">Review quote ${escapeHtml(quoteNumber)}</a>
       </p>
       <p style="margin-top:16px;font-size:12px;color:#5B6B78;">If the button doesn't work, copy this link: ${safeHttpUrl(reviewUrl)}</p>`
    ),
  quoteAccepted: (quoteNumber: string) =>
    wrapLayout(
      "Quote accepted",
      `<p>Quote <strong>${escapeHtml(quoteNumber)}</strong> has been accepted. We will contact you with the next steps shortly.</p>`
    ),
  quoteRejected: (quoteNumber: string, reason?: string | null) =>
    wrapLayout(
      "Quote declined",
      `<p>Quote <strong>${escapeHtml(quoteNumber)}</strong> was declined.${reason ? ` Reason recorded: &quot;${escapeHtml(reason)}&quot;` : ""}</p>`
    ),
  jobScheduled: (jobNumber: string, scheduledDate: string) =>
    wrapLayout(
      "Job scheduled",
      `<p>Job <strong>${escapeHtml(jobNumber)}</strong> has been scheduled for <strong>${escapeHtml(scheduledDate)}</strong>.</p>`
    ),
  jobCreated: (customerName: string, jobNumber: string, dueDate?: string | null) =>
    wrapLayout(
      "Your job has been created",
      `<p>Hi ${escapeHtml(customerName)},</p>
       <p>We've created job <strong>${escapeHtml(jobNumber)}</strong> for your vessel.</p>
       ${dueDate ? `<p>Estimated completion date: <strong>${escapeHtml(dueDate)}</strong>.</p>` : ""}
       <p>We'll keep you updated with progress photos as the work is completed — you can check in any time through your customer portal.</p>`
    ),
  jobCompleted: (jobNumber: string) =>
    wrapLayout(
      "Job completed",
      `<p>Job <strong>${escapeHtml(jobNumber)}</strong> has been marked complete. Your invoice will follow shortly.</p>`
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
    invoiceNumber: string,
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
         <a href="${safeHttpUrl(payUrl)}" style="background:#0c1e38;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;display:inline-block;">Pay deposit — Invoice ${escapeHtml(invoiceNumber)}</a>
       </p>`
    ),
  zeroBalanceInvoice: (customerName: string, invoiceNumber: string) =>
    wrapLayout(
      "Invoice settled — no payment required",
      `<p>Hi ${escapeHtml(customerName)},</p>
       <p>Invoice <strong>${escapeHtml(invoiceNumber)}</strong> has a zero balance after deposits and discounts.</p>
       <p>No payment is required.</p>`
    ),
  paymentReceipt: (customerName: string, invoiceNumber: string, amount: number, method: string) =>
    wrapLayout(
      "Payment received",
      `<p>Hi ${escapeHtml(customerName)},</p>
       <p>We've received your payment of <strong>$${amount.toFixed(2)} AUD</strong> for invoice <strong>${escapeHtml(invoiceNumber)}</strong>.</p>
       <p>Payment method: <strong>${escapeHtml(method)}</strong>.</p>
       <p>Thank you — no further payment is required for this invoice.</p>`
    ),
  invoiceSent: (
    customerName: string,
    invoiceNumber: string,
    totalDue: number,
    payUrl: string,
    reviewOfferActive: boolean,
    discountAmount: number,
    adjustment?: { originalAmount: number; reason: string }
  ) =>
    wrapLayout(
      "Your invoice is ready",
      `<p>Hi ${escapeHtml(customerName)},</p>
       <p>Invoice <strong>${escapeHtml(invoiceNumber)}</strong> is ready — total due <strong>$${totalDue.toFixed(2)} AUD</strong>.</p>
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
};
