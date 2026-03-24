import { NextResponse } from "next/server";
import { getPipelineJob, readPipelineSnapshot, startPipelineJob, type PipelineMode } from "@/lib/pipeline-jobs";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const jobId = searchParams.get("jobId");
  if (jobId) {
    const job = getPipelineJob(jobId);
    if (!job) {
      return NextResponse.json({ message: "Job not found." }, { status: 404 });
    }
    return NextResponse.json({ job });
  }
  return NextResponse.json(await readPipelineSnapshot());
}

export async function POST(request: Request) {
  const formData = await request.formData();
  const mode = String(formData.get("mode") ?? "parse_classify") as PipelineMode;
  const fileValue = formData.get("file");
  const file = fileValue instanceof File ? fileValue : undefined;
  if (mode === "parse_classify" && !file) {
    return NextResponse.json({ message: "A PDF file is required for Parse + classify." }, { status: 400 });
  }
  const job = await startPipelineJob(mode, file);
  return NextResponse.json({ job });
}
