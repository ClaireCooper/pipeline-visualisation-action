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

  // Build map from child jobPrefix → display name for cross-referencing
  const nodeByJobPrefix = new Map<string, string>();
  for (const w of workflows) {
    nodeByJobPrefix.set(w.jobPrefix, w.name);
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
        const childPrefix = `${jobPrefix}${jobId} / `;
        const reusableName = nodeByJobPrefix.get(childPrefix);
        if (reusableName === undefined) continue;
        entry["uses"] = reusableName;
        const needs = parseNeeds(job.needs);
        if (needs.length > 0) entry["needs"] = needs;
        outputJobs[jobId] = entry;
      } else {
        // Regular job — look up timing
        const lookupName = typeof job.name === "string" ? job.name : jobId;
        const prefixedName = `${jobPrefix}${lookupName}`;
        const timing = timingByName.get(prefixedName);
        if (timing) {
          const duration = durationSeconds(
            timing.started_at,
            timing.completed_at,
          );
          if (duration !== undefined) entry["duration"] = duration;
          const needs = parseNeeds(job.needs);
          if (needs.length > 0) entry["needs"] = needs;
          outputJobs[jobId] = entry;
        } else {
          // Matrix job — emit each variant (e.g. "test (18)", "test (20)") as a
          // separate job, inheriting needs from the parent job definition
          const matrixPrefix = `${prefixedName} (`;
          const needs = parseNeeds(job.needs);
          for (const variant of jobs.filter((j) =>
            j.name.startsWith(matrixPrefix),
          )) {
            const variantEntry: Record<string, unknown> = {};
            const duration = durationSeconds(
              variant.started_at,
              variant.completed_at,
            );
            if (duration !== undefined) variantEntry["duration"] = duration;
            if (needs.length > 0) variantEntry["needs"] = needs;
            outputJobs[variant.name.slice(jobPrefix.length)] = variantEntry;
          }
        }
      }
    }

    output[name] = { jobs: outputJobs };
  }

  return yamlLib.dump(output);
}
