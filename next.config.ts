import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  basePath: process.env.GITHUB_ACTIONS
    ? "/atmospheric-transport-explorer"
    : "",
  output: "export",
};

export default nextConfig;
