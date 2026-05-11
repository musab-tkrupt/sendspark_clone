import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getServerApiBase } from "@/lib/server-api-base";

type PreviewMetadata = {
  lead_slug: string;
  preview_id: string;
  title: string;
  description: string;
  video_url: string;
  thumbnail_url: string;
  canonical_url: string;
  image_width?: number;
  image_height?: number;
};

async function getPreviewMetadata(lead: string, id: string): Promise<PreviewMetadata | null> {
  const api = getServerApiBase();
  const res = await fetch(`${api}/preview/metadata/${encodeURIComponent(lead)}/${encodeURIComponent(id)}`, {
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
      images: [
        {
          url: data.thumbnail_url,
          width: data.image_width || 1200,
          height: data.image_height || 630,
        },
      ],
      videos: [{ url: data.video_url, type: "video/mp4" }],
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
    <main className="min-h-screen bg-[#0b1020] text-zinc-100 p-4 sm:p-8">
      <div className="max-w-4xl mx-auto">
        <h1 className="text-2xl sm:text-3xl font-semibold mb-2">{data.title}</h1>
        <p className="text-zinc-300 mb-5">{data.description}</p>
        <video
          controls
          playsInline
          poster={data.thumbnail_url}
          src={data.video_url}
          className="w-full rounded-xl bg-black border border-zinc-800"
        />
      </div>
    </main>
  );
}
