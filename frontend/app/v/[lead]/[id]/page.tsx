import type { Metadata } from "next";
import { notFound } from "next/navigation";
import VideoPlayer from "./VideoPlayer";

type PreviewMetadata = {
  lead_slug: string;
  preview_id: string;
  title: string;
  description: string;
  video_url: string;
  thumbnail_url: string;
  canonical_url: string;
};

const API = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000";

async function getPreviewMetadata(lead: string, id: string): Promise<PreviewMetadata | null> {
  const res = await fetch(`${API}/preview/metadata/${encodeURIComponent(lead)}/${encodeURIComponent(id)}`, {
    cache: "no-store",
  });
  if (!res.ok) return null;
  return (await res.json()) as PreviewMetadata;
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ lead: string; id: string }>;
}): Promise<Metadata> {
  const { lead, id } = await params;
  const data = await getPreviewMetadata(lead, id);
  if (!data) {
    return {
      title: "Preview not found",
      description: "This preview is unavailable.",
    };
  }
  return {
    title: data.title,
    description: data.description,
    alternates: { canonical: data.canonical_url },
    openGraph: {
      title: data.title,
      description: data.description,
      type: "video.other",
      url: data.canonical_url,
      images: [{ url: data.thumbnail_url, width: 1280, height: 720 }],
      videos: [{ url: data.video_url, secureUrl: data.video_url, type: "video/mp4", width: 1280, height: 720 }],
    },
    twitter: {
      card: "summary_large_image",
      title: data.title,
      description: data.description,
      images: [data.thumbnail_url],
    },
  };
}

export default async function PreviewPage({
  params,
}: {
  params: Promise<{ lead: string; id: string }>;
}) {
  const { lead, id } = await params;
  const data = await getPreviewMetadata(lead, id);
  if (!data) notFound();

  return (
    <main className="min-h-screen bg-[#0b0f1a] text-zinc-100 flex flex-col items-center justify-center p-4 sm:p-8">
      <div className="w-full max-w-4xl">
        <div className="mb-4">
          <h1 className="text-2xl sm:text-3xl font-bold tracking-tight">{data.title}</h1>
          <p className="text-zinc-400 mt-1 text-sm">{data.description}</p>
        </div>
        <VideoPlayer src={data.video_url} poster={data.thumbnail_url} />
      </div>
    </main>
  );
}
