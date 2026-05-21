import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  transpilePackages: ['@sim/shared'],
  // PoC: rewrite /api/* and /ws/* to the local Controller so the browser
  // and the Controller share an origin during development.
  async rewrites() {
    const controller = process.env.NEXT_PUBLIC_CONTROLLER_URL ?? 'http://127.0.0.1:8080';
    return [
      { source: '/api/sessions/:path*', destination: `${controller}/api/sessions/:path*` },
      { source: '/api/sessions', destination: `${controller}/api/sessions` },
    ];
  },
};

export default nextConfig;
