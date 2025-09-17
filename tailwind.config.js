/** @type {import('tailwindcss').Config} */
export default {
  content: [
    './index.html',
    './src/**/*.{js,jsx,ts,tsx}',
  ],
  theme: {
    extend: {
      colors: {
        'betting-green': '#10B981',
        'betting-red':   '#EF4444',
        'betting-yellow':'#F59E0B',
        'dark-bg':       '#0F172A',
        'dark-card':     '#1E293B'
      }
    },
  },
  plugins: [],
}
