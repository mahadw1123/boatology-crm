# Role-permission matrix

Generated from `tests/permission-matrix.snapshot.json` by `npm run docs:permissions`. Do not edit by hand.

The snapshot is produced and checked by `tests/permission-matrix.test.ts`, which calls every API procedure as every role, once with records the caller owns and once with another customer's records.

## How to read it

- **yes** — the role passes the permission check. For list procedures the result is still filtered to what that role may see (a customer's `quotes.list` returns only their own quotes).
- **own only** — allowed for the caller's own records (a customer's own data, a technician's assigned jobs); refused for anyone else's.
- **—** — refused.
- Signed-out callers are refused everywhere except the procedures marked *public*.
- Administrators can remove view/add/edit/delete access per role in Administration → Access. Those switches only ever take access away from this table.

## Plain HTTP routes

These sit outside the procedure API and are enforced in `server/index.ts`.

| Route | Customer | Technician | Office | Management | Admin |
|---|---|---|---|---|---|
| `GET /uploads/:filename` (open a file) | own only, no supplier receipts | assigned jobs only, no supplier receipts | yes | yes | yes |
| `POST /api/uploads` (upload a file) | own records only | assigned jobs only | yes | yes | yes |
| `GET /api/quotes/:id/pdf` | own, once sent | — | yes | yes | yes |
| `GET /api/reports/*.pdf` | — | — | yes | yes | yes |
| `GET /api/admin/download-database` | — | — | — | — | yes |
| `GET /api/xero/connect` | — | — | — | — | yes |
| `POST /api/client-errors` | yes | yes | yes | yes | yes |
| `POST /api/stripe/webhook` | Stripe signature only |  |  |  |  |

## Procedures

### administration

| Procedure | Kind | Customer | Technician | Office | Management | Admin |
|---|---|---|---|---|---|---|
| `administration.accessRules` | read | — | — | — | — | yes |
| `administration.auditLog` | read | — | — | — | — | yes |
| `administration.companyName` *(public)* | read | yes | yes | yes | yes | yes |
| `administration.createService` | write | — | — | — | — | yes |
| `administration.deactivateUser` | write | — | — | — | — | yes |
| `administration.deleteService` | write | — | — | — | — | yes |
| `administration.gstRate` | read | — | yes | yes | yes | yes |
| `administration.inviteStaff` | write | — | — | — | — | yes |
| `administration.logExport` | write | — | — | yes | yes | yes |
| `administration.pendingInvites` | read | — | — | — | — | yes |
| `administration.quoteExpiryDays` | read | — | — | yes | yes | yes |
| `administration.reactivateUser` | write | — | — | — | — | yes |
| `administration.relinkCustomer` | write | — | — | — | — | yes |
| `administration.relinkTechnician` | write | — | — | — | — | yes |
| `administration.resolveSystemError` | write | — | — | — | — | yes |
| `administration.saveAccessRules` | write | — | — | — | — | yes |
| `administration.sendTestEmail` | write | — | — | — | — | yes |
| `administration.services` | read | — | — | yes | yes | yes |
| `administration.settings` | read | — | — | — | — | yes |
| `administration.staffUsers` | read | — | — | yes | yes | yes |
| `administration.systemErrors` | read | — | — | — | — | yes |
| `administration.systemHealth` | read | — | — | — | — | yes |
| `administration.updateService` | write | — | — | — | — | yes |
| `administration.updateSetting` | write | — | — | — | — | yes |
| `administration.updateUserRole` | write | — | — | — | — | yes |
| `administration.users` | read | — | — | — | — | yes |
| `administration.xeroDisconnect` | write | — | — | — | — | yes |
| `administration.xeroStatus` | read | — | — | — | — | yes |

### agenda

| Procedure | Kind | Customer | Technician | Office | Management | Admin |
|---|---|---|---|---|---|---|
| `agenda.muteCategory` | write | yes | yes | yes | yes | yes |
| `agenda.mutedCategories` | read | yes | yes | yes | yes | yes |
| `agenda.today` | read | yes | yes | yes | yes | yes |
| `agenda.unmuteCategory` | write | yes | yes | yes | yes | yes |

### analytics

| Procedure | Kind | Customer | Technician | Office | Management | Admin |
|---|---|---|---|---|---|---|
| `analytics.businessHealth` | read | — | — | — | yes | yes |
| `analytics.customerPaymentStatus` | read | — | — | yes | yes | yes |
| `analytics.jobCompletion` | read | — | — | yes | yes | yes |
| `analytics.jobStats` | read | — | — | yes | yes | yes |
| `analytics.labourStats` | read | — | — | yes | yes | yes |
| `analytics.myWeeklyStats` | read | yes | yes | yes | yes | yes |
| `analytics.quoteStats` | read | — | — | yes | yes | yes |
| `analytics.revenueStats` | read | — | — | yes | yes | yes |
| `analytics.weatherForecast` | read | yes | yes | yes | yes | yes |
| `analytics.weeklyOperationsSummary` | read | — | — | yes | yes | yes |
| `analytics.weeklyProductivity` | read | — | — | yes | yes | yes |
| `analytics.xeroRevenue` | read | — | — | yes | yes | yes |

### antifouling

| Procedure | Kind | Customer | Technician | Office | Management | Admin |
|---|---|---|---|---|---|---|
| `antifouling.getForJob` | read | — | own only | yes | yes | yes |
| `antifouling.save` | write | — | own only | yes | yes | yes |

### assistant

| Procedure | Kind | Customer | Technician | Office | Management | Admin |
|---|---|---|---|---|---|---|
| `assistant.ask` | write | — | yes | yes | yes | yes |
| `assistant.status` | read | yes | yes | yes | yes | yes |

### auth

| Procedure | Kind | Customer | Technician | Office | Management | Admin |
|---|---|---|---|---|---|---|
| `auth.acceptInvite` *(public)* | write | yes | yes | yes | yes | yes |
| `auth.bootstrapAdmin` | write | — | — | — | — | — |
| `auth.inviteInfo` *(public)* | read | yes | yes | yes | yes | yes |
| `auth.login` | write | — | — | — | — | — |
| `auth.logout` *(public)* | write | yes | yes | yes | yes | yes |
| `auth.me` *(public)* | read | yes | yes | yes | yes | yes |
| `auth.needsBootstrap` *(public)* | read | yes | yes | yes | yes | yes |
| `auth.register` *(public)* | write | yes | yes | yes | yes | yes |
| `auth.requestPasswordReset` *(public)* | write | yes | yes | yes | yes | yes |
| `auth.resetPassword` *(public)* | write | yes | yes | yes | yes | yes |

### businessExpenses

| Procedure | Kind | Customer | Technician | Office | Management | Admin |
|---|---|---|---|---|---|---|
| `businessExpenses.create` | write | — | — | yes | yes | yes |
| `businessExpenses.delete` | write | — | — | yes | yes | yes |
| `businessExpenses.list` | read | — | — | yes | yes | yes |
| `businessExpenses.summary` | read | — | — | yes | yes | yes |

### calendarNotes

| Procedure | Kind | Customer | Technician | Office | Management | Admin |
|---|---|---|---|---|---|---|
| `calendarNotes.create` | write | — | — | yes | yes | yes |
| `calendarNotes.delete` | write | — | — | yes | yes | yes |
| `calendarNotes.list` | read | — | yes | yes | yes | yes |

### customerMessages

| Procedure | Kind | Customer | Technician | Office | Management | Admin |
|---|---|---|---|---|---|---|
| `customerMessages.create` | write | yes | — | — | — | — |
| `customerMessages.list` | read | — | — | yes | yes | yes |
| `customerMessages.listForCustomer` | read | own only | — | yes | yes | yes |
| `customerMessages.reply` | write | — | — | yes | yes | yes |
| `customerMessages.resolve` | write | — | — | yes | yes | yes |

### customers

| Procedure | Kind | Customer | Technician | Office | Management | Admin |
|---|---|---|---|---|---|---|
| `customers.addCommunicationEntry` | write | — | — | yes | yes | yes |
| `customers.bulkImport` | write | — | — | yes | yes | yes |
| `customers.cancelPortalInvite` | write | — | — | yes | yes | yes |
| `customers.create` | write | — | — | yes | yes | yes |
| `customers.delete` | write | — | — | yes | yes | yes |
| `customers.getById` | read | own only | own only | yes | yes | yes |
| `customers.list` | read | yes | yes | yes | yes | yes |
| `customers.portalAccess` | read | — | — | yes | yes | yes |
| `customers.sendPortalInvite` | write | — | — | yes | yes | yes |
| `customers.update` | write | — | — | yes | yes | yes |

### documents

| Procedure | Kind | Customer | Technician | Office | Management | Admin |
|---|---|---|---|---|---|---|
| `documents.addComment` | write | own only | own only | yes | yes | yes |
| `documents.commentsFor` | read | yes | yes | yes | yes | yes |
| `documents.delete` | write | — | — | yes | yes | yes |
| `documents.list` | read | yes | yes | yes | yes | yes |
| `documents.listAllForStaff` | read | — | — | yes | yes | yes |
| `documents.listByJob` | read | own only | own only | yes | yes | yes |
| `documents.listByQuote` | read | own only | own only | yes | yes | yes |
| `documents.listByVessel` | read | own only | own only | yes | yes | yes |
| `documents.updateCaption` | write | — | own only | yes | yes | yes |

### employees

| Procedure | Kind | Customer | Technician | Office | Management | Admin |
|---|---|---|---|---|---|---|
| `employees.create` | write | — | — | — | — | yes |
| `employees.deactivate` | write | — | — | — | — | yes |
| `employees.delete` | write | — | — | — | — | yes |
| `employees.getById` | read | — | yes | yes | yes | yes |
| `employees.list` | read | — | yes | yes | yes | yes |
| `employees.listWithJobCounts` | read | — | — | yes | yes | yes |
| `employees.reactivate` | write | — | — | — | — | yes |
| `employees.update` | write | — | — | — | — | yes |

### imports

| Procedure | Kind | Customer | Technician | Office | Management | Admin |
|---|---|---|---|---|---|---|
| `imports.bulkImport` | write | — | — | yes | yes | yes |

### inventory

| Procedure | Kind | Customer | Technician | Office | Management | Admin |
|---|---|---|---|---|---|---|
| `inventory.adjustStock` | write | — | — | yes | yes | yes |
| `inventory.create` | write | — | — | yes | yes | yes |
| `inventory.delete` | write | — | — | yes | yes | yes |
| `inventory.list` | read | — | yes | yes | yes | yes |
| `inventory.update` | write | — | — | yes | yes | yes |

### invoices

| Procedure | Kind | Customer | Technician | Office | Management | Admin |
|---|---|---|---|---|---|---|
| `invoices.approve` | write | own only | — | — | — | — |
| `invoices.assign` | write | — | — | yes | yes | yes |
| `invoices.checkStripeStatus` | read | — | — | yes | yes | yes |
| `invoices.claimReviewDiscount` | write | own only | — | — | — | — |
| `invoices.createForJob` | write | — | — | yes | yes | yes |
| `invoices.createPaymentIntent` | write | own only | — | — | — | — |
| `invoices.delete` | write | — | — | yes | yes | yes |
| `invoices.getById` | read | own only | — | yes | yes | yes |
| `invoices.getByJob` | read | own only | — | yes | yes | yes |
| `invoices.listAll` | read | — | — | yes | yes | yes |
| `invoices.listByCustomer` | read | — | — | yes | yes | yes |
| `invoices.listMine` | read | yes | yes | yes | yes | yes |
| `invoices.markPaidManually` | write | — | — | yes | yes | yes |
| `invoices.markRefundedManually` | write | — | — | — | yes | yes |
| `invoices.paymentConfig` | read | yes | yes | yes | yes | yes |
| `invoices.reconcilePayment` | write | — | — | yes | yes | yes |
| `invoices.send` | write | — | — | yes | yes | yes |
| `invoices.syncToXero` | write | — | — | yes | yes | yes |
| `invoices.void` | write | — | — | — | yes | yes |
| `invoices.xeroPayLink` | read | own only | — | — | — | — |

### jobCosts

| Procedure | Kind | Customer | Technician | Office | Management | Admin |
|---|---|---|---|---|---|---|
| `jobCosts.create` | write | — | — | yes | yes | yes |
| `jobCosts.createBill` | write | — | — | yes | yes | yes |
| `jobCosts.delete` | write | — | — | yes | yes | yes |
| `jobCosts.extractFromDocument` | write | — | — | yes | yes | yes |
| `jobCosts.itemCodes` | read | — | — | yes | yes | yes |
| `jobCosts.listForJob` | read | — | — | yes | yes | yes |
| `jobCosts.ocrStatus` | read | — | — | yes | yes | yes |
| `jobCosts.summaryForJob` | read | — | — | yes | yes | yes |
| `jobCosts.update` | write | — | — | yes | yes | yes |

### jobMap

| Procedure | Kind | Customer | Technician | Office | Management | Admin |
|---|---|---|---|---|---|---|
| `jobMap.activeJobs` | read | — | — | yes | yes | yes |

### jobPlan

| Procedure | Kind | Customer | Technician | Office | Management | Admin |
|---|---|---|---|---|---|---|
| `jobPlan.create` | write | — | own only | yes | yes | yes |
| `jobPlan.delete` | write | — | own only | yes | yes | yes |
| `jobPlan.listForJob` | read | — | own only | yes | yes | yes |
| `jobPlan.listForJobs` | read | — | own only | yes | yes | yes |

### jobSignatures

| Procedure | Kind | Customer | Technician | Office | Management | Admin |
|---|---|---|---|---|---|---|
| `jobSignatures.create` | write | — | own only | yes | yes | yes |
| `jobSignatures.listForJob` | read | — | own only | yes | yes | yes |

### jobs

| Procedure | Kind | Customer | Technician | Office | Management | Admin |
|---|---|---|---|---|---|---|
| `jobs.assignTechnician` | write | — | — | yes | yes | yes |
| `jobs.cancel` | write | — | — | yes | yes | yes |
| `jobs.create` | write | — | — | yes | yes | yes |
| `jobs.delete` | write | — | — | yes | yes | yes |
| `jobs.deletePreview` | read | — | — | yes | yes | yes |
| `jobs.getAssignments` | read | own only | own only | yes | yes | yes |
| `jobs.getById` | read | own only | own only | yes | yes | yes |
| `jobs.getEligibility` | read | — | — | yes | yes | yes |
| `jobs.list` | read | yes | yes | yes | yes | yes |
| `jobs.myJobs` | read | yes | yes | yes | yes | yes |
| `jobs.notifyDelay` | write | — | — | yes | yes | yes |
| `jobs.reassignTechnician` | write | — | — | yes | yes | yes |
| `jobs.requestAdditionalWork` | write | — | own only | yes | yes | yes |
| `jobs.respondToAdditionalWork` | write | own only | — | — | — | — |
| `jobs.technicianNames` | read | — | — | yes | yes | yes |
| `jobs.unassignTechnician` | write | — | — | yes | yes | yes |
| `jobs.update` | write | — | own only | yes | yes | yes |

### materialRequests

| Procedure | Kind | Customer | Technician | Office | Management | Admin |
|---|---|---|---|---|---|---|
| `materialRequests.approve` | write | — | — | yes | yes | yes |
| `materialRequests.create` | write | — | own only | yes | yes | yes |
| `materialRequests.listAll` | read | — | — | yes | yes | yes |
| `materialRequests.listForJob` | read | — | own only | yes | yes | yes |
| `materialRequests.listMine` | read | — | yes | yes | yes | yes |
| `materialRequests.markOrdered` | write | — | — | yes | yes | yes |
| `materialRequests.reject` | write | — | — | yes | yes | yes |

### notifications

| Procedure | Kind | Customer | Technician | Office | Management | Admin |
|---|---|---|---|---|---|---|
| `notifications.list` | read | yes | yes | yes | yes | yes |
| `notifications.markAllRead` | write | yes | yes | yes | yes | yes |
| `notifications.markRead` | write | yes | yes | yes | yes | yes |

### predictions

| Procedure | Kind | Customer | Technician | Office | Management | Admin |
|---|---|---|---|---|---|---|
| `predictions.jobDurationEstimate` | read | — | — | yes | yes | yes |
| `predictions.quoteAcceptanceLikelihood` | read | — | — | yes | yes | yes |
| `predictions.suggestForText` | read | — | — | yes | yes | yes |

### quotes

| Procedure | Kind | Customer | Technician | Office | Management | Admin |
|---|---|---|---|---|---|---|
| `quotes.create` | write | — | — | yes | yes | yes |
| `quotes.createRevision` | write | — | — | yes | yes | yes |
| `quotes.delete` | write | — | — | yes | yes | yes |
| `quotes.dismissRevisionFollowUp` | write | — | — | yes | yes | yes |
| `quotes.getById` | read | own only | own only | yes | yes | yes |
| `quotes.getRevisions` | read | own only | own only | yes | yes | yes |
| `quotes.list` | read | yes | yes | yes | yes | yes |
| `quotes.update` | write | — | — | yes | yes | yes |

### reports

| Procedure | Kind | Customer | Technician | Office | Management | Admin |
|---|---|---|---|---|---|---|
| `reports.emailMorningBriefing` | write | — | — | yes | yes | yes |
| `reports.endOfDaySummary` | read | — | — | yes | yes | yes |
| `reports.inventoryStatus` | read | — | — | yes | yes | yes |
| `reports.materialRequirements` | read | — | — | yes | yes | yes |
| `reports.morningBriefing` | read | — | — | yes | yes | yes |
| `reports.outstandingPayments` | read | — | — | yes | yes | yes |
| `reports.outstandingQuotes` | read | — | — | yes | yes | yes |
| `reports.technicianPerformance` | read | — | — | yes | yes | yes |
| `reports.upcomingServices` | read | — | — | yes | yes | yes |
| `reports.weeklyOperationsReport` | read | — | — | yes | yes | yes |
| `reports.workshopCapacity` | read | — | — | yes | yes | yes |

### schedules

| Procedure | Kind | Customer | Technician | Office | Management | Admin |
|---|---|---|---|---|---|---|
| `schedules.checkConflict` | read | — | own only | yes | yes | yes |
| `schedules.create` | write | — | — | yes | yes | yes |
| `schedules.delete` | write | — | — | yes | yes | yes |
| `schedules.getByDate` | read | — | yes | yes | yes | yes |
| `schedules.list` | read | — | yes | yes | yes | yes |
| `schedules.update` | write | — | — | yes | yes | yes |

### staffTasks

| Procedure | Kind | Customer | Technician | Office | Management | Admin |
|---|---|---|---|---|---|---|
| `staffTasks.assignableUsers` | read | — | — | yes | yes | yes |
| `staffTasks.claim` | write | — | — | yes | yes | yes |
| `staffTasks.complete` | write | — | — | yes | yes | yes |
| `staffTasks.create` | write | — | — | yes | yes | yes |
| `staffTasks.delete` | write | — | — | yes | yes | yes |
| `staffTasks.list` | read | — | — | yes | yes | yes |
| `staffTasks.update` | write | — | — | yes | yes | yes |

### suppliers

| Procedure | Kind | Customer | Technician | Office | Management | Admin |
|---|---|---|---|---|---|---|
| `suppliers.create` | write | — | — | yes | yes | yes |
| `suppliers.delete` | write | — | — | yes | yes | yes |
| `suppliers.list` | read | — | — | yes | yes | yes |
| `suppliers.update` | write | — | — | yes | yes | yes |

### tasks

| Procedure | Kind | Customer | Technician | Office | Management | Admin |
|---|---|---|---|---|---|---|
| `tasks.addNote` | write | — | own only | yes | yes | yes |
| `tasks.complete` | write | — | own only | yes | yes | yes |
| `tasks.create` | write | — | own only | yes | yes | yes |
| `tasks.delete` | write | — | — | yes | yes | yes |
| `tasks.listForJob` | read | — | own only | yes | yes | yes |
| `tasks.listForJobs` | read | — | own only | yes | yes | yes |
| `tasks.myTasks` | read | yes | yes | yes | yes | yes |
| `tasks.pause` | write | — | own only | yes | yes | yes |
| `tasks.progressForJobs` | read | yes | own only | yes | yes | yes |
| `tasks.reopen` | write | — | — | yes | yes | yes |
| `tasks.start` | write | — | own only | yes | yes | yes |
| `tasks.update` | write | — | — | yes | yes | yes |

### timeEntries

| Procedure | Kind | Customer | Technician | Office | Management | Admin |
|---|---|---|---|---|---|---|
| `timeEntries.activeEntry` | read | — | own only | yes | yes | yes |
| `timeEntries.clockIn` | write | — | own only | yes | — | yes |
| `timeEntries.clockOut` | write | — | own only | yes | — | yes |
| `timeEntries.create` | write | — | own only | yes | — | yes |
| `timeEntries.internalCostList` | read | — | — | — | yes | yes |
| `timeEntries.internalCostSummary` | read | — | — | — | yes | yes |
| `timeEntries.listByEmployee` | read | — | own only | yes | yes | yes |
| `timeEntries.listByJob` | read | — | own only | yes | yes | yes |
| `timeEntries.switchJob` | write | — | own only | yes | — | yes |
| `timeEntries.update` | write | — | — | yes | yes | yes |

### timeline

| Procedure | Kind | Customer | Technician | Office | Management | Admin |
|---|---|---|---|---|---|---|
| `timeline.overview` | read | — | — | yes | yes | yes |

### vessels

| Procedure | Kind | Customer | Technician | Office | Management | Admin |
|---|---|---|---|---|---|---|
| `vessels.create` | write | — | — | yes | yes | yes |
| `vessels.delete` | write | — | — | yes | yes | yes |
| `vessels.getById` | read | own only | own only | yes | yes | yes |
| `vessels.list` | read | yes | yes | yes | yes | yes |
| `vessels.listByCustomer` | read | own only | own only | yes | yes | yes |
| `vessels.update` | write | — | — | yes | yes | yes |
