import { NextResponse } from "next/server";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const SUPABASE_BUCKET = process.env.NEXT_PUBLIC_SUPABASE_BUCKET ?? "Videos";

const assetMap: Record<string, string> = {
  "video.mp4": "video.mp4",
  "thumbnail.jpg": "thumbnail.jpg",
  "preview.gif": "preview.gif",
  "gif-preview.html": "gif-preview.html",
  "index.html": "index.html",
};

function supabasePublicUrl(objectKey: string): string {
  return `${SUPABASE_URL}/storage/v1/object/public/${SUPABASE_BUCKET}/${objectKey}`;
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ lead: string; id: string; asset: string }> }
) {
  const { lead, id, asset } = await params;
  const mapped = assetMap[asset];

  if (!SUPABASE_URL || !mapped) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  const objectKey = `previews/${lead}/${id}/${mapped}`;
  const target = supabasePublicUrl(objectKey);
  if (mapped.endsWith(".html")) {
    const res = await fetch(target);
    if (!res.ok) {
      return NextResponse.json({ error: "upstream_failed" }, { status: 502 });
    }
    const body = await res.text();
    return new NextResponse(body, {
      status: 200,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "public, max-age=300",
      },
    });
  }

  return NextResponse.redirect(target, { status: 302 });
}
