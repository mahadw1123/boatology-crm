import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { DeleteConfirmDialog } from "@/components/DeleteConfirmDialog";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { trpc } from "@/lib/trpc";
import { Settings, Users, CheckCircle2, XCircle, Download, AlertTriangle, Check } from "lucide-react";
import { useState, useEffect } from "react";
import { toast } from "sonner";
import { showErrorToast } from "@/lib/errors";

export default function Administration() {
  const [activeTab, setActiveTab] = useState("users");
  const [newService, setNewService] = useState({
    name: "",
    description: "",
    defaultPrice: "",
  });

  const usersQuery = trpc.auth.me.useQuery();
  const currentUser = usersQuery.data;

  // Check if user is admin
  if (currentUser && (currentUser as any)?.role !== "admin") {
    return (
      <div className="min-h-screen bg-gradient-to-br from-slate-50 via-white to-slate-50">
        <div className="border-b border-slate-200 bg-white shadow-sm">
          <div className="mx-auto max-w-7xl px-6 py-8">
            <h1 className="text-3xl font-semibold text-slate-900">Administration</h1>
          </div>
        </div>
        <div className="mx-auto max-w-7xl px-6 py-8">
          <Card className="border-slate-200 bg-white shadow-sm">
            <div className="p-8 text-center">
              <Settings className="mx-auto h-12 w-12 text-slate-400" />
              <p className="mt-4 text-slate-600">
                You do not have permission to access this page
              </p>
            </div>
          </Card>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 via-white to-slate-50">
      {/* Header */}
      <div className="border-b border-slate-200 bg-white shadow-sm">
        <div className="mx-auto max-w-7xl px-6 py-8">
          <div className="flex items-center justify-between">
            <div>
              <h1 className="text-3xl font-semibold text-slate-900">
                Administration
              </h1>
              <p className="mt-1 text-sm text-slate-600">
                Manage system settings and users
              </p>
            </div>
            <Settings className="h-8 w-8 text-[#2d4160]" />
          </div>
        </div>
      </div>

      {/* Main Content */}
      <div className="mx-auto max-w-7xl px-6 py-8">
        <Tabs value={activeTab} onValueChange={setActiveTab} className="w-full">
          <TabsList className="grid h-auto w-full grid-cols-2 md:h-10 md:grid-cols-6">
            <TabsTrigger value="users">Users</TabsTrigger>
            <TabsTrigger value="services">Services</TabsTrigger>
            <TabsTrigger value="integrations">Integrations</TabsTrigger>
            <TabsTrigger value="settings">Settings</TabsTrigger>
            <TabsTrigger value="audit-log">Audit Log</TabsTrigger>
            <TabsTrigger value="system-errors">System Errors</TabsTrigger>
          </TabsList>

          {/* Users Tab */}
          <TabsContent value="users" className="mt-6 space-y-6">
            <StaffInviteSection />

            <Card className="border-slate-200 bg-white shadow-sm">
              <div className="p-6">
                <h2 className="text-lg font-semibold text-slate-900 mb-4">Existing Users</h2>
                <ExistingUsersList />
              </div>
            </Card>
          </TabsContent>

          {/* Services Tab */}
          <TabsContent value="services" className="mt-6 space-y-6">
            <ServicesTabContent newService={newService} setNewService={setNewService} />
          </TabsContent>

          {/* Integrations Tab */}
          <TabsContent value="integrations" className="mt-6">
            <Card className="border-slate-200 bg-white shadow-sm">
              <div className="p-6">
                <h2 className="mb-4 text-lg font-semibold text-slate-900">Xero</h2>
                <XeroIntegrationCard />
              </div>
            </Card>
          </TabsContent>

          {/* Settings Tab */}
          <TabsContent value="settings" className="mt-6">
            <Card className="mb-6 border-slate-200 bg-white shadow-sm">
              <div className="p-6">
                <h2 className="mb-1 text-lg font-semibold text-slate-900">Database Backup</h2>
                <p className="mb-4 text-sm text-slate-600">
                  Download a full copy of the database (all customers, jobs, quotes, invoices,
                  everything) as a backup file.
                </p>
                <a href="/api/admin/download-database">
                  <Button variant="outline">
                    <Download className="mr-2 h-4 w-4" />
                    Download Database
                  </Button>
                </a>
              </div>
            </Card>

            <EmergencyContactSettingCard />

            <SystemSettingsCard />
          </TabsContent>

          <TabsContent value="audit-log" className="mt-6">
            <AuditLogTabContent />
          </TabsContent>

          <TabsContent value="system-errors" className="mt-6">
            <SystemErrorsTabContent />
          </TabsContent>
        </Tabs>
      </div>
    </div>
  );
}

function XeroIntegrationCard() {
  const statusQuery = trpc.administration.xeroStatus.useQuery();
  const disconnectMutation = trpc.administration.xeroDisconnect.useMutation({
    onSuccess: () => {
      toast.success("Disconnected from Xero");
      statusQuery.refetch();
    },
    onError: (err) => showErrorToast(err),
  });

  if (statusQuery.isLoading) {
    return <p className="text-sm text-slate-500">Checking Xero connection...</p>;
  }

  const status = statusQuery.data;

  if (!status?.configured) {
    return (
      <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
        Xero isn't configured yet. Add <code>XERO_CLIENT_ID</code> and{" "}
        <code>XERO_CLIENT_SECRET</code> to your <code>.env</code> file (from your app at{" "}
        <a
          href="https://developer.xero.com/myapps"
          target="_blank"
          rel="noreferrer"
          className="underline"
        >
          developer.xero.com
        </a>
        ), then restart the server.
      </div>
    );
  }

  if (status.connected) {
    return (
      <div className="flex items-center justify-between rounded-lg border border-emerald-200 bg-emerald-50 p-4">
        <div className="flex items-center gap-2 text-emerald-800">
          <CheckCircle2 className="h-5 w-5" />
          <span className="text-sm font-medium">
            Connected to {status.tenantName || "your Xero organisation"}
          </span>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => disconnectMutation.mutate()}
          disabled={disconnectMutation.isPending}
        >
          Disconnect
        </Button>
      </div>
    );
  }

  return (
    <div className="flex items-center justify-between rounded-lg border border-slate-200 bg-slate-50 p-4">
      <div className="flex items-center gap-2 text-slate-600">
        <XCircle className="h-5 w-5" />
        <span className="text-sm">Not connected</span>
      </div>
      <a href="/api/xero/connect">
        <Button size="sm" className="bg-[#0c1e38] hover:bg-[#0c1e38]/90">
          Connect to Xero
        </Button>
      </a>
    </div>
  );
}

function StaffInviteSection() {
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<"admin" | "management" | "office_staff" | "technician">("technician");
  const utils = trpc.useUtils();

  const invitesQuery = trpc.administration.pendingInvites.useQuery();

  const inviteMutation = trpc.administration.inviteStaff.useMutation({
    onSuccess: (result) => {
      if (result.emailSent) {
        toast.success("Invite sent");
      } else {
        toast.warning(result.warning || "Invite saved, but email delivery failed.", {
          description: "Copy the invitation link now, or check Administration → Settings and retry.",
          action: {
            label: "Copy link",
            onClick: () => navigator.clipboard.writeText(result.acceptUrl),
          },
          duration: 12000,
        });
      }
      setEmail("");
      utils.administration.pendingInvites.invalidate();
    },
    onError: (err) => showErrorToast(err),
  });

  return (
    <Card className="border-slate-200 bg-white shadow-sm">
      <div className="p-6">
        <h2 className="mb-1 text-lg font-semibold text-slate-900">Invite Staff</h2>
        <p className="mb-4 text-sm text-slate-600">
          Staff accounts can only be created this way — never self-selected — so access always
          starts from an admin decision.
        </p>
        <div className="flex flex-col gap-3 sm:flex-row">
          <Input
            type="email"
            placeholder="staff@example.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="border-slate-200"
          />
          <Select value={role} onValueChange={(v) => setRole(v as typeof role)}>
            <SelectTrigger className="border-slate-200 sm:w-48">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="technician">Technician</SelectItem>
              <SelectItem value="office_staff">Office Staff</SelectItem>
              <SelectItem value="management">Management</SelectItem>
              <SelectItem value="admin">Administrator</SelectItem>
            </SelectContent>
          </Select>
          <Button
            className="bg-[#0c1e38] hover:bg-[#0c1e38]/90 sm:w-40"
            disabled={!email || inviteMutation.isPending}
            onClick={() => inviteMutation.mutate({ email, role })}
          >
            {inviteMutation.isPending ? "Sending..." : "Send Invite"}
          </Button>
        </div>

        {(invitesQuery.data || []).length > 0 && (
          <div className="mt-6">
            <h3 className="mb-2 text-sm font-medium text-slate-700">Pending Invites</h3>
            <div className="space-y-2">
              {(invitesQuery.data || []).map((inv: any) => (
                <div
                  key={inv.id}
                  className="flex items-center justify-between rounded-lg border border-slate-200 p-3 text-sm"
                >
                  <span className="text-slate-900">{inv.email}</span>
                  <Badge variant="secondary">{inv.role.replace("_", " ")}</Badge>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </Card>
  );
}

function ExistingUsersList() {
  const usersQuery = trpc.administration.users.useQuery();
  const customersQuery = trpc.customers.list.useQuery();
  const users = usersQuery.data || [];
  const utils = trpc.useUtils();
  const meQuery = trpc.auth.me.useQuery();

  const relinkMutation = trpc.administration.relinkCustomer.useMutation({
    onSuccess: () => {
      toast.success("Portal access fixed");
      utils.administration.users.invalidate();
    },
    onError: (err) => showErrorToast(err),
  });

  const roleMutation = trpc.administration.updateUserRole.useMutation({
    onSuccess: () => {
      toast.success("Role updated");
      utils.administration.users.invalidate();
    },
    onError: (err) => showErrorToast(err),
  });

  if (usersQuery.isLoading) return <div className="h-16 animate-pulse rounded bg-slate-100" />;
  if (users.length === 0) return <p className="text-sm text-slate-500">No users yet.</p>;

  const customersById = new Map((customersQuery.data || []).map((c: any) => [c.id, c]));

  return (
    <div className="space-y-2">
      {users.map((u: any) => {
        const linkedCustomer = u.customerId ? customersById.get(u.customerId) : null;
        const isBroken = u.role === "customer" && u.customerId && !linkedCustomer;

        return (
          <div key={u.id} className="rounded-lg border border-slate-200 p-3">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium text-slate-900">{u.name}</p>
                <p className="text-xs text-slate-500">{u.email}</p>
              </div>
              {u.role === "customer" ? (
                <Badge variant="secondary">customer</Badge>
              ) : (
                <Select
                  value={u.role}
                  onValueChange={(v) => roleMutation.mutate({ userId: u.id, newRole: v as any })}
                  disabled={roleMutation.isPending}
                >
                  <SelectTrigger className="h-8 w-36 border-slate-200 text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="admin">Admin</SelectItem>
                    <SelectItem value="management">Management</SelectItem>
                    <SelectItem value="office_staff">Office Staff</SelectItem>
                    <SelectItem value="technician">Technician</SelectItem>
                  </SelectContent>
                </Select>
              )}
            </div>

            {u.role === "customer" && (
              <div className="mt-2 flex items-center gap-2">
                {isBroken ? (
                  <p className="text-xs font-medium text-red-600">
                    Portal access broken — linked to a customer record that no longer exists
                  </p>
                ) : linkedCustomer ? (
                  <p className="text-xs text-emerald-600">Linked to: {linkedCustomer.name}</p>
                ) : (
                  <p className="text-xs text-amber-600">Not linked to any customer record</p>
                )}
                {(isBroken || !linkedCustomer) && (
                  <Select
                    onValueChange={(v) => relinkMutation.mutate({ userId: u.id, customerId: parseInt(v) })}
                  >
                    <SelectTrigger className="h-7 w-48 border-slate-200 text-xs">
                      <SelectValue placeholder="Fix — pick correct customer" />
                    </SelectTrigger>
                    <SelectContent>
                      {(customersQuery.data || []).map((c: any) => (
                        <SelectItem key={c.id} value={c.id.toString()}>
                          {c.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function EmergencyContactSettingCard() {
  const utils = trpc.useUtils();
  const settingsQuery = trpc.administration.settings.useQuery();
  const [phone, setPhone] = useState("");

  useEffect(() => {
    if (settingsQuery.data) {
      const s = settingsQuery.data.find((x: any) => x.key === "emergency_contact_phone");
      setPhone(s?.value || "");
    }
  }, [settingsQuery.data]);

  const updateMutation = trpc.administration.updateSetting.useMutation({
    onSuccess: () => {
      toast.success("Emergency contact saved");
      utils.administration.settings.invalidate();
    },
    onError: (err) => showErrorToast(err),
  });

  return (
    <Card className="mb-6 border-slate-200 bg-white shadow-sm">
      <div className="p-6">
        <h2 className="mb-1 text-lg font-semibold text-slate-900">Emergency Contact</h2>
        <p className="mb-4 text-sm text-slate-600">
          Shown as a one-tap call button on every technician's phone (Technician Home and the QR
          job view) — for a genuine on-site emergency, not general enquiries.
        </p>
        <div className="flex items-end gap-3">
          <div className="flex-1">
            <label className="block text-sm font-medium text-slate-900">Phone Number</label>
            <Input
              type="tel"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              placeholder="e.g. 0400 000 000"
              className="mt-1 border-slate-200"
            />
          </div>
          <Button
            className="bg-[#0c1e38] hover:bg-[#0c1e38]/90"
            onClick={() =>
              updateMutation.mutate({
                key: "emergency_contact_phone",
                value: phone.trim(),
                description: "One-tap emergency call number shown to technicians on-site",
              })
            }
            disabled={updateMutation.isPending}
          >
            {updateMutation.isPending ? "Saving..." : "Save"}
          </Button>
        </div>
      </div>
    </Card>
  );
}

function SystemSettingsCard() {
  const utils = trpc.useUtils();
  const settingsQuery = trpc.administration.settings.useQuery();
  const [quoteExpiryDays, setQuoteExpiryDays] = useState("5");
  const [depositPercentage, setDepositPercentage] = useState("30");
  const [companyName, setCompanyName] = useState("Boatology");
  const [companyEmail, setCompanyEmail] = useState("");

  useEffect(() => {
    if (settingsQuery.data) {
      const get = (key: string) => settingsQuery.data!.find((x: any) => x.key === key)?.value;
      setQuoteExpiryDays(get("quote_expiry_days") || "5");
      setDepositPercentage(get("deposit_percentage") || "30");
      setCompanyName(get("company_name") || "Boatology");
      setCompanyEmail(get("company_email") || "");
    }
  }, [settingsQuery.data]);

  const updateMutation = trpc.administration.updateSetting.useMutation({
    onError: (err) => showErrorToast(err),
  });

  const handleSave = async () => {
    try {
      await Promise.all([
        updateMutation.mutateAsync({
          key: "quote_expiry_days",
          value: quoteExpiryDays,
          description: "Days before a new quote's expiry date, used when a quote is created",
        }),
        updateMutation.mutateAsync({
          key: "deposit_percentage",
          value: depositPercentage,
          description: "Percentage of the quote total charged as a deposit before a job can be created",
        }),
        updateMutation.mutateAsync({ key: "company_name", value: companyName }),
        updateMutation.mutateAsync({ key: "company_email", value: companyEmail }),
      ]);
      toast.success("Settings saved");
      utils.administration.settings.invalidate();
    } catch {
      // individual mutation errors already surfaced via onError above
    }
  };

  return (
    <Card className="border-slate-200 bg-white shadow-sm">
      <div className="p-6">
        <h2 className="text-lg font-semibold text-slate-900 mb-4">System Settings</h2>
        <div className="space-y-6">
          <div>
            <label className="block text-sm font-medium text-slate-900">Quote Expiry (Days)</label>
            <Input
              type="number"
              value={quoteExpiryDays}
              onChange={(e) => setQuoteExpiryDays(e.target.value)}
              className="mt-1 border-slate-200"
            />
            <p className="mt-1 text-sm text-slate-600">
              Applied automatically to every new quote's expiry date, and to the "quote expiring soon"
              reminder in the Daily Agenda.
            </p>
          </div>

          <div>
            <label className="block text-sm font-medium text-slate-900">Deposit Percentage</label>
            <Input
              type="number"
              value={depositPercentage}
              onChange={(e) => setDepositPercentage(e.target.value)}
              className="mt-1 border-slate-200"
            />
            <p className="mt-1 text-sm text-slate-600">
              This is the actual percentage charged as a deposit the moment a quote is accepted — not
              just a label, it directly controls the deposit invoice amount.
            </p>
          </div>

          <div>
            <label className="block text-sm font-medium text-slate-900">Company Name</label>
            <Input value={companyName} onChange={(e) => setCompanyName(e.target.value)} className="mt-1 border-slate-200" />
          </div>

          <div>
            <label className="block text-sm font-medium text-slate-900">Company Email</label>
            <Input
              type="email"
              value={companyEmail}
              onChange={(e) => setCompanyEmail(e.target.value)}
              className="mt-1 border-slate-200"
            />
          </div>

          <Button className="bg-[#0c1e38] hover:bg-[#0c1e38]/90" onClick={handleSave} disabled={updateMutation.isPending}>
            {updateMutation.isPending ? "Saving..." : "Save Settings"}
          </Button>
        </div>
      </div>
    </Card>
  );
}

function ServicesTabContent({
  newService,
  setNewService,
}: {
  newService: { name: string; description: string; defaultPrice: string };
  setNewService: (v: { name: string; description: string; defaultPrice: string }) => void;
}) {
  const utils = trpc.useUtils();
  const servicesQuery = trpc.administration.services.useQuery();
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editForm, setEditForm] = useState({ name: "", description: "", defaultPrice: "" });
  const [deleteTarget, setDeleteTarget] = useState<any>(null);

  const createMutation = trpc.administration.createService.useMutation({
    onSuccess: () => {
      toast.success("Service added");
      utils.administration.services.invalidate();
      setNewService({ name: "", description: "", defaultPrice: "" });
    },
    onError: (err) => showErrorToast(err),
  });

  const updateMutation = trpc.administration.updateService.useMutation({
    onSuccess: () => {
      toast.success("Service updated");
      utils.administration.services.invalidate();
      setEditingId(null);
    },
    onError: (err) => showErrorToast(err),
  });

  const deleteMutation = trpc.administration.deleteService.useMutation({
    onSuccess: () => {
      toast.success("Service removed");
      utils.administration.services.invalidate();
      setDeleteTarget(null);
    },
    onError: (err) => {
      showErrorToast(err);
      setDeleteTarget(null);
    },
  });

  const startEdit = (service: any) => {
    setEditingId(service.id);
    setEditForm({
      name: service.name || "",
      description: service.description || "",
      defaultPrice: service.defaultPrice?.toString() || "",
    });
  };

  const services = servicesQuery.data || [];

  return (
    <>
      <Card className="border-slate-200 bg-white shadow-sm">
        <div className="p-6">
          <h2 className="text-lg font-semibold text-slate-900 mb-4">Add Service</h2>
          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-slate-900">Service Name</label>
              <Input
                value={newService.name}
                onChange={(e) => setNewService({ ...newService, name: e.target.value })}
                placeholder="e.g., Engine Repair"
                className="mt-1 border-slate-200"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-900">Default Price</label>
              <Input
                type="number"
                step="0.01"
                value={newService.defaultPrice}
                onChange={(e) => setNewService({ ...newService, defaultPrice: e.target.value })}
                placeholder="Optional — shown as a suggestion on quotes"
                className="mt-1 border-slate-200"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-900">Description</label>
              <Textarea
                value={newService.description}
                onChange={(e) => setNewService({ ...newService, description: e.target.value })}
                placeholder="Service description..."
                className="mt-1 border-slate-200"
                rows={3}
              />
            </div>
            <Button
              className="bg-[#0c1e38] hover:bg-[#0c1e38]/90"
              disabled={!newService.name.trim() || createMutation.isPending}
              onClick={() =>
                createMutation.mutate({
                  name: newService.name.trim(),
                  description: newService.description || undefined,
                  defaultPrice: newService.defaultPrice ? parseFloat(newService.defaultPrice) : undefined,
                })
              }
            >
              {createMutation.isPending ? "Adding..." : "Add Service"}
            </Button>
          </div>
        </div>
      </Card>

      <Card className="border-slate-200 bg-white shadow-sm">
        <div className="p-6">
          <h2 className="text-lg font-semibold text-slate-900 mb-4">Service Catalog</h2>
          {servicesQuery.isLoading ? (
            <div className="h-16 animate-pulse rounded bg-slate-100" />
          ) : services.length === 0 ? (
            <p className="text-sm text-slate-500">No services added yet.</p>
          ) : (
            <div className="space-y-3">
              {services.map((service: any) =>
                editingId === service.id ? (
                  <div key={service.id} className="rounded-lg border border-slate-200 p-3 space-y-2">
                    <Input
                      value={editForm.name}
                      onChange={(e) => setEditForm({ ...editForm, name: e.target.value })}
                      className="h-9 border-slate-200"
                      placeholder="Service name"
                    />
                    <Input
                      type="number"
                      step="0.01"
                      value={editForm.defaultPrice}
                      onChange={(e) => setEditForm({ ...editForm, defaultPrice: e.target.value })}
                      className="h-9 border-slate-200"
                      placeholder="Default price"
                    />
                    <Textarea
                      value={editForm.description}
                      onChange={(e) => setEditForm({ ...editForm, description: e.target.value })}
                      rows={2}
                      className="border-slate-200"
                      placeholder="Description"
                    />
                    <div className="flex gap-2">
                      <Button
                        size="sm"
                        className="bg-[#0c1e38] hover:bg-[#0c1e38]/90"
                        disabled={updateMutation.isPending}
                        onClick={() =>
                          updateMutation.mutate({
                            id: service.id,
                            name: editForm.name.trim(),
                            description: editForm.description || undefined,
                            defaultPrice: editForm.defaultPrice ? parseFloat(editForm.defaultPrice) : undefined,
                          })
                        }
                      >
                        Save
                      </Button>
                      <Button size="sm" variant="outline" onClick={() => setEditingId(null)}>
                        Cancel
                      </Button>
                    </div>
                  </div>
                ) : (
                  <div key={service.id} className="flex items-center justify-between rounded-lg border border-slate-200 p-3">
                    <div>
                      <p className="font-medium text-slate-900">{service.name}</p>
                      {service.description && <p className="text-sm text-slate-500">{service.description}</p>}
                      {service.defaultPrice != null && (
                        <Badge className="mt-1 bg-slate-100 text-slate-700 border-0">${service.defaultPrice.toFixed(2)}</Badge>
                      )}
                    </div>
                    <div className="flex gap-2">
                      <Button variant="outline" size="sm" onClick={() => startEdit(service)}>
                        Edit
                      </Button>
                      <Button variant="outline" size="sm" className="text-red-600 hover:bg-red-50" onClick={() => setDeleteTarget(service)}>
                        Delete
                      </Button>
                    </div>
                  </div>
                )
              )}
            </div>
          )}
        </div>
      </Card>

      <DeleteConfirmDialog
        open={!!deleteTarget}
        onOpenChange={(open) => !open && setDeleteTarget(null)}
        title={`Delete "${deleteTarget?.name}"?`}
        description="This removes it from the service catalog used when building quotes. This can't be undone."
        onConfirm={() => deleteTarget && deleteMutation.mutate({ id: deleteTarget.id })}
        isPending={deleteMutation.isPending}
      />
    </>
  );
}

const auditActionLabels: Record<string, string> = {
  login: "Logged in",
  delete: "Deleted",
  mark_paid_manually: "Marked invoice paid",
  invite_staff: "Invited staff member",
  update_setting: "Changed a setting",
  password_reset: "Reset password",
};

const auditActionColors: Record<string, { bg: string; text: string }> = {
  login: { bg: "bg-slate-100", text: "text-slate-600" },
  delete: { bg: "bg-red-100", text: "text-red-700" },
  mark_paid_manually: { bg: "bg-emerald-100", text: "text-emerald-700" },
  invite_staff: { bg: "bg-blue-100", text: "text-blue-700" },
  update_setting: { bg: "bg-amber-100", text: "text-amber-700" },
  password_reset: { bg: "bg-purple-100", text: "text-purple-700" },
};

function AuditLogTabContent() {
  const auditQuery = trpc.administration.auditLog.useQuery();
  const usersQuery = trpc.administration.users.useQuery();
  const usersById = new Map((usersQuery.data || []).map((u: any) => [u.id, u]));

  const entries = auditQuery.data || [];

  return (
    <Card className="border-slate-200 bg-white shadow-sm">
      <div className="border-b border-slate-200 p-6">
        <h2 className="text-lg font-semibold text-slate-900">Audit Log</h2>
        <p className="mt-1 text-sm text-slate-600">
          A record of logins, deletions, payments, staff invites, and configuration changes — the
          most recent 200 events.
        </p>
      </div>

      {auditQuery.isLoading ? (
        <div className="p-6">
          <div className="h-32 animate-pulse rounded bg-slate-100" />
        </div>
      ) : entries.length === 0 ? (
        <p className="p-6 text-center text-sm text-slate-500">No events recorded yet.</p>
      ) : (
        <div className="divide-y divide-slate-100">
          {entries.map((entry: any) => {
            const user = usersById.get(entry.userId);
            let changesText = "";
            if (entry.changes) {
              try {
                const parsed = typeof entry.changes === "string" ? JSON.parse(entry.changes) : entry.changes;
                changesText = Object.entries(parsed)
                  .map(([k, v]) => `${k}: ${v}`)
                  .join(", ");
              } catch {
                changesText = String(entry.changes);
              }
            }
            return (
              <div key={entry.id} className="flex items-start justify-between gap-4 px-6 py-3">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <Badge className={`${auditActionColors[entry.action]?.bg || "bg-slate-100"} ${auditActionColors[entry.action]?.text || "text-slate-600"} border-0 text-xs`}>
                      {auditActionLabels[entry.action] || entry.action}
                    </Badge>
                    <span className="text-sm text-slate-900">
                      {entry.entityType}
                      {entry.entityId ? ` #${entry.entityId}` : ""}
                    </span>
                  </div>
                  <p className="mt-1 text-xs text-slate-500">
                    {user?.name || "Unknown user"} ({user?.email || `user #${entry.userId}`})
                    {changesText && ` — ${changesText}`}
                  </p>
                </div>
                <span className="shrink-0 text-xs text-slate-400">{new Date(entry.createdAt).toLocaleString("en-AU")}</span>
              </div>
            );
          })}
        </div>
      )}
    </Card>
  );
}


function SystemErrorsTabContent() {
  const [includeResolved, setIncludeResolved] = useState(false);
  const utils = trpc.useUtils();
  const errorsQuery = trpc.administration.systemErrors.useQuery({ includeResolved });
  const resolveMutation = trpc.administration.resolveSystemError.useMutation({
    onSuccess: () => {
      toast.success("Error marked resolved");
      utils.administration.systemErrors.invalidate();
    },
    onError: (err) => showErrorToast(err),
  });

  const entries = errorsQuery.data || [];

  return (
    <Card className="border-slate-200 bg-white shadow-sm">
      <div className="flex flex-col gap-3 border-b border-slate-200 p-6 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <div className="flex items-center gap-2">
            <AlertTriangle className="h-5 w-5 text-amber-600" />
            <h2 className="text-lg font-semibold text-slate-900">System Errors</h2>
          </div>
          <p className="mt-1 text-sm text-slate-600">
            Unexpected browser and server failures are grouped here. Resolve an item after the cause has been checked.
          </p>
        </div>
        <label className="flex items-center gap-2 text-sm text-slate-600">
          <input
            type="checkbox"
            checked={includeResolved}
            onChange={(event) => setIncludeResolved(event.target.checked)}
            className="h-4 w-4 rounded border-slate-300"
          />
          Show resolved
        </label>
      </div>

      {errorsQuery.isLoading ? (
        <div className="p-6"><div className="h-32 animate-pulse rounded bg-slate-100" /></div>
      ) : errorsQuery.isError ? (
        <div className="p-6 text-sm text-red-700">
          Error reports could not be loaded. Refresh Administration and try again.
        </div>
      ) : entries.length === 0 ? (
        <div className="p-8 text-center">
          <Check className="mx-auto h-8 w-8 text-emerald-600" />
          <p className="mt-2 text-sm font-medium text-slate-900">No unresolved system errors</p>
          <p className="mt-1 text-xs text-slate-500">New unexpected failures will appear here automatically.</p>
        </div>
      ) : (
        <div className="divide-y divide-slate-100">
          {entries.map((entry: any) => (
            <div key={entry.id} className="p-5">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge className={entry.severity === "fatal" ? "border-0 bg-red-100 text-red-700" : "border-0 bg-amber-100 text-amber-800"}>
                      {entry.severity}
                    </Badge>
                    <Badge variant="secondary">{entry.source}</Badge>
                    <span className="text-xs text-slate-500">{entry.occurrenceCount} occurrence{entry.occurrenceCount === 1 ? "" : "s"}</span>
                    {entry.resolvedAt && <Badge className="border-0 bg-emerald-100 text-emerald-700">resolved</Badge>}
                  </div>
                  <p className="mt-2 break-words text-sm font-medium text-slate-900">{entry.message}</p>
                  <div className="mt-2 space-y-1 text-xs text-slate-500">
                    {entry.route && <p>Location: {entry.route}</p>}
                    <p>First seen: {new Date(entry.firstSeenAt).toLocaleString("en-AU")}</p>
                    <p>Last seen: {new Date(entry.lastSeenAt).toLocaleString("en-AU")}</p>
                  </div>
                  {entry.stack && (
                    <details className="mt-3">
                      <summary className="cursor-pointer text-xs font-medium text-slate-600">Technical details</summary>
                      <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap rounded bg-slate-950 p-3 text-[11px] text-slate-100">
                        {entry.stack}
                      </pre>
                    </details>
                  )}
                </div>
                {!entry.resolvedAt && (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={resolveMutation.isPending}
                    onClick={() => resolveMutation.mutate({ id: entry.id })}
                  >
                    Mark resolved
                  </Button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}
