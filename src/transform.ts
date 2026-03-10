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

// Given a base string like "deploy (", find all matrix variant suffixes present in
// timing data — e.g. ["staging", "prod"] if timing has "deploy (staging) / ..." etc.
function findVariantSuffixes(base: string, jobs: JobTiming[]): string[] {
  const seen = new Set<string>();
  for (const job of jobs) {
    if (!job.name.startsWith(base)) continue;
    const rest = job.name.slice(base.length);
    const closeIdx = rest.indexOf(")");
    if (closeIdx >= 0 && rest.slice(closeIdx + 1, closeIdx + 4) === " / ") {
      seen.add(rest.slice(0, closeIdx));
    }
  }
  return [...seen].sort();
}

// Given a child workflow node's jobPrefix (e.g. "deploy / "), find matrix variant
// suffixes from the timing data — e.g. ["staging", "prod"].
function matrixVariants(jobPrefix: string, jobs: JobTiming[]): string[] {
  if (!jobPrefix) return [];
  const parts = jobPrefix.split(" / ");
  parts.pop(); // trailing ""
  const lastSegment = parts[parts.length - 1];
  const parentPart = parts.slice(0, -1).join(" / ");
  const prefix = parentPart ? `${parentPart} / ` : "";
  return findVariantSuffixes(`${prefix}${lastSegment} (`, jobs);
}

// Substitute the last segment of a jobPrefix with a matrix variant suffix.
// e.g. ("deploy / ", "staging") → "deploy (staging) / "
function withVariant(jobPrefix: string, variant: string): string {
  const parts = jobPrefix.split(" / ");
  parts.pop(); // trailing ""
  const lastSegment = parts.pop() ?? "";
  const parentPart = parts.length > 0 ? parts.join(" / ") + " / " : "";
  return `${parentPart}${lastSegment} (${variant}) / `;
}

function processJobs(
  rawJobs: Record<string, RawJob>,
  jobPrefix: string,
  jobs: JobTiming[],
  timingByName: Map<string, JobTiming>,
  nodeByJobPrefix: Map<string, string>,
): Record<string, Record<string, unknown>> {
  const outputJobs: Record<string, Record<string, unknown>> = {};

  for (const [jobId, rawJob] of Object.entries(rawJobs)) {
    const job =
      rawJob !== null && typeof rawJob === "object" && !Array.isArray(rawJob)
        ? (rawJob as RawJob)
        : {};
    const entry: Record<string, unknown> = {};

    if (typeof job.uses === "string") {
      // Reusable workflow job — emit uses: <name>, no duration
      const jobDisplayName = typeof job.name === "string" ? job.name : jobId;
      const childPrefix = `${jobPrefix}${jobDisplayName} / `;
      const childName = nodeByJobPrefix.get(childPrefix);
      if (childName === undefined) continue;

      const variantBase = `${jobPrefix}${jobDisplayName} (`;
      const variants = findVariantSuffixes(variantBase, jobs);
      const needs = parseNeeds(job.needs);

      if (variants.length > 0) {
        // Matrix reusable workflow — emit each variant as a separate entry
        for (const variant of variants) {
          const variantEntry: Record<string, unknown> = {
            uses: `${childName} (${variant})`,
          };
          if (needs.length > 0) variantEntry["needs"] = needs;
          outputJobs[`${jobDisplayName} (${variant})`] = variantEntry;
        }
      } else {
        entry["uses"] = childName;
        if (needs.length > 0) entry["needs"] = needs;
        outputJobs[jobId] = entry;
      }
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
        for (const variant of jobs
          .filter((j) => j.name.startsWith(matrixPrefix))
          .sort((a, b) => a.name.localeCompare(b.name))) {
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

  return outputJobs;
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

    const variants = matrixVariants(jobPrefix, jobs);
    if (variants.length > 0) {
      // This workflow was called via a matrix job — emit one section per variant
      for (const variant of variants) {
        output[`${name} (${variant})`] = {
          jobs: processJobs(
            rawJobs,
            withVariant(jobPrefix, variant),
            jobs,
            timingByName,
            nodeByJobPrefix,
          ),
        };
      }
    } else {
      output[name] = {
        jobs: processJobs(
          rawJobs,
          jobPrefix,
          jobs,
          timingByName,
          nodeByJobPrefix,
        ),
      };
    }
  }

  return yamlLib.dump(output, { noRefs: true });
}
