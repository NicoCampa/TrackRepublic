import { NextResponse } from "next/server";
import { getPipelineJob, getRunningPipelineJob, readPipelineSnapshot, startPipelineJob, type PipelineMode } from "@/lib/pipeline-jobs";

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
  const runningJob = getRunningPipelineJob();
  if (runningJob) {
    return NextResponse.json(
      {
        message: "A pipeline job is already running.",
        job: runningJob,
      },
      { status: 409 },
    );
  }

  const formData = await request.formData();
  const mode = String(formData.get("mode") ?? "parse_classify") as PipelineMode;
  const promptTemplateValue = formData.get("promptTemplate");
  const promptTemplate = typeof promptTemplateValue === "string" ? promptTemplateValue.trim() : "";
  const promptAddendumValue = formData.get("promptAddendum");
  const promptAddendum = typeof promptAddendumValue === "string" ? promptAddendumValue.trim() : "";
  const userNameValue = formData.get("userName");
  const userName = typeof userNameValue === "string" ? userNameValue.trim() : "";
  const modelValue = formData.get("model");
  const model = typeof modelValue === "string" ? modelValue.trim() : "";
  const fileValue = formData.get("file");
  const file = fileValue instanceof File ? fileValue : undefined;
  if (mode === "parse_classify" && !file) {
    return NextResponse.json({ message: "A PDF file is required for Parse + classify." }, { status: 400 });
  }
  const job = await startPipelineJob(mode, file, {
    promptTemplate,
    promptAddendum,
    userName,
    model,
  });
  return NextResponse.json({ job });
}
