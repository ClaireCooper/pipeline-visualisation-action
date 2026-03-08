import type { Octokit } from "@octokit/rest" with {
  "resolution-mode": "import",
};

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
