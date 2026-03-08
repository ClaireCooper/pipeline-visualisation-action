import * as yaml from "js-yaml";

interface RawJob {
  name?: string;
  needs?: string | string[];
  [key: string]: unknown;
}

interface RawWorkflow {
  name?: string;
  jobs?: Record<string, RawJob>;
}

export interface JobTiming {
  name: string;
  started_at: string | null;
  completed_at: string | null;
}

function parseNeeds(raw: string | string[] | undefined): string[] {
  if (!raw) return [];
  return Array.isArray(raw) ? raw : [raw];
}

function durationSeconds(
  started: string | null,
  completed: string | null
): number | undefined {
  if (!started || !completed) return undefined;
  const diff = Math.round(
    (new Date(completed).getTime() - new Date(started).getTime()) / 1000
  );
  return diff >= 0 ? diff : undefined;
}

export function buildVisualizerYaml(
  workflowName: string,
  workflowYaml: string,
  jobs: JobTiming[]
): string {
  let doc: unknown;
  try {
    doc = yaml.load(workflowYaml);
  } catch (e) {
    throw new Error(`Failed to parse workflow YAML: ${(e as Error).message}`);
  }
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) {
    const kind = doc === null || doc === undefined ? "empty" : Array.isArray(doc) ? "an array" : typeof doc;
    throw new Error(`Workflow YAML must be an object, got ${kind}`);
  }
  const rawJobs = (doc as RawWorkflow).jobs ?? {};

  const timingByName = new Map(jobs.map((j) => [j.name, j]));

  const outputJobs: Record<string, Record<string, unknown>> = {};

  for (const [jobId, rawJob] of Object.entries(rawJobs)) {
    const job = (rawJob !== null && typeof rawJob === "object" && !Array.isArray(rawJob))
      ? rawJob as RawJob
      : {};
    const entry: Record<string, unknown> = {};
    const lookupName = typeof job.name === "string" ? job.name : jobId;
    const timing = timingByName.get(lookupName);
    const duration = timing
      ? durationSeconds(timing.started_at, timing.completed_at)
      : undefined;
    if (duration !== undefined) entry["duration"] = duration;
    const needs = parseNeeds(job.needs);
    if (needs.length > 0) entry["needs"] = needs;
    outputJobs[jobId] = entry;
  }

  return yaml.dump({ [workflowName]: { jobs: outputJobs } });
}