import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // @napi-rs/canvas + chart.js: native .node binding can't be bundled by
  // Turbopack into ESM chunks. Mark them external so Next leaves them as
  // runtime require()s. lib/render-chart.ts dynamically imports both.
  serverExternalPackages: ["@napi-rs/canvas", "chart.js"],
};

export default nextConfig;
