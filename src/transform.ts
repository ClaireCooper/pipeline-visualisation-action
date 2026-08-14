import * as yamlLib from "js-yaml";
import type { JobTiming } from "./api";
// WorkflowNode is also used locally in this file, so it needs a local import binding
// in addition to the re-export.
import type { WorkflowNode } from "./names";

export { normaliseWorkflowName } from "./names";
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

// GitHub truncates any " / "-delimited segment of a job name longer than this
// to (limit - 3) characters followed by "...".
const MAX_NAME_SEGMENT = 100;

function hasTruncatedSegment(jobName: string): boolean {
  return jobName
    .split(" / ")
    .some((s) => s.length === MAX_NAME_SEGMENT && s.endsWith("..."));
}

// A matrix variant of a job, e.g. the "18" in "test (18)". A long variant is
// truncated by GitHub and loses its closing paren, so the paren can't be used
// to find where the variant ends.
interface MatrixVariant {
  label: string;
  truncated: boolean;
}

// The segment GitHub actually used, for matching against real job names.
function variantSegment(base: string, variant: MatrixVariant): string {
  return `${base} (${variant.label}${variant.truncated ? "" : ")"}`;
}

// The key we emit. Always closed, so a truncated variant still reads as a
// balanced pair of parens in the output.
function variantKey(base: string, variant: MatrixVariant): string {
  return `${base} (${variant.label})`;
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

// Variants of `base` that call a reusable workflow, i.e. job names shaped
// "<base> (<variant>) / <child job>". The variant ends at the " / " rather than
// at a closing paren, because GitHub may have truncated the paren away.
function findVariantSuffixes(base: string, jobs: JobTiming[]): MatrixVariant[] {
  const open = `${base} (`;
  const seen = new Map<string, MatrixVariant>();
  for (const job of jobs) {
    if (!job.name.startsWith(open)) continue;
    const rest = job.name.slice(open.length);
    const sepIdx = rest.indexOf(" / ");
    if (sepIdx < 0) continue;
    const segment = rest.slice(0, sepIdx);
    const truncated = !segment.endsWith(")");
    seen.set(segment, {
      label: truncated ? segment : segment.slice(0, -1),
      truncated,
    });
  }
  return [...seen.values()].sort((a, b) =>
    a.label < b.label ? -1 : a.label > b.label ? 1 : 0,
  );
}

function findMatrixVariants(
  jobPrefix: string,
  jobs: JobTiming[],
): MatrixVariant[] {
  if (!jobPrefix) return [];
  const parts = jobPrefix.split(" / ");
  parts.pop(); // trailing ""
  const lastSegment = parts[parts.length - 1];
  const parentPart = parts.slice(0, -1).join(" / ");
  const prefix = parentPart ? `${parentPart} / ` : "";
  return findVariantSuffixes(`${prefix}${lastSegment}`, jobs);
}

function withMatrixVariant(jobPrefix: string, variant: MatrixVariant): string {
  const parts = jobPrefix.split(" / ");
  parts.pop(); // trailing ""
  const lastSegment = parts.pop() ?? "";
  const parentPart = parts.length > 0 ? parts.join(" / ") + " / " : "";
  return `${variantSegment(`${parentPart}${lastSegment}`, variant)} / `;
}

function buildMatrixVariantFilter(
  jobPrefix: string,
  lookupName: string,
  prefixedName: string,
): (job: JobTiming) => boolean {
  if (!lookupName.includes("${{")) {
    const prefix = `${prefixedName} (`;
    return (job) => job.name.startsWith(prefix);
  }
  const pattern = (jobPrefix + lookupName)
    .split(/\$\{\{[^}]*\}\}/)
    .map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join(".+");
  const re = new RegExp(`^${pattern}$`);
  // Truncation can cut the literal tail after the last wildcard (e.g. the
  // closing paren of "Unit tests (${{ matrix.shard }})"), so a truncated name
  // is matched against the pattern up to that wildcard instead.
  const truncatedRe = new RegExp(
    `^${pattern.replace(/(\.\+)(?!.*\.\+)[\s\S]*$/, "$1")}`,
  );
  return (job) =>
    re.test(job.name) ||
    (hasTruncatedSegment(job.name) && truncatedRe.test(job.name));
}

function processJobs(
  rawJobs: Record<string, RawJob>,
  jobPrefix: string,
  jobs: JobTiming[],
  timingByName: Map<string, JobTiming>,
  nodeByJobPrefix: Map<string, string>,
): Record<string, Record<string, unknown>> {
  const outputJobs: Record<string, Record<string, unknown>> = {};
  // `needs:` names job IDs, but a matrix job is emitted once per variant and a
  // job with a name: field is emitted under that name, so needs can only be
  // resolved once every key is known.
  const keysByJobId = new Map<string, string[]>();
  const needsByKey = new Map<string, string[]>();

  function emit(
    jobId: string,
    key: string,
    entry: Record<string, unknown>,
    needs: string[],
  ): void {
    outputJobs[key] = entry;
    keysByJobId.set(jobId, [...(keysByJobId.get(jobId) ?? []), key]);
    if (needs.length > 0) needsByKey.set(key, needs);
  }

  for (const [jobId, rawJob] of Object.entries(rawJobs)) {
    const job =
      rawJob !== null && typeof rawJob === "object" && !Array.isArray(rawJob)
        ? (rawJob as RawJob)
        : {};
    const needs = parseNeeds(job.needs);

    if (typeof job.uses === "string") {
      // Reusable workflow job — emit uses: <name>, no duration
      const jobDisplayName = typeof job.name === "string" ? job.name : jobId;
      const childPrefix = `${jobPrefix}${jobDisplayName} / `;
      const childName = nodeByJobPrefix.get(childPrefix);
      if (childName === undefined) continue;

      const variants = findVariantSuffixes(
        `${jobPrefix}${jobDisplayName}`,
        jobs,
      );

      if (variants.length > 0) {
        // Matrix reusable workflow — emit each variant as a separate entry
        for (const variant of variants) {
          emit(
            jobId,
            variantKey(jobDisplayName, variant),
            { uses: variantKey(childName, variant) },
            needs,
          );
        }
      } else {
        emit(jobId, jobId, { uses: childName }, needs);
      }
    } else {
      // Regular job — look up timing
      const lookupName = typeof job.name === "string" ? job.name : jobId;
      const prefixedName = `${jobPrefix}${lookupName}`;
      const timing = timingByName.get(prefixedName);
      if (timing) {
        const entry: Record<string, unknown> = {};
        const duration = durationSeconds(
          timing.started_at,
          timing.completed_at,
        );
        if (duration !== undefined) entry["duration"] = duration;
        emit(jobId, jobId, entry, needs);
      } else {
        // Matrix job — emit each variant (e.g. "test (18)", "test (20)") as a
        // separate job, inheriting needs from the parent job definition
        const isVariant = buildMatrixVariantFilter(
          jobPrefix,
          lookupName,
          prefixedName,
        );
        for (const variant of jobs
          .filter(isVariant)
          .sort((a, b) => a.name.localeCompare(b.name))) {
          const variantEntry: Record<string, unknown> = {};
          const duration = durationSeconds(
            variant.started_at,
            variant.completed_at,
          );
          if (duration !== undefined) variantEntry["duration"] = duration;
          emit(
            jobId,
            variant.name.slice(jobPrefix.length),
            variantEntry,
            needs,
          );
        }
      }
    }
  }

  // Rewrite needs from job IDs to the keys actually emitted. A dependency that
  // produced no keys — excluded for having no timing, or a reusable workflow
  // that couldn't be fetched — is dropped rather than left dangling, because
  // the visualiser matches needs by exact key and drops any job that names one
  // it can't resolve.
  for (const [key, needs] of needsByKey) {
    const resolved = [
      ...new Set(needs.flatMap((dep) => keysByJobId.get(dep) ?? [])),
    ];
    if (resolved.length > 0) outputJobs[key]["needs"] = resolved;
  }

  return outputJobs;
}

export function buildArtifactName(workflowName: string): string {
  return `${workflowName}-visualisation.yaml`;
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

    const variants = findMatrixVariants(jobPrefix, jobs);
    if (variants.length > 0) {
      // This workflow was called via a matrix job — emit one section per variant
      for (const variant of variants) {
        output[variantKey(name, variant)] = {
          jobs: processJobs(
            rawJobs,
            withMatrixVariant(jobPrefix, variant),
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
