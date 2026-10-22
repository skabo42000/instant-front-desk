import { getLocalDatabase } from "@/lib/local-businesses";
import { createWebsiteLoader, createWebsiteLoadHandler } from "@/lib/website-loader";

export const runtime = "nodejs";
export const POST = createWebsiteLoadHandler(createWebsiteLoader(getLocalDatabase));
