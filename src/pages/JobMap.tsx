import { useState } from "react";
import { MapContainer, TileLayer, Marker, Popup, useMap } from "react-leaflet";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { trpc } from "@/lib/trpc";
import { Phone, MessageSquare, Navigation, Search, MapPinOff } from "lucide-react";
import { useLocation } from "wouter";

// Leaflet's default marker icons don't resolve correctly through bundlers —
// rebuild them from the package's own bundled assets instead of a CDN.
import markerIcon2x from "leaflet/dist/images/marker-icon-2x.png";
import markerIcon from "leaflet/dist/images/marker-icon.png";
import markerShadow from "leaflet/dist/images/marker-shadow.png";

delete (L.Icon.Default.prototype as any)._getIconUrl;
L.Icon.Default.mergeOptions({
  iconRetinaUrl: markerIcon2x,
  iconUrl: markerIcon,
  shadowUrl: markerShadow,
});

const priorityColors: Record<string, { bg: string; text: string }> = {
  low: { bg: "bg-slate-100", text: "text-slate-600" },
  medium: { bg: "bg-blue-100", text: "text-blue-700" },
  high: { bg: "bg-orange-100", text: "text-orange-700" },
  urgent: { bg: "bg-red-100", text: "text-red-700" },
};

const statusColors: Record<string, { bg: string; text: string }> = {
  inspection: { bg: "bg-slate-100", text: "text-slate-700" },
  quote: { bg: "bg-blue-100", text: "text-blue-700" },
  approval: { bg: "bg-yellow-100", text: "text-yellow-700" },
  deposit: { bg: "bg-purple-100", text: "text-purple-700" },
  created: { bg: "bg-indigo-100", text: "text-indigo-700" },
  scheduled: { bg: "bg-cyan-100", text: "text-cyan-700" },
  in_progress: { bg: "bg-orange-100", text: "text-orange-700" },
  waiting_customer: { bg: "bg-yellow-100", text: "text-yellow-700" },
  waiting_parts: { bg: "bg-yellow-100", text: "text-yellow-700" },
};

// A small helper rendered inside <MapContainer> so it can use react-leaflet's
// useMap() hook — clicking a job card pans/zooms the map to that job.
function MapFlyTo({ position }: { position: [number, number] | null }) {
  const map = useMap();
  if (position) {
    map.flyTo(position, Math.max(map.getZoom(), 13), { duration: 0.6 });
  }
  return null;
}

export default function JobMap() {
  const [, navigate] = useLocation();
  const mapQuery = trpc.jobMap.activeJobs.useQuery();
  const [search, setSearch] = useState("");
  const [selectedJobId, setSelectedJobId] = useState<number | null>(null);

  const allJobs = mapQuery.data || [];
  const filteredJobs = allJobs.filter(
    (j: any) =>
      j.jobNumber?.toLowerCase().includes(search.toLowerCase()) ||
      j.customerName?.toLowerCase().includes(search.toLowerCase()) ||
      j.vesselName?.toLowerCase().includes(search.toLowerCase())
  );
  const hasCoordinates = (job: { latitude: number | null; longitude: number | null }):
    job is typeof job & { latitude: number; longitude: number } =>
    typeof job.latitude === "number" && typeof job.longitude === "number";
  const pinnedJobs = allJobs.filter(hasCoordinates);
  const selectedJob = allJobs.find((j: any) => j.jobId === selectedJobId);
  const flyToPosition: [number, number] | null =
    selectedJob && hasCoordinates(selectedJob) ? [selectedJob.latitude, selectedJob.longitude] : null;

  const firstPinnedJob = pinnedJobs[0];
  const center: [number, number] =
    firstPinnedJob &&
    typeof firstPinnedJob.latitude === "number" &&
    typeof firstPinnedJob.longitude === "number"
      ? [firstPinnedJob.latitude, firstPinnedJob.longitude]
      : [-33.8688, 151.2093];

  return (
    <div className="flex h-[calc(100vh-4rem)] flex-col bg-slate-50">
      <div className="border-b border-slate-200 bg-white px-6 py-4 shadow-sm">
        <h1 className="text-xl font-semibold text-slate-900">Job Map</h1>
        <p className="text-xs text-slate-500">
          Active jobs by marina location — a vessel needs its latitude/longitude set on the Vessel page to get a pin
        </p>
      </div>

      <div className="flex flex-1 overflow-hidden">
        {/* Job list panel */}
        <div className="flex w-80 shrink-0 flex-col border-r border-slate-200 bg-white">
          <div className="border-b border-slate-100 p-3">
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search jobs..."
                className="h-8 border-slate-200 pl-8 text-sm"
              />
            </div>
          </div>

          <div className="flex-1 overflow-y-auto p-2">
            {mapQuery.isLoading ? (
              <div className="h-24 animate-pulse rounded bg-slate-100" />
            ) : filteredJobs.length === 0 ? (
              <p className="p-3 text-center text-xs text-slate-400">No active jobs found.</p>
            ) : (
              <div className="space-y-2">
                {filteredJobs.map((j: any) => (
                  <button
                    key={j.jobId}
                    onClick={() => navigate(`/jobs/${j.jobId}`)}
                    className="w-full rounded-lg border border-slate-200 p-2.5 text-left transition-colors hover:border-[#2d4160] hover:bg-blue-50"
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="truncate text-sm font-semibold text-[#2d4160]">{j.jobNumber}</p>
                        <p className="truncate text-xs text-slate-600">{j.customerName}</p>
                      </div>
                      {!j.hasCoordinates && (
                        <span title="No location set">
                          <MapPinOff className="h-3.5 w-3.5 shrink-0 text-slate-300" />
                        </span>
                      )}
                    </div>
                    {j.vesselName && <p className="mt-1 truncate text-xs text-slate-500">{j.vesselName}</p>}
                    <div className="mt-1.5 flex flex-wrap gap-1">
                      <Badge className={`${priorityColors[j.priority]?.bg} ${priorityColors[j.priority]?.text} border-0 text-[10px]`}>
                        {j.priority}
                      </Badge>
                      {j.technicians.length === 0 ? (
                        <Badge className="border-0 bg-red-100 text-[10px] text-red-700">Unassigned</Badge>
                      ) : (
                        <Badge className="border-0 bg-emerald-100 text-[10px] text-emerald-700">
                          {j.technicians.map((t: any) => t.name).join(", ")}
                        </Badge>
                      )}
                    </div>
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Map */}
        <div className="relative flex-1">
          <MapContainer center={center} zoom={11} style={{ height: "100%", width: "100%" }}>
            <TileLayer
              attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
              url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
            />
            <MapFlyTo position={flyToPosition} />
            {pinnedJobs.map((m: any) => (
              <Marker key={m.jobId} position={[m.latitude, m.longitude]} eventHandlers={{ click: () => setSelectedJobId(m.jobId) }}>
                <Popup minWidth={260}>
                  <div className="space-y-2">
                    <div>
                      <p className="font-semibold text-slate-900">{m.jobNumber}</p>
                      <p className="text-xs text-slate-500">{m.vesselName}</p>
                    </div>
                    <div className="flex flex-wrap gap-1.5">
                      <Badge className={`${priorityColors[m.priority]?.bg} ${priorityColors[m.priority]?.text} border-0 text-xs`}>
                        {m.priority}
                      </Badge>
                      <Badge className={`${statusColors[m.status]?.bg || "bg-slate-100"} ${statusColors[m.status]?.text || "text-slate-700"} border-0 text-xs`}>
                        {m.status?.replace(/_/g, " ")}
                      </Badge>
                    </div>
                    <div className="text-xs text-slate-600">
                      <p>{m.customerName}</p>
                      {m.marina && <p className="text-slate-400">{m.marina}</p>}
                      {m.technicians.length > 0 && (
                        <p className="mt-1">Tech: {m.technicians.map((t: any) => t.name).join(", ")}</p>
                      )}
                    </div>
                    <div className="flex flex-wrap gap-1.5 pt-1">
                      <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => navigate(`/jobs/${m.jobId}`)}>
                        Open Job
                      </Button>
                      <a
                        href={`https://www.google.com/maps/dir/?api=1&destination=${m.latitude},${m.longitude}`}
                        target="_blank"
                        rel="noreferrer"
                      >
                        <Button size="sm" variant="outline" className="h-7 text-xs">
                          <Navigation className="mr-1 h-3 w-3" />
                          Navigate
                        </Button>
                      </a>
                      {m.customerPhone && (
                        <>
                          <a href={`tel:${m.customerPhone}`}>
                            <Button size="sm" variant="outline" className="h-7 w-7 p-0">
                              <Phone className="h-3 w-3" />
                            </Button>
                          </a>
                          <a href={`sms:${m.customerPhone}`}>
                            <Button size="sm" variant="outline" className="h-7 w-7 p-0">
                              <MessageSquare className="h-3 w-3" />
                            </Button>
                          </a>
                        </>
                      )}
                    </div>
                  </div>
                </Popup>
              </Marker>
            ))}
          </MapContainer>
        </div>
      </div>
    </div>
  );
}
