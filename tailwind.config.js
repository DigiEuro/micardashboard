module.exports = {
  content: [
    './index.html',
    './about.html',
    './assets/js/**/*.js',
    './scripts/**/*.js'
  ],
  // generateKPICards() builds `lg:grid-cols-${n}` at runtime, which the
  // JIT scanner cannot see; keep every count it can produce in the build
  safelist: [
    'lg:grid-cols-2',
    'lg:grid-cols-3',
    'lg:grid-cols-4',
    'lg:grid-cols-5',
    'lg:grid-cols-6'
  ],
  theme: {
    extend: {},
  },
  plugins: [],
};
