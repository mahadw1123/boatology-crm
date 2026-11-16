# Performance findings

## Method

`npm run perf:benchmark` builds a temporary database the size of several busy years — 3,000 customers, 8,000 quotes, 6,000 jobs, 9,000 invoices, 20,000 tasks, 30,000 time entries, 15,000 documents, 10,000 notifications — and times the calls each screen makes (median of 5). Figures are from one laptop and vary by about ±20% between runs. Pass a scale, for example `npm run perf:benchmark -- 0.2`, for a smaller database.

Production data today is far smaller, so nothing here is slow for users yet. These are the figures the app approaches as data grows.

One fact frames everything: the database driver is synchronous and there is one server process, so **while one request runs, every other user waits**. A one-second request is a one-second pause for everyone.

## Results

| Call | Before | After |
|---|---|---|
| Dashboard: all queries, as the browser sends them (one batched request) | about 4,200 ms | about 1,000 ms |
| Job statistics | 60 ms | 1 ms |
| Quote statistics | 154 ms | 1 ms |
| Employees with open-job counts | 108 ms | 7 ms |
| Technician performance report | 327 ms | 47 ms |
| Weekly operations summary | 916 ms | about 440 ms alone; shares its reads inside the Dashboard request |
| Create a job (number allocation) | 103 ms | 5 ms |
| Technician: my jobs | 106 ms | 3 ms |
| Technician: agenda | 274 ms | 14 ms |
| Technician: customers | 71 ms | 28 ms |
| Notification poll (every 30 seconds per signed-in user) | 3,333 rows, 778 KB | 200 rows, 47 KB |

## What was done

1. **44 indexes** on the columns queries filter and join on. Before, only unique keys were indexed; a sample of 15 common queries all scanned whole tables and now all use an index.
2. **Counting in the database.** Job and quote statistics, open jobs per employee, technician performance and "who is clocked in" loaded whole tables to count rows.
3. **Targeted technician queries.** "My jobs" and "my tasks" read every job and every task and filtered in memory, on almost every technician request.
4. **Numbering from a prefix query** instead of loading every job, quote or invoice.
5. **Notification list capped** at the newest 200.
6. **Read sharing within a request.** The Dashboard sends about a dozen queries at once and most begin by reading the same tables. Inside one read-only request each table is now read once (`withReadCache`, `server/db.ts`). It never spans requests, and is off for writes, background jobs and tests.
7. **One quadratic loop** in the weekly summary replaced by a lookup.

## Remaining costs, largest first

| Cost | Size at benchmark scale | Fix |
|---|---|---|
| The Dashboard downloads every customer, vessel, quote, job and invoice and computes its figures in the browser | 29 MB per load; quotes alone 11.5 MB | A summary endpoint that returns the dozen numbers and short lists the Dashboard shows |
| List pages (Quotes, Jobs, Invoices, Documents, Contacts, Vessels) download the whole list and filter in the browser | 1–11 MB each | Server-side paging, search and sort |
| Global search downloads five whole lists on the first keystroke | about 27 MB | A search endpoint |
| Office agenda | about 1,000 ms | Query only open items; it currently reads eleven tables in full |
| Business health (Analytics) | about 500 ms | Count in SQL |
| Quote rows carry their line items as JSON, parsed on every read | part of every quote read | Leave line items out of list reads |
| Response compression | unknown | Check `Content-Encoding` on the live site; if the host does not compress API responses, enabling it cuts transfer roughly tenfold |
| Main script bundle | 652 KB (Analytics 452 KB and the QR scanner 337 KB already load on demand) | Split vendor code |

The first three are one piece of work across about 20 screens and are the most valuable performance change left.

## Scaling limits by design

- **One server, one database file.** SQLite with a synchronous driver cannot be run as several instances. This is adequate for one business with tens of staff; it is not a path to many businesses on one deployment. Moving to PostgreSQL is the change that would remove the limit, and it is a project in its own right.
- **Uploads are on the same disk** (1 GB in `render.yaml`) as the database. Photos will fill it before data does; watch disk use, or move files to object storage.
- **The read cache and the rate limiters are in memory**, which is correct only while there is a single instance.
