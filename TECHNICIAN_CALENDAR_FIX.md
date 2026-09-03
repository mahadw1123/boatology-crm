# Technician Calendar Fix

The Calendar page previously called the management-only `employees.listWithJobCounts` endpoint for every role. A technician could open the page, but that background request generated a misleading permission notification.

## Corrected behaviour

- Technicians can open Calendar without a permission error.
- Only jobs assigned to the signed-in technician are returned.
- Only that technician's schedule entries are returned.
- A **Today’s Schedule** section shows appointment times and links safely to the mobile job view.
- The seven-day Sydney weather forecast remains visible.
- A **My Materials** section shows the technician's own material requests and links to the Materials page.
- Team workload remains visible only to admin, management, and office staff.
- New Appointment and calendar-note controls are hidden from technicians because those actions are office/management functions.
- An unlinked technician login receives clear instructions to ask an administrator to link the login to an employee record.
- Local calendar dates no longer use UTC conversion, avoiding off-by-one-day errors in Australian time zones.

## Verification

Run:

```bash
npm install
npm run db:push
npm test
npm run typecheck
npm run dev
```

Then sign in as a technician and open Calendar. Confirm the page shows assigned jobs, the technician's own daily schedule, material requests, and weather without a permission notification.
