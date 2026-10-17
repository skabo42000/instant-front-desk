/** @type {import('next').NextConfig} */
module.exports = {
  // PGlite loads its WASM and pgvector extension from Node filesystem paths.
  serverExternalPackages: ["@electric-sql/pglite", "@electric-sql/pglite-pgvector"],
  // Local database files and private reports must never be traced into a server build.
  outputFileTracingExcludes: { "/*": ["./data/**/*", "./reports/**/*", "./benchmarks/**/*", "./.env*"] },
  async headers() {
    return [{ source: "/:path*", headers: [
      { key: "X-Content-Type-Options", value: "nosniff" },
      { key: "X-Frame-Options", value: "DENY" },
      { key: "Referrer-Policy", value: "no-referrer" },
      { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
      { key: "Content-Security-Policy", value: "frame-ancestors 'none'; base-uri 'self'; object-src 'none'" },
    ] }];
  },
};
