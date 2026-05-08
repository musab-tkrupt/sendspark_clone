import { NextRequest, NextResponse } from "next/server";
import { spawn } from "child_process";
import { randomUUID } from "crypto";
import path from "path";
import fs from "fs";

export const runtime = "nodejs";

function writeJob(jobsDir: string, jobId: string, data: object) {
  fs.mkdirSync(jobsDir, { recursive: true });
  fs.writeFileSync(path.join(jobsDir, `${jobId}.json`), JSON.stringify(data));
}

export async function POST(req: NextRequest) {
  const body = await req.formData().catch(() => null);
  const url = body?.get("url");

  if (!url || typeof url !== "string") {
    return NextResponse.json({ error: "url is required" }, { status: 400 });
  }

  try {
    new URL(url);
  } catch {
    return NextResponse.json({ error: "Invalid URL" }, { status: 400 });
  }

  const jobId = randomUUID();
  const cwd = process.cwd();
  const jobsDir = path.join(cwd, ".jobs");

  writeJob(jobsDir, jobId, { status: "queued", created_at: Date.now() });

  const child = spawn(
    "node",
    ["scripts/record-paged.js", url, jobId],
    { cwd, stdio: "pipe", detached: false }
  );

  child.stderr?.on("data", (chunk: Buffer) =>
    console.error("[scroll-recorder]", chunk.toString().trim())
  );
  child.stdout?.on("data", (chunk: Buffer) =>
    console.log("[scroll-recorder]", chunk.toString().trim())
  );
  child.on("close", (code: number | null) => {
    if (code !== 0) {
      try {
        const jobFile = path.join(jobsDir, `${jobId}.json`);
        const current = JSON.parse(fs.readFileSync(jobFile, "utf-8"));
        if (current.status === "queued" || current.status === "recording") {
          writeJob(jobsDir, jobId, {
            status: "error",
            error: `Recorder exited with code ${code}`,
          });
        }
      } catch {}
    }
  });

  return NextResponse.json({ jobId });
}
