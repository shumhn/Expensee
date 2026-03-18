const path = require('path');

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  outputFileTracingRoot: path.join(__dirname),
  turbopack: {}, // Silence Turbopack warning
  webpack: (config) => {
    config.resolve.fallback = {
      fs: false,
      path: false,
      crypto: false,
    };
    return config;
  },
  async rewrites() {
    return [
      { source: '/dashboard', destination: '/employer?mode=dashboard' },
      { source: '/setup', destination: '/employer?mode=setup' },
      { source: '/employees', destination: '/employer?mode=employees' },
      { source: '/history', destination: '/employer?mode=history' },
      { source: '/agent', destination: '/employer?mode=agent' },
    ];
  },
};

module.exports = nextConfig;
