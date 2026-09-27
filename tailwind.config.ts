import type { Config } from "tailwindcss";

export default {
  content: [
    "./app/**/*.{js,ts,jsx,tsx,mdx}",
    "./components/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      keyframes: {
        grab: {
          "0%": { transform: "scale(1)", opacity: "1" },
          "100%": { transform: "scale(0.05) translateY(40%)", opacity: "0" },
        },
        pulseRing: {
          "0%": { transform: "scale(0.9)", opacity: "0.7" },
          "100%": { transform: "scale(1.4)", opacity: "0" },
        },
      },
      animation: {
        grab: "grab 600ms cubic-bezier(0.4, 0, 0.2, 1) forwards",
        pulseRing: "pulseRing 1.2s ease-out infinite",
      },
    },
  },
  plugins: [],
} satisfies Config;
