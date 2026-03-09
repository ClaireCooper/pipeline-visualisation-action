import * as yamlLib from "js-yaml";
import type { JobTiming } from "./api";
export { normaliseWorkflowName } from "./names";
// WorkflowNode is also used locally in this file, so it needs a local import binding
// in addition to the re-export.
import type { WorkflowNode } from "./names";
export type { WorkflowNode };

interface RawJob {
  name?: string;
  needs?: string | string[];
  uses?: string;
  [key: string]: unknown;
}

interface RawWorkflow {
  name?: string;
  jobs?: Record<string, RawJob>;
}

function parseNeeds(raw: string | string[] | undefined): string[] {
  if (!raw) return [];
  return Array.isArray(raw) ? raw : [raw];
}

function durationSeconds(
  started: string | null,
  completed: string | null,
): number | undefined {
  if (!started || !completed) return undefined;
  const diff = Math.round(
    (new Date(completed).getTime() - new Date(started).getTime()) / 1000,
  );
  return diff >= 0 ? diff : undefined;
}

export function buildVisualiserYaml(
  workflows: WorkflowNode[],
  jobs: JobTiming[],
): string {
  const timingByName = new Map(jobs.map((j) => [j.name, j]));

  // Build map from raw uses value → display name for cross-referencing
  const usesNameMap = new Map<string, string>();
  for (const w of workflows) {
    if (w.parentUsesValue !== undefined) {
      usesNameMap.set(w.parentUsesValue, w.name);
    }
  }

  const output: Record<string, unknown> = {};

  for (const { name, yaml, jobPrefix } of workflows) {
    let doc: unknown;
    try {
      doc = yamlLib.load(yaml);
    } catch (e) {
      throw new Error(
        `Failed to parse workflow YAML: ${(e as Error).message}`,
        { cause: e },
      );
    }
    if (!doc || typeof doc !== "object" || Array.isArray(doc)) {
      const kind =
        doc === null || doc === undefined
          ? "empty"
          : Array.isArray(doc)
            ? "an array"
            : typeof doc;
      throw new Error(`Workflow YAML must be an object, got ${kind}`);
    }
    const rawJobs = (doc as RawWorkflow).jobs ?? {};
    const outputJobs: Record<string, Record<string, unknown>> = {};

    for (const [jobId, rawJob] of Object.entries(rawJobs)) {
      const job =
        rawJob !== null && typeof rawJob === "object" && !Array.isArray(rawJob)
          ? (rawJob as RawJob)
          : {};
      const entry: Record<string, unknown> = {};

      if (typeof job.uses === "string") {
        // Reusable workflow job — emit uses: <name>, no duration
        const reusableName = usesNameMap.get(job.uses);
        if (reusableName === undefined) continue;
        entry["uses"] = reusableName;
        const needs = parseNeeds(job.needs);
        if (needs.length > 0) entry["needs"] = needs;
      } else {
        // Regular job — look up timing
        const lookupName = typeof job.name === "string" ? job.name : jobId;
        const timing = timingByName.get(`${jobPrefix}${lookupName}`);
        if (!timing) continue;
        const duration = durationSeconds(
          timing.started_at,
          timing.completed_at,
        );
        if (duration !== undefined) entry["duration"] = duration;
        const needs = parseNeeds(job.needs);
        if (needs.length > 0) entry["needs"] = needs;
      }

      outputJobs[jobId] = entry;
    }

    output[name] = { jobs: outputJobs };
  }

  return yamlLib.dump(output);
}
