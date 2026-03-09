import type { Octokit } from "@octokit/rest" with {
  "resolution-mode": "import",
};
import * as yaml from "js-yaml";
import { normaliseWorkflowName, type WorkflowNode } from "./names";

export interface RunDetails {
  name: string;
  headSha: string;
  workflowId: number;
}

export interface JobTiming {
  name: string;
  started_at: string | null;
  completed_at: string | null;
}

export async function fetchRunDetails(
  octokit: Octokit,
  owner: string,
  repo: string,
  runId: number,
): Promise<RunDetails> {
  const { data } = await octokit.rest.actions.getWorkflowRun({
    owner,
    repo,
    run_id: runId,
  });
  return {
    name: data.name ?? "",
    headSha: data.head_sha,
    workflowId: data.workflow_id,
  };
}

export async function fetchWorkflowPath(
  octokit: Octokit,
  owner: string,
  repo: string,
  workflowId: number,
): Promise<string> {
  const { data } = await octokit.rest.actions.getWorkflow({
    owner,
    repo,
    workflow_id: workflowId,
  });
  return data.path;
}

export async function fetchWorkflowFile(
  octokit: Octokit,
  owner: string,
  repo: string,
  path: string,
  ref: string,
): Promise<string> {
  const { data } = await octokit.rest.repos.getContent({
    owner,
    repo,
    path,
    ref,
  });
  if (Array.isArray(data) || !("content" in data) || !("encoding" in data)) {
    throw new Error(`Unexpected response fetching ${path}`);
  }
  if (data.encoding !== "base64") {
    throw new Error(
      `Unexpected encoding "${String(data.encoding)}" fetching ${path}`,
    );
  }
  return Buffer.from(data.content, "base64").toString("utf-8");
}

export interface UsesRef {
  owner: string;
  repo: string;
  path: string;
  ref: string;
}

export function parseUsesRef(
  uses: string,
  owner: string,
  repo: string,
  headSha: string,
): UsesRef {
  // Local: "./.github/workflows/deploy.yml"
  if (uses.startsWith("./")) {
    return { owner, repo, path: uses.slice(2), ref: headSha };
  }
  // External: "org/repo/.github/workflows/deploy.yml@ref"
  const atIdx = uses.lastIndexOf("@");
  if (atIdx === -1) throw new Error(`Unrecognised uses value: "${uses}"`);
  const ref = uses.slice(atIdx + 1);
  const rest = uses.slice(0, atIdx); // "org/repo/.github/workflows/deploy.yml"
  const slashIdx = rest.indexOf("/");
  if (slashIdx === -1) throw new Error(`Unrecognised uses value: "${uses}"`);
  const extOwner = rest.slice(0, slashIdx);
  const afterOwner = rest.slice(slashIdx + 1); // "repo/.github/workflows/deploy.yml"
  const slashIdx2 = afterOwner.indexOf("/");
  if (slashIdx2 === -1) throw new Error(`Unrecognised uses value: "${uses}"`);
  const extRepo = afterOwner.slice(0, slashIdx2);
  const path = afterOwner.slice(slashIdx2 + 1);
  return { owner: extOwner, repo: extRepo, path, ref };
}

export async function fetchJobs(
  octokit: Octokit,
  owner: string,
  repo: string,
  runId: number,
): Promise<JobTiming[]> {
  const jobs = await octokit.paginate(
    octokit.rest.actions.listJobsForWorkflowRun,
    { owner, repo, run_id: runId, per_page: 100 },
  );
  return jobs
    .filter((j) => j.status === "completed")
    .map((j) => ({
      name: j.name,
      started_at: j.started_at ?? null,
      completed_at: j.completed_at ?? null,
    }));
}

interface QueueEntry {
  owner: string;
  repo: string;
  path: string;
  ref: string;
  rawName: string;
  jobPrefix: string;
  parentUsesValue?: string;
}

export async function fetchAllWorkflowNodes(
  octokit: Octokit,
  owner: string,
  repo: string,
  mainWorkflowName: string,
  mainWorkflowPath: string,
  headSha: string,
): Promise<WorkflowNode[]> {
  const seenNames = new Set<string>();
  // Track visited paths as "owner/repo/path@ref" to prevent cycles
  const visited = new Set<string>();

  const queue: QueueEntry[] = [
    {
      owner,
      repo,
      path: mainWorkflowPath,
      ref: headSha,
      rawName: mainWorkflowName,
      jobPrefix: "",
      parentUsesValue: undefined,
    },
  ];

  const nodes: WorkflowNode[] = [];

  while (queue.length > 0) {
    const entry = queue.shift();
    if (!entry) break;
    const key = `${entry.owner}/${entry.repo}/${entry.path}@${entry.ref}`;
    if (visited.has(key)) continue;
    visited.add(key);

    let workflowYaml: string;
    try {
      workflowYaml = await fetchWorkflowFile(
        octokit,
        entry.owner,
        entry.repo,
        entry.path,
        entry.ref,
      );
    } catch (e) {
      console.warn(
        `Warning: could not fetch reusable workflow ${entry.path}: skipping`,
        e,
      );
      continue;
    }

    // Parse once; reuse for name extraction and child discovery below
    let parsedDoc: unknown = null;
    try {
      parsedDoc = yaml.load(workflowYaml);
    } catch {
      // unparsable YAML: skip name extraction and child discovery
    }
    const doc =
      parsedDoc && typeof parsedDoc === "object" && !Array.isArray(parsedDoc)
        ? (parsedDoc as Record<string, unknown>)
        : null;

    // Determine display name: prefer workflow's own name: field, fall back to rawName
    let rawName = entry.rawName;
    if (doc) {
      const nameField = doc["name"];
      if (typeof nameField === "string" && nameField.trim()) {
        rawName = nameField;
      }
    }

    const name = normaliseWorkflowName(rawName, seenNames);
    nodes.push({
      name,
      yaml: workflowYaml,
      jobPrefix: entry.jobPrefix,
      parentUsesValue: entry.parentUsesValue,
    });

    // Discover child uses references
    if (doc) {
      const rawJobs = doc["jobs"] ?? {};
      if (rawJobs && typeof rawJobs === "object" && !Array.isArray(rawJobs)) {
        for (const [jobId, rawJob] of Object.entries(
          rawJobs as Record<string, unknown>,
        )) {
          if (
            rawJob &&
            typeof rawJob === "object" &&
            !Array.isArray(rawJob) &&
            typeof (rawJob as Record<string, unknown>)["uses"] === "string"
          ) {
            const usesValue = (rawJob as Record<string, unknown>)[
              "uses"
            ] as string;
            let ref: UsesRef;
            try {
              ref = parseUsesRef(usesValue, entry.owner, entry.repo, entry.ref);
            } catch {
              console.warn(
                `Warning: could not parse uses value "${usesValue}": skipping`,
              );
              continue;
            }
            // Derive a fallback name from the filename
            const filename = ref.path.split("/").pop() ?? ref.path;
            const fallbackName = filename.replace(/\.[^.]+$/, "");
            queue.push({
              owner: ref.owner,
              repo: ref.repo,
              path: ref.path,
              ref: ref.ref,
              rawName: fallbackName,
              jobPrefix: `${entry.jobPrefix}${jobId} / `,
              parentUsesValue: usesValue,
            });
          }
        }
      }
    }
  }

  return nodes;
}
