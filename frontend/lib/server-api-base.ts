/** Server-only: preview metadata fetch. Prefer BACKEND_URL on Vercel (runtime, no client bundle). */
export function getServerApiBase(): string {
  const raw =
    process.env.BACKEND_URL?.trim() ||
    process.env.NEXT_PUBLIC_API_URL?.trim() ||
    "http://localhost:8000";
  return raw.replace(/\/+$/, "");
}
