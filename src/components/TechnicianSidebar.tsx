import { useLocation } from "wouter";
import { Calendar as CalendarIcon, Package, Wrench } from "lucide-react";

/**
 * The technician's simplified desktop sidebar (Today / Calendar /
 * Materials) — shared between the Today dashboard and the Calendar page
 * so a technician never loses their nav just because a link took them to
 * a different route. Hidden on mobile; those pages keep their own bottom
 * nav.
 *
 * No Task Centre entry here on purpose — that's the office to-do pool.
 * Technicians only see tasks assigned to their own jobs, on the Today
 * page, not the shared office board.
 */
export function TechnicianSidebar({
  active,
  onMaterialsClick,
}: {
  active: "today" | "calendar";
  onMaterialsClick?: () => void;
}) {
  const [, navigate] = useLocation();

  return (
    <aside className="fixed inset-y-0 left-0 z-20 hidden w-56 flex-col bg-[#0c1e38] text-white md:flex">
      <div className="flex h-16 items-center gap-2 px-5">
        <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-white/10">
          <Wrench className="h-4 w-4" />
        </div>
        <span className="text-sm font-semibold tracking-wide">Boatology</span>
      </div>

      <nav className="space-y-0.5 px-3 py-2">
        <button
          className={`flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-sm ${
            active === "today" ? "bg-white/10 font-medium text-white" : "text-white/70 hover:bg-white/5 hover:text-white"
          }`}
          onClick={() => navigate("/technician-home")}
        >
          <Wrench className="h-4 w-4 shrink-0" />
          Today
        </button>
        <button
          className={`flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-sm ${
            active === "calendar" ? "bg-white/10 font-medium text-white" : "text-white/70 hover:bg-white/5 hover:text-white"
          }`}
          onClick={() => navigate("/calendar")}
        >
          <CalendarIcon className="h-4 w-4 shrink-0" />
          Calendar
        </button>
        <button
          className="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-sm text-white/70 hover:bg-white/5 hover:text-white"
          onClick={() => (onMaterialsClick ? onMaterialsClick() : navigate("/materials"))}
        >
          <Package className="h-4 w-4 shrink-0" />
          Materials
        </button>
      </nav>
    </aside>
  );
}
