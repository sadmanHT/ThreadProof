/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: {
    serverActions: {
      // ThreadProof Intelligence caps PDF inputs at 4.5 MB in the action itself.
      // This transport ceiling leaves multipart overhead while keeping the endpoint bounded.
      bodySizeLimit: "6mb",
    },
  },
};

export default nextConfig;
