// The only knowledge the staff assistant has. It never sees customer, quote,
// job or invoice data. Keep this in step with how the CRM actually behaves.
export const HELP_GUIDE = `
BOATOLOGY CRM — STAFF GUIDE

ROLES
- Admin: full access, including Administration (settings, users, access rules, Xero connection).
- Management: sees most areas including Analytics and Employees.
- Office staff: quotes, invoices, jobs, customers, calendar, task centre, costs, inventory, reports.
- Technician: a simplified mobile home screen with assigned jobs, tasks, calendar and materials requests.
- Customers use a separate customer portal and never see the staff screens.

CUSTOMERS AND VESSELS
- Customers are under Contacts (also reachable by search). Add a customer with name and email; the email is needed to send quotes and invoices.
- Vessels belong to a customer. Add them from Vessels or from the customer.
- A customer logs in to the portal with their own account. A customer account is NOT linked automatically: an admin links it to the customer record in Administration > Users.

QUOTES
- Quotes > New Quote: choose the customer and vessel, add line items (description, quantity, unit price, GST), choose how GST applies, optional discount, notes and payment terms.
- A new quote is a draft. Sending it emails the customer a link to review it in the portal.
- Customers see their quotes as Quote 1, Quote 2 and so on, not the internal quote number.
- The customer accepts or declines in the portal. Staff can also accept on the customer's behalf from the quote page (Accept on behalf).
- If a quote needs changes after sending, create a revision; the customer is notified.
- The quote PDF includes the business name, ABN and address from Administration > System Settings.

DEPOSITS
- When a quote is accepted, a deposit invoice is created automatically for the deposit percentage set in Administration > System Settings.
- The customer pays the deposit in the portal by card or Apple Pay. Staff can instead record a payment received another way using Mark Paid on the invoice.

JOBS
- A job linked to a quote needs the quote to be accepted and the deposit paid. From an accepted quote use Create Job.
- A job without a quote can be created from Jobs > New Job.
- Jobs have tasks. Assign technicians to the job, and assign each task to a team member. "Responsible Staff" is the person accountable for the job.
- Starting a task moves a Created or Scheduled job to In Progress. When all tasks are complete the job completes.
- Reopening a completed task or job asks for confirmation. A job with an issued invoice cannot be reopened.
- Job costs (materials, freight, paint) are recorded under the job and in Costs.
- The QR Code button on a job shows a code to print. Scanning it on a phone opens the job view with tasks, vessel and customer details, notes and photos. Staff must be signed in.

INVOICES
- Final invoices are created from the job: Create & Send Invoice. It asks you to confirm before sending. The deposit already paid is credited automatically.
- For a job with no quote, use Enter Amount & Invoice and type the amount.
- An invoice starts as a draft, then Sent, then Paid. Only draft invoices can be deleted; sent, paid and refunded invoices are kept for the financial record.
- Sync to Xero sends the invoice to Xero once Xero is connected in Administration.
- Customers pay in the portal by card or Apple Pay. A payment is recorded automatically; the invoice should show Paid within seconds.
- Mark Paid records a payment received outside the portal. Void cancels an invoice. Mark Refunded records a refund in the CRM only — the money itself is refunded in Stripe.
- Retry Email resends an invoice email that failed.

OTHER AREAS
- Dashboard: summary of open work, invoices and cash.
- Notifications and Today's Agenda list what needs attention.
- Task Centre: reminders and tasks for staff.
- Calendar and Timeline: scheduled work.
- Time Tracking: hours logged by technicians.
- Costs: job costs, business expenses and suppliers.
- Inventory and Materials: stock, and technicians' material requests that staff approve.
- Reports and Analytics: operational and financial reports.
- Documents and photos can be attached to jobs and vessels.

ADMINISTRATION (admins only)
- System Settings: quote expiry, deposit percentage, GST rate, company name, email, registered business name, ABN and address, backup email.
- Users: link customer accounts, change roles, deactivate accounts. Invite staff by email.
- Who can see and change what: switch off view, add, edit or delete for management, office staff and technicians.
- Xero: connect or disconnect the Xero integration.
`;
