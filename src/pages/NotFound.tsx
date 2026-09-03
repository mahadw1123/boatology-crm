import { Link } from "wouter";
import { Compass } from "lucide-react";

export default function NotFound() {
  return (
    <div className="flex min-h-[70vh] flex-col items-center justify-center gap-4 text-center">
      <Compass className="h-10 w-10 text-ocean" />
      <h1 className="text-2xl font-semibold text-navy">Off the charts</h1>
      <p className="max-w-sm text-sm text-ink-light">
        We couldn't find the page you're looking for. It may have moved or never existed.
      </p>
      <Link
        href="/"
        className="rounded-lg bg-navy px-4 py-2 text-sm font-medium text-white hover:bg-navy-700"
      >
        Back to Dashboard
      </Link>
    </div>
  );
}
