import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { trpc } from "@/lib/trpc";
import { ArrowLeft, Save } from "lucide-react";
import { useEffect, useState } from "react";
import { useLocation, useRoute } from "wouter";

export default function VesselDetail() {
  const [, params] = useRoute("/vessels/:id");
  const [, setLocation] = useLocation();
  const vesselId = params?.id ? parseInt(params.id) : null;

  const [isEditing, setIsEditing] = useState(false);
  const [formData, setFormData] = useState({
    boatName: "",
    make: "",
    model: "",
    registration: "",
    location: "",
    latitude: "",
    longitude: "",
    insuranceDetails: "",
    insuranceExpiryDate: "",
    notes: "",
  });

  const vesselQuery = trpc.vessels.getById.useQuery(vesselId || 0, {
    enabled: !!vesselId,
  });

  const updateMutation = trpc.vessels.update.useMutation();

  useEffect(() => {
    if (vesselQuery.data) {
      setFormData({
        boatName: (vesselQuery.data as any)?.boatName || "",
        make: (vesselQuery.data as any)?.make || "",
        model: (vesselQuery.data as any)?.model || "",
        registration: (vesselQuery.data as any)?.registration || "",
        location: (vesselQuery.data as any)?.location || "",
        latitude: (vesselQuery.data as any)?.latitude?.toString() || "",
        longitude: (vesselQuery.data as any)?.longitude?.toString() || "",
        insuranceDetails: (vesselQuery.data as any)?.insuranceDetails || "",
        insuranceExpiryDate: (vesselQuery.data as any)?.insuranceExpiryDate || "",
        notes: (vesselQuery.data as any)?.notes || "",
      });
    }
  }, [vesselQuery.data]);

  const handleSave = async () => {
    if (!vesselId) return;
    try {
      await updateMutation.mutateAsync({
        id: vesselId,
        ...formData,
        latitude: formData.latitude ? parseFloat(formData.latitude) : undefined,
        longitude: formData.longitude ? parseFloat(formData.longitude) : undefined,
      });
      setIsEditing(false);
    } catch (error) {
      console.error("Error updating vessel:", error);
    }
  };

  if (!vesselId) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-slate-50 via-white to-slate-50 p-6">
        <div className="text-center">
          <p className="text-slate-600">Vessel not found</p>
        </div>
      </div>
    );
  }

  if (vesselQuery.isLoading) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-slate-50 via-white to-slate-50 p-6">
        <div className="mx-auto max-w-2xl">
          <div className="animate-pulse space-y-4">
            <div className="h-10 w-32 rounded bg-slate-200"></div>
            <div className="h-64 rounded bg-slate-200"></div>
          </div>
        </div>
      </div>
    );
  }

  const vessel = vesselQuery.data;

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 via-white to-slate-50">
      {/* Header */}
      <div className="border-b border-slate-200 bg-white shadow-sm">
        <div className="mx-auto max-w-2xl px-6 py-6">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-4">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setLocation("/vessels")}
              >
                <ArrowLeft className="h-4 w-4" />
              </Button>
              <div>
                <h1 className="text-2xl font-semibold text-slate-900">
                  {(vessel as any)?.boatName || `Vessel #${(vessel as any)?.id}`}
                </h1>
                <p className="mt-1 text-sm text-slate-600">Vessel Details</p>
              </div>
            </div>
            {!isEditing ? (
              <Button
                className="bg-[#0c1e38] hover:bg-[#0c1e38]/90"
                onClick={() => setIsEditing(true)}
              >
                Edit
              </Button>
            ) : (
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  onClick={() => setIsEditing(false)}
                >
                  Cancel
                </Button>
                <Button
                  className="bg-[#0c1e38] hover:bg-[#0c1e38]/90"
                  onClick={handleSave}
                  disabled={updateMutation.isPending}
                >
                  <Save className="mr-2 h-4 w-4" />
                  Save
                </Button>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Main Content */}
      <div className="mx-auto max-w-2xl px-6 py-8">
        <Card className="border-slate-200 bg-white shadow-sm">
          <div className="p-6">
            {isEditing ? (
              <div className="space-y-6">
                <div>
                  <label className="block text-sm font-medium text-slate-900">
                    Boat Name
                  </label>
                  <Input
                    value={formData.boatName}
                    onChange={(e) =>
                      setFormData({ ...formData, boatName: e.target.value })
                    }
                    className="mt-1 border-slate-200"
                  />
                </div>

                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm font-medium text-slate-900">
                      Make
                    </label>
                    <Input
                      value={formData.make}
                      onChange={(e) =>
                        setFormData({ ...formData, make: e.target.value })
                      }
                      className="mt-1 border-slate-200"
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-slate-900">
                      Model
                    </label>
                    <Input
                      value={formData.model}
                      onChange={(e) =>
                        setFormData({ ...formData, model: e.target.value })
                      }
                      className="mt-1 border-slate-200"
                    />
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm font-medium text-slate-900">
                      Registration
                    </label>
                    <Input
                      value={formData.registration}
                      onChange={(e) =>
                        setFormData({
                          ...formData,
                          registration: e.target.value,
                        })
                      }
                      className="mt-1 border-slate-200"
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-slate-900">
                      Location
                    </label>
                    <Input
                      value={formData.location}
                      onChange={(e) =>
                        setFormData({ ...formData, location: e.target.value })
                      }
                      className="mt-1 border-slate-200"
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-slate-900">
                      Latitude (for the Job Map)
                    </label>
                    <Input
                      type="number"
                      step="0.000001"
                      value={formData.latitude}
                      onChange={(e) => setFormData({ ...formData, latitude: e.target.value })}
                      placeholder="e.g. -33.8688"
                      className="mt-1 border-slate-200"
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-slate-900">
                      Longitude (for the Job Map)
                    </label>
                    <Input
                      type="number"
                      step="0.000001"
                      value={formData.longitude}
                      onChange={(e) => setFormData({ ...formData, longitude: e.target.value })}
                      placeholder="e.g. 151.2093"
                      className="mt-1 border-slate-200"
                    />
                  </div>
                </div>

                <div>
                  <label className="block text-sm font-medium text-slate-900">
                    Insurance Details
                  </label>
                  <Textarea
                    value={formData.insuranceDetails}
                    onChange={(e) =>
                      setFormData({
                        ...formData,
                        insuranceDetails: e.target.value,
                      })
                    }
                    className="mt-1 border-slate-200"
                    rows={3}
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium text-slate-900">
                    Insurance Expiry Date
                  </label>
                  <Input
                    type="date"
                    value={formData.insuranceExpiryDate}
                    onChange={(e) => setFormData({ ...formData, insuranceExpiryDate: e.target.value })}
                    className="mt-1 border-slate-200"
                  />
                  <p className="mt-1 text-sm text-slate-600">
                    Optional — set this to get a Today's Agenda reminder 30 days before it lapses.
                  </p>
                </div>

                <div>
                  <label className="block text-sm font-medium text-slate-900">
                    Notes
                  </label>
                  <Textarea
                    value={formData.notes}
                    onChange={(e) =>
                      setFormData({ ...formData, notes: e.target.value })
                    }
                    className="mt-1 border-slate-200"
                    rows={3}
                  />
                </div>
              </div>
            ) : (
              <div className="space-y-6">
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <h3 className="font-medium text-slate-900">Make</h3>
                    <p className="mt-1 text-slate-600">
                      {(vessel as any)?.make || "—"}
                    </p>
                  </div>
                  <div>
                    <h3 className="font-medium text-slate-900">Model</h3>
                    <p className="mt-1 text-slate-600">
                      {(vessel as any)?.model || "—"}
                    </p>
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <h3 className="font-medium text-slate-900">Registration</h3>
                    <p className="mt-1 text-slate-600">
                      {(vessel as any)?.registration || "—"}
                    </p>
                  </div>
                  <div>
                    <h3 className="font-medium text-slate-900">Location</h3>
                    <p className="mt-1 text-slate-600">
                      {(vessel as any)?.location || "—"}
                    </p>
                  </div>
                </div>

                {(vessel as any)?.insuranceDetails && (
                  <div>
                    <h3 className="font-medium text-slate-900">
                      Insurance Details
                    </h3>
                    <p className="mt-1 text-slate-600 whitespace-pre-wrap">
                      {(vessel as any).insuranceDetails}
                    </p>
                  </div>
                )}

                {(vessel as any)?.insuranceExpiryDate && (
                  <div>
                    <h3 className="font-medium text-slate-900">
                      Insurance Expiry Date
                    </h3>
                    <p className="mt-1 text-slate-600">
                      {new Date((vessel as any).insuranceExpiryDate).toLocaleDateString("en-AU", {
                        day: "numeric",
                        month: "short",
                        year: "numeric",
                      })}
                    </p>
                  </div>
                )}

                {(vessel as any)?.notes && (
                  <div>
                    <h3 className="font-medium text-slate-900">Notes</h3>
                    <p className="mt-1 text-slate-600 whitespace-pre-wrap">
                      {(vessel as any).notes}
                    </p>
                  </div>
                )}
              </div>
            )}
          </div>
        </Card>
      </div>
    </div>
  );
}
