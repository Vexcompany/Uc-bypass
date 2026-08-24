/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Serverless-safe: nothing exotic required, no external binaries.
  // Both API routes run on the Node.js runtime and stream via the standard Web APIs.
};

export default nextConfig;
