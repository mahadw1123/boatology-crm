import emblemUrl from "@/assets/brand/emblem.svg";
import logoUrl from "@/assets/brand/logo.svg";
import wordmarkUrl from "@/assets/brand/wordmark.svg";

const SOURCES = {
  emblem: emblemUrl,
  logo: logoUrl,
  wordmark: wordmarkUrl,
} as const;

/**
 * The real Boatology logo, in any of its three official forms. The source
 * files are a single solid navy colour with no separate light/reversed
 * variant supplied, so `light` recolours it to white via a CSS filter
 * (brightness(0) then invert(1) — a standard, reliable technique for a
 * flat single-colour mark) for use on the app's dark navy surfaces, rather
 * than needing a second asset file.
 */
export function BoatologyLogo({
  variant = "emblem",
  light = false,
  className = "h-8 w-auto",
}: {
  variant?: "emblem" | "logo" | "wordmark";
  light?: boolean;
  className?: string;
}) {
  return (
    <img
      src={SOURCES[variant]}
      alt="Boatology"
      className={className}
      style={light ? { filter: "brightness(0) invert(1)" } : undefined}
    />
  );
}
