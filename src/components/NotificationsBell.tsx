import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, Bell, Briefcase, CheckCheck, FileText, Receipt, Users } from "lucide-react";
import { trpc } from "@/lib/trpc";

type Notification = {
  id: number;
  type: string;
  title: string;
  message?: string | null;
  relatedEntityType?: string | null;
  relatedEntityId?: number | null;
  isRead?: boolean | null;
  createdAt: string;
};

const PAGE_SIZE = 25;

function iconFor(n: Notification) {
  if (n.relatedEntityType === "invoice" || n.type === "invoice_issued") return { Icon: Receipt, tone: "bg-emerald-100 text-emerald-700" };
  if (n.relatedEntityType === "quote" || n.type.startsWith("quote_")) return { Icon: FileText, tone: "bg-blue-100 text-blue-700" };
  if (n.relatedEntityType === "job" || n.type.startsWith("job_") || n.type === "additional_work_approval") return { Icon: Briefcase, tone: "bg-amber-100 text-amber-700" };
  if (n.relatedEntityType === "customer") return { Icon: Users, tone: "bg-violet-100 text-violet-700" };
  if (n.relatedEntityType === "system_error") return { Icon: AlertTriangle, tone: "bg-red-100 text-red-700" };
  return { Icon: Bell, tone: "bg-slate-100 text-slate-600" };
}

function relativeTime(iso: string) {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const minutes = Math.round((Date.now() - then) / 60000);
  if (minutes < 1) return "Just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hr ago`;
  return new Date(iso).toLocaleDateString("en-AU", { day: "numeric", month: "short" });
}

function dayGroup(iso: string) {
  const d = new Date(iso);
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);
  const diffDays = Math.floor((startOfToday.getTime() - new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()) / 86400000);
  if (diffDays <= 0) return "Today";
  if (diffDays === 1) return "Yesterday";
  if (diffDays < 7) return "This week";
  return "Earlier";
}

/**
 * Shared notification bell for the staff and technician layouts.
 * `onOpen` receives the notification so each layout can route it its own way.
 */
export function NotificationsBell({ onOpen }: { onOpen: (n: Notification) => void }) {
  const [isOpen, setIsOpen] = useState(false);
  const [tab, setTab] = useState<"all" | "unread">("all");
  const [visible, setVisible] = useState(PAGE_SIZE);
  const utils = trpc.useUtils();
  const notificationsQuery = trpc.notifications.list.useQuery(undefined, { refetchInterval: 30000 });

  const markReadMutation = trpc.notifications.markRead.useMutation({
    onSuccess: () => utils.notifications.list.invalidate(),
  });
  const markAllMutation = trpc.notifications.markAllRead.useMutation({
    onSuccess: () => utils.notifications.list.invalidate(),
  });

  const all = (notificationsQuery.data || []) as Notification[];
  const unreadCount = all.filter((n) => !n.isRead).length;
  const shown = tab === "unread" ? all.filter((n) => !n.isRead) : all;

  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setIsOpen(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isOpen]);

  const groups = useMemo(() => {
    const order = ["Today", "Yesterday", "This week", "Earlier"];
    const map = new Map<string, Notification[]>();
    for (const n of shown.slice(0, visible)) {
      const key = dayGroup(n.createdAt);
      map.set(key, [...(map.get(key) || []), n]);
    }
    return order.filter((k) => map.has(k)).map((k) => ({ label: k, items: map.get(k)! }));
  }, [shown, visible]);

  const select = (n: Notification) => {
    if (!n.isRead) markReadMutation.mutate({ id: n.id });
    setIsOpen(false);
    onOpen(n);
  };

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setIsOpen((v) => !v)}
        aria-label={unreadCount > 0 ? `Notifications, ${unreadCount} unread` : "Notifications"}
        className="relative rounded-lg p-2 text-slate-500 hover:bg-slate-100"
      >
        <Bell className="h-5 w-5" />
        {unreadCount > 0 && (
          <span className="absolute right-1 top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-red-500 px-1 text-[10px] font-bold text-white">
            {unreadCount > 9 ? "9+" : unreadCount}
          </span>
        )}
      </button>

      {isOpen && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setIsOpen(false)} />
          <div className="absolute right-0 top-full z-20 mt-2 w-[22rem] max-w-[calc(100vw-1.5rem)] rounded-lg border border-slate-200 bg-white text-slate-900 shadow-lg">
            <div className="flex items-center justify-between border-b border-slate-100 px-4 py-2.5">
              <p className="text-sm font-semibold">Notifications</p>
              <button
                type="button"
                disabled={unreadCount === 0 || markAllMutation.isPending}
                onClick={() => markAllMutation.mutate()}
                className="flex items-center gap-1 text-xs font-medium text-blue-700 hover:underline disabled:cursor-not-allowed disabled:text-slate-400 disabled:no-underline"
              >
                <CheckCheck className="h-3.5 w-3.5" />
                Mark all as read
              </button>
            </div>

            <div className="flex gap-1 border-b border-slate-100 px-3 py-2">
              {(["all", "unread"] as const).map((t) => (
                <button
                  key={t}
                  type="button"
                  onClick={() => {
                    setTab(t);
                    setVisible(PAGE_SIZE);
                  }}
                  className={`rounded-full px-3 py-1 text-xs font-medium ${tab === t ? "bg-[#0c1e38] text-white" : "text-slate-600 hover:bg-slate-100"}`}
                >
                  {t === "all" ? "All" : `Unread${unreadCount ? ` (${unreadCount})` : ""}`}
                </button>
              ))}
            </div>

            <div className="max-h-[26rem] overflow-y-auto">
              {shown.length === 0 ? (
                <p className="px-4 py-8 text-center text-sm text-slate-500">
                  {tab === "unread" ? "You're all caught up." : "No notifications yet."}
                </p>
              ) : (
                groups.map((group) => (
                  <div key={group.label}>
                    <p className="sticky top-0 bg-slate-50 px-4 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-slate-500">{group.label}</p>
                    {group.items.map((n) => {
                      const { Icon, tone } = iconFor(n);
                      return (
                        <button
                          key={n.id}
                          type="button"
                          onClick={() => select(n)}
                          className={`flex w-full gap-3 border-b border-slate-100 px-4 py-3 text-left last:border-0 hover:bg-slate-50 ${!n.isRead ? "bg-blue-50/60" : ""}`}
                        >
                          <span className={`mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full ${tone}`}>
                            <Icon className="h-4 w-4" />
                          </span>
                          <span className="min-w-0 flex-1">
                            <span className="flex items-start justify-between gap-2">
                              <span className={`text-sm ${!n.isRead ? "font-semibold" : "font-medium"} text-slate-900`}>{n.title}</span>
                              {!n.isRead && <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-blue-600" aria-label="Unread" />}
                            </span>
                            {n.message && <span className="mt-0.5 line-clamp-2 block text-xs text-slate-500">{n.message}</span>}
                            <span className="mt-1 block text-xs text-slate-400">{relativeTime(n.createdAt)}</span>
                          </span>
                        </button>
                      );
                    })}
                  </div>
                ))
              )}
              {shown.length > visible && (
                <button
                  type="button"
                  onClick={() => setVisible((v) => v + PAGE_SIZE)}
                  className="block w-full px-4 py-3 text-center text-xs font-medium text-blue-700 hover:bg-slate-50"
                >
                  Show older notifications
                </button>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
