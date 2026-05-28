import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Native bindings (.node) and font-loading paths Turbopack can't bundle into
  // ESM chunks. Mark them external so Next leaves them as runtime require()s.
  // lib/render-chart.ts dynamically imports @napi-rs/canvas + chart.js;
  // lib/render-card.tsx dynamically imports satori + @resvg/resvg-js.
  serverExternalPackages: [
    "@napi-rs/canvas",
    "chart.js",
    "satori",
    "@resvg/resvg-js",
  ],
};

export default nextConfig;
