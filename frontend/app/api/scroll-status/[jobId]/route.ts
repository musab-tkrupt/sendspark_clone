import { NextRequest, NextResponse } from "next/server";
import path from "path";
import fs from "fs";

export const runtime = "nodejs";

const STALE_SECONDS = 180;

export async function GET(
  _req: NextRequest,
  { params }: { params: { jobId: string } }
) {
  const jobFile = path.join(process.cwd(), ".jobs", `${params.jobId}.json`);
  if (!fs.existsSync(jobFile)) {
    return NextResponse.json({ status: "not_found" }, { status: 404 });
  }

  const data = JSON.parse(fs.readFileSync(jobFile, "utf-8"));
  const status = data.status;

  if (status === "queued" || status === "recording") {
    const ageSecs = (Date.now() - fs.statSync(jobFile).mtimeMs) / 1000;
    if (ageSecs > STALE_SECONDS) {
      const stale = { status: "error", error: `stale job exceeded ${STALE_SECONDS}s` };
      fs.writeFileSync(jobFile, JSON.stringify(stale));
      return NextResponse.json(stale);
    }
  }

  return NextResponse.json(data);
}
