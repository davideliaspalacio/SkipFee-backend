import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // En dev, permitir que el túnel de ngrok consuma recursos del dev server
  // (HMR, etc.). Solo afecta `next dev`; no impacta producción.
  allowedDevOrigins: ['781f-191-95-34-238.ngrok-free.app'],
};

export default nextConfig;
