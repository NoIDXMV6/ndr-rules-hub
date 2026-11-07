import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  // Гарантированно кладём движки Prisma в standalone-сборку:
  // при binaryTargets с несколькими платформами файл-трейсинг Next
  // может не скопировать бинарники query engine в /app/node_modules.
  outputFileTracingIncludes: {
    "/**/*": ["./node_modules/.prisma/client/**/*", "./node_modules/@prisma/client/**/*"],
  },
  /* config options here */
  typescript: {
    ignoreBuildErrors: true,
  },
  reactStrictMode: false,
};

export default nextConfig;
