import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { showErrorToast } from "@/lib/errors";
import { trpc } from "@/lib/trpc";
import { useEffect, useState } from "react";
import { toast } from "sonner";

type Rules = Record<string, Record<string, string[]>>;

const ROLE_LABELS: Record<string, string> = {
  management: "Management",
  office_staff: "Office staff",
  technician: "Technicians",
  customer: "Customers (portal)",
};

const ACTION_LABELS: Record<string, string> = { view: "View", add: "Add", edit: "Edit", delete: "Delete" };

/**
 * Switch off view / add / edit / delete per role, per area of the app.
 * Everything starts ticked (= each role's normal access). Un-ticking only ever
 * removes access — it can't give a role something it never had. Admins always
 * keep full access.
 */
export function AccessControlCard() {
  const utils = trpc.useUtils();
  const query = trpc.administration.accessRules.useQuery();
  const saveMutation = trpc.administration.saveAccessRules.useMutation({
    onSuccess: () => {
      toast.success("Access settings saved");
      utils.administration.accessRules.invalidate();
    },
    onError: (err) => showErrorToast(err),
  });

  const [role, setRole] = useState("office_staff");
  const [rules, setRules] = useState<Rules>({});

  useEffect(() => {
    if (query.data) setRules(query.data.rules as Rules);
  }, [query.data]);

  if (!query.data) return null;
  const { modules, actions, roles } = query.data;

  const isOn = (moduleKey: string, action: string) => {
    const set = rules[role]?.[moduleKey];
    return set ? set.includes(action) : true;
  };

  const toggle = (moduleKey: string, action: string) => {
    const current = rules[role]?.[moduleKey] ?? [...actions];
    const next = current.includes(action) ? current.filter((a) => a !== action) : [...current, action];
    setRules({ ...rules, [role]: { ...(rules[role] || {}), [moduleKey]: next } });
  };

  const resetRole = () => {
    const { [role]: _removed, ...rest } = rules;
    setRules(rest);
  };

  return (
    <Card className="mb-6 border-slate-200 bg-white shadow-sm">
      <div className="p-6">
        <h2 className="mb-1 text-lg font-semibold text-slate-900">Who can see and change what</h2>
        <p className="mb-4 text-sm text-slate-600">
          Choose a role, then untick anything they shouldn't be able to do in that area. Administrators always have full access, and
          unticking never gives a role more than it already had.
        </p>

        <div className="mb-4 flex flex-wrap gap-2">
          {roles.map((r) => (
            <Button key={r} size="sm" variant={role === r ? "default" : "outline"} className={role === r ? "bg-[#0c1e38]" : ""} onClick={() => setRole(r)}>
              {ROLE_LABELS[r] || r}
            </Button>
          ))}
        </div>

        <div className="overflow-x-auto rounded-lg border border-slate-200">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-200 bg-slate-50 text-left text-xs text-slate-600">
                <th className="px-3 py-2">Area</th>
                {actions.map((a) => (
                  <th key={a} className="px-3 py-2 text-center">
                    {ACTION_LABELS[a] || a}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {modules.map((m) => (
                <tr key={m.key} className="border-b border-slate-100 last:border-0">
                  <td className="px-3 py-2 text-slate-800">{m.label}</td>
                  {actions.map((a) => (
                    <td key={a} className="px-3 py-2 text-center">
                      <input type="checkbox" className="h-4 w-4" checked={isOn(m.key, a)} onChange={() => toggle(m.key, a)} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="mt-4 flex gap-2">
          <Button className="bg-[#0c1e38] hover:bg-[#0c1e38]/90" onClick={() => saveMutation.mutate({ rules })} disabled={saveMutation.isPending}>
            {saveMutation.isPending ? "Saving..." : "Save access settings"}
          </Button>
          <Button variant="outline" onClick={resetRole}>
            Reset {ROLE_LABELS[role] || role} to normal
          </Button>
        </div>
      </div>
    </Card>
  );
}
