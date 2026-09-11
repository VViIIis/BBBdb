/** @type {import('next').NextConfig} */
const nextConfig = {
  images: {
    remotePatterns: [
      { protocol: "https", hostname: "storage.googleapis.com" },
      { protocol: "https", hostname: "i2.seadn.io" },
      { protocol: "https", hostname: "*.execute-api.us-east-2.amazonaws.com" },
      { protocol: "https", hostname: "openseauserdata.com" },
    ],
  },
};

module.exports = nextConfig;
