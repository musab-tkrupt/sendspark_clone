import type { Metadata } from "next";
import VideoPlayer from "./VideoPlayer";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const SUPABASE_BUCKET = process.env.NEXT_PUBLIC_SUPABASE_BUCKET ?? "Videos";
const APP_URL = (process.env.NEXT_PUBLIC_APP_URL ?? "").replace(/\/$/, "");

function supabasePublicUrl(objectKey: string): string {
  return `${SUPABASE_URL}/storage/v1/object/public/${SUPABASE_BUCKET}/${objectKey}`;
}

/** Preview bundle objects are stored at previews/{lead}/{id}/… (no bucket path prefix). */
function previewUrls(leadSlug: string, previewId: string) {
  const root = `previews/${leadSlug}/${previewId}`;
  return {
    video: supabasePublicUrl(`${root}/video.mp4`),
    thumbnail: supabasePublicUrl(`${root}/thumbnail.jpg`),
    canonical: APP_URL ? `${APP_URL}/v/${leadSlug}/${previewId}` : "",
  };
}

function displayName(slug: string): string {
  return slug
    .split("-")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ lead: string; id: string }>;
}): Promise<Metadata> {
  const { lead, id } = await params;
  const name = displayName(lead);
  const title = `${name} — Personalized Video`;
  const description = `A personalized video message for ${name}.`;
  const urls = previewUrls(lead, id);

  return {
    title,
    description,
    ...(urls.canonical && { alternates: { canonical: urls.canonical } }),
    openGraph: {
      title,
      description,
      type: "video.other",
      ...(urls.canonical && { url: urls.canonical }),
      images: [{ url: urls.thumbnail, width: 1280, height: 720 }],
      videos: [{ url: urls.video, secureUrl: urls.video, type: "video/mp4", width: 1280, height: 720 }],
    },
    twitter: {
      card: "summary_large_image",
      title,
      description,
      images: [urls.thumbnail],
    },
  };
}

export default async function PreviewPage({
  params,
}: {
  params: Promise<{ lead: string; id: string }>;
}) {
  const { lead, id } = await params;
  const name = displayName(lead);
  const urls = previewUrls(lead, id);

  return (
    <main className="min-h-screen bg-[#0b0f1a] text-zinc-100 flex flex-col items-center justify-center p-4 sm:p-8">
      <div className="w-full max-w-4xl">
        <div className="mb-4">
          <h1 className="text-2xl sm:text-3xl font-bold tracking-tight">Video for {name}</h1>
          <p className="text-zinc-400 mt-1 text-sm">Click to watch your personalized message.</p>
        </div>
        <VideoPlayer src={urls.video} poster={urls.thumbnail} />
      </div>
    </main>
  );
}
