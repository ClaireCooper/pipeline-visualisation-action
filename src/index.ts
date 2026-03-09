import * as core from "@actions/core";
import { DefaultArtifactClient } from "@actions/artifact";
import * as os from "os";
import * as path from "path";
import * as fs from "fs";
import {
  fetchRunDetails,
  fetchWorkflowPath,
  fetchAllWorkflowNodes,
  fetchJobs,
} from "./api";
import { buildVisualiserYaml } from "./transform";

async function run(): Promise<void> {
  const token = core.getInput("token", { required: true });
  const runId = parseInt(core.getInput("run-id", { required: true }), 10);
  if (isNaN(runId)) {
    throw new Error(
      `run-id must be a valid integer, got: ${core.getInput("run-id")}`,
    );
  }
  const artifactName = core.getInput("artifact-name", { required: true });

  const [owner, repo] = (process.env["GITHUB_REPOSITORY"] ?? "").split("/");
  if (!owner || !repo) {
    throw new Error("GITHUB_REPOSITORY must be in owner/repo format");
  }

  const { Octokit } = await import("@octokit/rest");
  const octokit = new Octokit({ auth: token });

  core.info(`Fetching run details for run ${runId}...`);
  const { name, headSha, workflowId } = await fetchRunDetails(
    octokit,
    owner,
    repo,
    runId,
  );

  core.info(`Fetching workflow path for workflow ${workflowId}...`);
  const workflowPath = await fetchWorkflowPath(
    octokit,
    owner,
    repo,
    workflowId,
  );

  core.info(`Fetching workflow nodes (including reusable workflows)...`);
  const workflowNodes = await fetchAllWorkflowNodes(
    octokit,
    owner,
    repo,
    name,
    workflowPath,
    headSha,
  );

  if (workflowNodes.length === 0) {
    throw new Error(
      `Failed to fetch workflow file for run ${runId}. Check the action logs above for details.`,
    );
  }

  core.info(`Fetching job timings...`);
  const jobs = await fetchJobs(octokit, owner, repo, runId);

  core.info(`Building visualiser YAML...`);
  const visualisationYaml = buildVisualiserYaml(workflowNodes, jobs);

  const tmpDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "pipeline-visualisation-"),
  );
  const outFile = path.join(tmpDir, "pipeline-visualisation.yaml");
  fs.writeFileSync(outFile, visualisationYaml, "utf-8");

  core.info(`Uploading artifact "${artifactName}"...`);
  const client = new DefaultArtifactClient();
  await client.uploadArtifact(artifactName, [outFile], tmpDir);

  core.info("Done.");
}

run().catch((err: unknown) => {
  core.setFailed(err instanceof Error ? err.message : String(err));
});
