import { NextResponse } from "next/server";

/**
 * Runtime API base for the browser. Prefer BACKEND_URL on Vercel so you do not
 * depend on NEXT_PUBLIC_* being present at `next build` time.
 */
export async function GET() {
  const raw =
    process.env.BACKEND_URL?.trim() ||
    process.env.NEXT_PUBLIC_API_URL?.trim() ||
    "http://localhost:8000";
  const apiBaseUrl = raw.replace(/\/+$/, "");
  return NextResponse.json({ apiBaseUrl });
}
