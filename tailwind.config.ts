import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./src/**/*.{js,ts,jsx,tsx,mdx}"],
  theme: {
    extend: {
      colors: {
        banana: {
          400: "#f7d117",
          500: "#f0c419",
        },
        ink: {
          900: "#0f0f10",
          800: "#171718",
          700: "#202022",
          600: "#2b2b2e",
        },
      },
    },
  },
  plugins: [],
};

export default config;
