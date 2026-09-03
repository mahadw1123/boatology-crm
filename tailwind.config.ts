import type { Config } from "tailwindcss";

export default {
  darkMode: ["class"],
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        // Real Boatology brand palette (Brand Guidelines v1.0).
        navy: {
          DEFAULT: "#0c1e38", // Deep Navy
          50: "#EAF0F6",
          100: "#CBDAE8",
          400: "#2d4160", // Marine Blue
          700: "#16283f",
          900: "#0c1e38", // Deep Navy
          950: "#081527",
        },
        ocean: {
          DEFAULT: "#82bbdb", // Sky Blue
          50: "#EEF6FB",
          100: "#D6EAF5",
          500: "#82bbdb", // Sky Blue
          600: "#5a9cc4", // a darker step for hover/active states — not in the
          // official swatches, derived from Sky Blue for interaction states
        },
        // The brand guide doesn't include a teal/seafoam accent — Marine
        // Blue is the correct secondary blue, replacing what had been an
        // invented colour with no basis in the real palette.
        seafoam: {
          DEFAULT: "#2d4160", // Marine Blue
          50: "#EEF1F5",
          100: "#D5DCE5",
          500: "#2d4160", // Marine Blue
        },
        taupe: {
          DEFAULT: "#ad9f97", // Coastal Taupe
          50: "#F7F5F4",
          100: "#EDE8E6",
          500: "#ad9f97", // Coastal Taupe
        },
        surface: {
          DEFAULT: "#FFFFFF",
          muted: "#F5F7FA",
        },
        ink: {
          DEFAULT: "#0c1e38",
          light: "#2d4160",
        },
        border: "#D9E1E8",
        success: "#1F9D55",
        danger: "#D64545",
      },
      fontFamily: {
        // Proxima Nova per the brand guide — this needs either an Adobe
        // Fonts (Typekit) kit ID or licensed font files to actually render,
        // since it's a commercial font with no free/open-source
        // distribution; the CSS is wired to use it the moment either is
        // added. Arial/Helvetica are the guide's own specified fallback for
        // when Proxima Nova is unavailable, exactly matching that fallback
        // chain here rather than defaulting to something unrelated.
        sans: ["Proxima Nova", "Arial", "Helvetica", "ui-sans-serif", "system-ui", "sans-serif"],
      },
      borderRadius: {
        DEFAULT: "8px",
        lg: "10px",
        xl: "14px",
      },
      boxShadow: {
        card: "0 1px 2px rgba(11, 35, 65, 0.04), 0 4px 12px rgba(11, 35, 65, 0.06)",
        cardHover: "0 2px 4px rgba(11, 35, 65, 0.06), 0 8px 20px rgba(11, 35, 65, 0.09)",
      },
    },
  },
  plugins: [require("tailwindcss-animate")],
} satisfies Config;
