/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        canvas: "#0B0D0F",
        surface: {
          DEFAULT: "#14171A",
          raised: "#1B1F23",
        },
        border: {
          subtle: "rgba(255, 255, 255, 0.08)",
          DEFAULT: "rgba(255, 255, 255, 0.14)",
        },
        primary: "#E6E8EA",
        secondary: "#9AA1A8",
        tertiary: "#6B7178",
        accent: {
          DEFAULT: "#3E7CA6",
          muted: "rgba(62, 124, 166, 0.14)",
        },
        status: {
          success: "#4C9A6A",
          warning: "#B98A3D",
          error: "#B8615C",
          info: "#3E7CA6",
        },
      },
      fontFamily: {
        sans: ["'Inter'", "'IBM Plex Sans'", "system-ui", "sans-serif"],
        mono: ["'IBM Plex Mono'", "'JetBrains Mono'", "monospace"],
      },
      borderRadius: {
        sm: "6px",
        md: "8px",
      },
    },
  },
  plugins: [],
}

