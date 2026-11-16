import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  // Гарантированно кладём движки Prisma в standalone-сборку:
  // при binaryTargets с несколькими платформами файл-трейсинг Next
  // может не скопировать бинарники query engine в /app/node_modules.
  outputFileTracingIncludes: {
    "/**/*": ["./node_modules/.prisma/client/**/*", "./node_modules/@prisma/client/**/*"],
  },
  // ── Заголовки безопасности (все маршруты, включая API и статику) ──────────
  // nosniff — не позволяем браузеру «угадывать» MIME; DENY — запрет iframe
  // (кликджекинг); referrer-policy — не отдаём полный URL с ?token= внешним
  // сайтам; permissions-policy — глушим неиспользуемые API браузера.
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=()" },
          { key: "X-DNS-Prefetch-Control", value: "off" },
        ],
      },
    ];
  },
  /* config options here */
  typescript: {
    ignoreBuildErrors: true,
  },
  reactStrictMode: false,
};

export default nextConfig;
