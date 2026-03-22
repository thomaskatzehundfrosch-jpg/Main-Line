/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        bg: {
          primary: '#ffffff',
          surface: '#f8f9fa',
          panel: '#f0f1f3',
          hover: '#e9ecef',
        },
        border: {
          subtle: '#dee2e6',
          active: '#adb5bd',
        },
        accent: {
          teal: '#3b62a0',
          amber: '#d97706',
          orange: '#ea580c',
          red: '#dc2626',
          green: '#3b62a0',
          blue: '#2563eb',
        },
        text: {
          primary: '#1a1a2e',
          secondary: '#495057',
          muted: '#868e96',
        },
        board: {
          light: '#e8dcc0',
          dark: '#4b6fa0',
        },
      },
      fontFamily: {
        mono: ['"JetBrains Mono"', '"Space Mono"', 'monospace'],
        sans: ['Outfit', 'Satoshi', 'system-ui', 'sans-serif'],
      },
      boxShadow: {
        glow: '0 0 12px rgba(59, 98, 160, 0.3)',
        'glow-sm': '0 0 6px rgba(59, 98, 160, 0.2)',
      },
    },
  },
  plugins: [],
};
