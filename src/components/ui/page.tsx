import * as React from "react";
import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Page-level building blocks shared by every screen, so headers, empty
 * states, loading placeholders and tables look and behave the same
 * everywhere instead of being rebuilt per page.
 */

/** Standard page padding and width. */
export function Page({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("enter mx-auto w-full max-w-[1400px] px-4 py-5 sm:px-6 sm:py-6", className)} {...props} />;
}

/** Title, optional description, and the page's actions on the right. */
export function PageHeader({
  title,
  description,
  actions,
  className,
}: {
  title: React.ReactNode;
  description?: React.ReactNode;
  actions?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("mb-5 flex flex-wrap items-end justify-between gap-x-4 gap-y-3", className)}>
      <div className="min-w-0">
        <h1 className="truncate text-2xl font-semibold tracking-tight text-navy">{title}</h1>
        {description && <p className="mt-1 text-sm text-slate-500">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

/** Shown in place of a list or section that has nothing in it yet. */
export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  className,
}: {
  icon?: LucideIcon;
  title: React.ReactNode;
  description?: React.ReactNode;
  action?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-col items-center justify-center px-6 py-12 text-center", className)}>
      {Icon && (
        <div className="mb-3 flex h-11 w-11 items-center justify-center rounded-full bg-surface-muted text-slate-400">
          <Icon className="h-5 w-5" aria-hidden="true" />
        </div>
      )}
      <p className="text-sm font-medium text-navy">{title}</p>
      {description && <p className="mt-1 max-w-sm text-sm text-slate-500">{description}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

/** A single loading placeholder block. */
export function Skeleton({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div aria-hidden="true" className={cn("skeleton h-4", className)} {...props} />;
}

/** Placeholder rows for a table that is still loading. */
export function TableSkeleton({ rows = 6, columns = 5 }: { rows?: number; columns?: number }) {
  return (
    <div role="status" aria-label="Loading" className="divide-y divide-border">
      {Array.from({ length: rows }, (_, row) => (
        <div key={row} className="flex items-center gap-4 px-4 py-3.5">
          {Array.from({ length: columns }, (_, column) => (
            <Skeleton key={column} className={cn("h-3.5", column === 0 ? "w-1/4" : "flex-1")} style={{ opacity: 1 - row * 0.1 }} />
          ))}
        </div>
      ))}
    </div>
  );
}

/**
 * The frame for a data table: a bordered surface that scrolls sideways on
 * narrow screens instead of breaking the page. Put a plain <table> inside
 * and use the Th / Td / Tr helpers for consistent spacing.
 */
export function TableCard({ className, children, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={cn("overflow-hidden rounded-xl border border-border bg-white shadow-card", className)} {...props}>
      <div className="overflow-x-auto">{children}</div>
    </div>
  );
}

export function Th({ className, ...props }: React.ThHTMLAttributes<HTMLTableCellElement>) {
  return (
    <th
      scope="col"
      className={cn("whitespace-nowrap border-b border-border bg-surface-muted/60 px-4 py-2.5 text-left text-xs font-medium text-slate-500", className)}
      {...props}
    />
  );
}

export function Td({ className, ...props }: React.TdHTMLAttributes<HTMLTableCellElement>) {
  return <td className={cn("px-4 py-3 text-sm text-ink", className)} {...props} />;
}

/** A table row; pass onClick to make the whole row open a record. */
export function Tr({ className, onClick, ...props }: React.HTMLAttributes<HTMLTableRowElement>) {
  return (
    <tr
      onClick={onClick}
      className={cn("border-b border-border/70 last:border-0", onClick && "cursor-pointer transition-colors hover:bg-surface-muted/70", className)}
      {...props}
    />
  );
}
