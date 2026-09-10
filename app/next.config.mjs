/** @type {import('next').NextConfig} */
const nextConfig = {
  // Alle data-access is server-side. Er gaat geen enkele database-sleutel naar
  // de browser -- ook de anon key niet, want we lezen met de secret key achter
  // server components.
  reactStrictMode: true,
};
export default nextConfig;
