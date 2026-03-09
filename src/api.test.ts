import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  fetchRunDetails,
  fetchWorkflowPath,
  fetchWorkflowFile,
  fetchJobs,
  parseUsesRef,
  fetchAllWorkflowNodes,
} from "./api";

const mockOctokit = {
  rest: {
    actions: {
      getWorkflowRun: vi.fn(),
      getWorkflow: vi.fn(),
      listJobsForWorkflowRun: vi.fn(),
    },
    repos: {
      getContent: vi.fn(),
    },
  },
  paginate: vi.fn(),
};

beforeEach(() => vi.clearAllMocks());

describe("fetchRunDetails", () => {
  it("returns name, headSha, and workflowId", async () => {
    mockOctokit.rest.actions.getWorkflowRun.mockResolvedValue({
      data: {
        name: "CI",
        head_sha: "abc123",
        workflow_id: 42,
      },
    });

    const result = await fetchRunDetails(
      mockOctokit as never,
      "owner",
      "repo",
      99,
    );
    expect(result).toEqual({ name: "CI", headSha: "abc123", workflowId: 42 });
    expect(mockOctokit.rest.actions.getWorkflowRun).toHaveBeenCalledWith({
      owner: "owner",
      repo: "repo",
      run_id: 99,
    });
  });

  it("falls back to empty string when name is null", async () => {
    mockOctokit.rest.actions.getWorkflowRun.mockResolvedValue({
      data: {
        name: null,
        head_sha: "abc123",
        workflow_id: 42,
      },
    });

    const result = await fetchRunDetails(
      mockOctokit as never,
      "owner",
      "repo",
      99,
    );
    expect(result.name).toBe("");
  });
});

describe("fetchWorkflowPath", () => {
  it("returns the workflow file path", async () => {
    mockOctokit.rest.actions.getWorkflow.mockResolvedValue({
      data: { path: ".github/workflows/ci.yaml" },
    });

    const result = await fetchWorkflowPath(
      mockOctokit as never,
      "owner",
      "repo",
      42,
    );
    expect(result).toBe(".github/workflows/ci.yaml");
    expect(mockOctokit.rest.actions.getWorkflow).toHaveBeenCalledWith({
      owner: "owner",
      repo: "repo",
      workflow_id: 42,
    });
  });
});

describe("fetchWorkflowFile", () => {
  it("decodes base64 file content", async () => {
    const content = Buffer.from("name: CI\njobs: {}\n").toString("base64");
    mockOctokit.rest.repos.getContent.mockResolvedValue({
      data: { type: "file", content, encoding: "base64" },
    });

    const result = await fetchWorkflowFile(
      mockOctokit as never,
      "owner",
      "repo",
      ".github/workflows/ci.yaml",
      "abc123",
    );
    expect(result).toBe("name: CI\njobs: {}\n");
    expect(mockOctokit.rest.repos.getContent).toHaveBeenCalledWith({
      owner: "owner",
      repo: "repo",
      path: ".github/workflows/ci.yaml",
      ref: "abc123",
    });
  });

  it("throws when response is not a file", async () => {
    mockOctokit.rest.repos.getContent.mockResolvedValue({
      data: [{ type: "file", name: "ci.yaml" }],
    });

    await expect(
      fetchWorkflowFile(
        mockOctokit as never,
        "owner",
        "repo",
        ".github/workflows/ci.yaml",
        "abc123",
      ),
    ).rejects.toThrow("Unexpected response fetching");
  });

  it("throws when encoding is not base64", async () => {
    mockOctokit.rest.repos.getContent.mockResolvedValue({
      data: { type: "file", content: "aGVsbG8=", encoding: "utf-8" },
    });

    await expect(
      fetchWorkflowFile(
        mockOctokit as never,
        "owner",
        "repo",
        ".github/workflows/ci.yaml",
        "abc123",
      ),
    ).rejects.toThrow('Unexpected encoding "utf-8" fetching');
  });

  it("throws when response object has content but no encoding field", async () => {
    mockOctokit.rest.repos.getContent.mockResolvedValue({
      data: { type: "file", content: "aGVsbG8=" },
    });

    await expect(
      fetchWorkflowFile(
        mockOctokit as never,
        "owner",
        "repo",
        ".github/workflows/ci.yaml",
        "abc123",
      ),
    ).rejects.toThrow("Unexpected response fetching");
  });

  it("throws when response object has no content field (e.g. submodule)", async () => {
    mockOctokit.rest.repos.getContent.mockResolvedValue({
      data: {
        type: "submodule",
        submodule_git_url: "https://github.com/example/repo",
      },
    });

    await expect(
      fetchWorkflowFile(
        mockOctokit as never,
        "owner",
        "repo",
        ".github/workflows/ci.yaml",
        "abc123",
      ),
    ).rejects.toThrow("Unexpected response fetching");
  });
});

describe("fetchJobs", () => {
  it("returns job timing data for all jobs", async () => {
    mockOctokit.paginate.mockResolvedValue([
      {
        name: "build",
        status: "completed",
        started_at: "2024-01-01T00:00:00Z",
        completed_at: "2024-01-01T00:00:45Z",
      },
      {
        name: "test",
        status: "completed",
        started_at: "2024-01-01T00:00:45Z",
        completed_at: "2024-01-01T00:02:45Z",
      },
    ]);

    const result = await fetchJobs(mockOctokit as never, "owner", "repo", 99);
    expect(result).toEqual([
      {
        name: "build",
        started_at: "2024-01-01T00:00:00Z",
        completed_at: "2024-01-01T00:00:45Z",
      },
      {
        name: "test",
        started_at: "2024-01-01T00:00:45Z",
        completed_at: "2024-01-01T00:02:45Z",
      },
    ]);
    expect(mockOctokit.paginate).toHaveBeenCalledWith(
      mockOctokit.rest.actions.listJobsForWorkflowRun,
      { owner: "owner", repo: "repo", run_id: 99, per_page: 100 },
    );
  });

  it("maps null started_at and completed_at to null", async () => {
    mockOctokit.paginate.mockResolvedValue([
      {
        name: "build",
        status: "completed",
        started_at: null,
        completed_at: null,
      },
    ]);

    const result = await fetchJobs(mockOctokit as never, "owner", "repo", 99);
    expect(result).toEqual([
      { name: "build", started_at: null, completed_at: null },
    ]);
  });

  it("maps undefined started_at and completed_at to null", async () => {
    mockOctokit.paginate.mockResolvedValue([
      {
        name: "build",
        status: "completed",
        started_at: undefined,
        completed_at: undefined,
      },
    ]);

    const result = await fetchJobs(mockOctokit as never, "owner", "repo", 99);
    expect(result).toEqual([
      { name: "build", started_at: null, completed_at: null },
    ]);
  });

  it("excludes jobs that are not yet completed", async () => {
    mockOctokit.paginate.mockResolvedValue([
      {
        name: "build",
        status: "completed",
        started_at: "2024-01-01T00:00:00Z",
        completed_at: "2024-01-01T00:00:45Z",
      },
      {
        name: "deploy",
        status: "in_progress",
        started_at: "2024-01-01T00:00:45Z",
        completed_at: null,
      },
    ]);

    const result = await fetchJobs(mockOctokit as never, "owner", "repo", 99);
    expect(result).toEqual([
      {
        name: "build",
        started_at: "2024-01-01T00:00:00Z",
        completed_at: "2024-01-01T00:00:45Z",
      },
    ]);
  });
});

describe("parseUsesRef", () => {
  it("parses a local uses reference", () => {
    const result = parseUsesRef(
      "./.github/workflows/deploy.yml",
      "myorg",
      "myrepo",
      "abc123",
    );
    expect(result).toEqual({
      owner: "myorg",
      repo: "myrepo",
      path: ".github/workflows/deploy.yml",
      ref: "abc123",
    });
  });

  it("parses an external uses reference", () => {
    const result = parseUsesRef(
      "otherorg/otherrepo/.github/workflows/deploy.yml@v2",
      "myorg",
      "myrepo",
      "abc123",
    );
    expect(result).toEqual({
      owner: "otherorg",
      repo: "otherrepo",
      path: ".github/workflows/deploy.yml",
      ref: "v2",
    });
  });

  it("throws for an unrecognised format", () => {
    expect(() =>
      parseUsesRef("not-a-valid-ref", "myorg", "myrepo", "abc123"),
    ).toThrow("Unrecognised uses");
  });
});

describe("fetchAllWorkflowNodes", () => {
  const mainYaml = Buffer.from(
    `
name: CI
jobs:
  build:
    runs-on: ubuntu-latest
  deploy:
    uses: ./.github/workflows/deploy.yml
    needs: [build]
`,
  ).toString("base64");

  const deployYaml = Buffer.from(
    `
name: Deploy
jobs:
  deploy-a:
    runs-on: ubuntu-latest
  deploy-b:
    runs-on: ubuntu-latest
`,
  ).toString("base64");

  beforeEach(() => {
    mockOctokit.rest.repos.getContent.mockImplementation(
      ({ path }: { path: string }) => {
        if (path === ".github/workflows/ci.yml") {
          return Promise.resolve({
            data: { content: mainYaml, encoding: "base64" },
          });
        }
        if (path === ".github/workflows/deploy.yml") {
          return Promise.resolve({
            data: { content: deployYaml, encoding: "base64" },
          });
        }
        return Promise.reject(new Error(`Unexpected path: ${path}`));
      },
    );
  });

  it("returns the main workflow node plus all reusable workflow nodes", async () => {
    const nodes = await fetchAllWorkflowNodes(
      mockOctokit as never,
      "myorg",
      "myrepo",
      "ci",
      ".github/workflows/ci.yml",
      "abc123",
    );
    expect(nodes).toHaveLength(2);
    expect(nodes[0].name).toBe("ci");
    expect(nodes[0].jobPrefix).toBe("");
    expect(nodes[1].name).toBe("deploy");
    expect(nodes[1].jobPrefix).toBe("deploy / ");
    expect(nodes[1].parentUsesValue).toBe("./.github/workflows/deploy.yml");
  });

  it("does not fetch the same workflow twice (cycle/dedup protection)", async () => {
    // deploy.yml references itself
    const selfRefYaml = Buffer.from(
      `
name: Deploy
jobs:
  deploy-a:
    uses: ./.github/workflows/deploy.yml
`,
    ).toString("base64");
    mockOctokit.rest.repos.getContent.mockImplementation(
      ({ path }: { path: string }) => {
        if (path === ".github/workflows/ci.yml") {
          return Promise.resolve({
            data: { content: mainYaml, encoding: "base64" },
          });
        }
        if (path === ".github/workflows/deploy.yml") {
          return Promise.resolve({
            data: { content: selfRefYaml, encoding: "base64" },
          });
        }
        return Promise.reject(new Error(`Unexpected path: ${path}`));
      },
    );
    const nodes = await fetchAllWorkflowNodes(
      mockOctokit as never,
      "myorg",
      "myrepo",
      "ci",
      ".github/workflows/ci.yml",
      "abc123",
    );
    // Should not recurse infinitely; deploy appears once
    expect(nodes.filter((n) => n.name === "deploy")).toHaveLength(1);
  });

  it("skips a reusable workflow when fetch fails and logs a warning", async () => {
    mockOctokit.rest.repos.getContent.mockImplementation(
      ({ path }: { path: string }) => {
        if (path === ".github/workflows/ci.yml") {
          return Promise.resolve({
            data: { content: mainYaml, encoding: "base64" },
          });
        }
        return Promise.reject(new Error("Not found"));
      },
    );
    const warnSpy = vi.spyOn(console, "warn").mockReturnValue(undefined);
    const nodes = await fetchAllWorkflowNodes(
      mockOctokit as never,
      "myorg",
      "myrepo",
      "ci",
      ".github/workflows/ci.yml",
      "abc123",
    );
    expect(nodes).toHaveLength(1);
    expect(nodes[0].name).toBe("ci");
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("deploy.yml"),
      expect.any(Error),
    );
    warnSpy.mockRestore();
  });

  it("prefers the name: field in the root workflow YAML over the caller-supplied name", async () => {
    // mainYaml already has name: CI; pass a different name as mainWorkflowName
    const nodes = await fetchAllWorkflowNodes(
      mockOctokit as never,
      "myorg",
      "myrepo",
      "something-else",
      ".github/workflows/ci.yml",
      "abc123",
    );
    expect(nodes[0].name).toBe("ci");
  });

  it("normalises workflow names and deduplicates", async () => {
    // Two different files both named "Deploy"
    const deploy2Yaml = Buffer.from(
      `
name: Deploy
jobs:
  step:
    runs-on: ubuntu-latest
`,
    ).toString("base64");
    const mainWithTwo = Buffer.from(
      `
name: CI
jobs:
  deploy1:
    uses: ./.github/workflows/deploy.yml
  deploy2:
    uses: ./.github/workflows/deploy2.yml
`,
    ).toString("base64");
    mockOctokit.rest.repos.getContent.mockImplementation(
      ({ path }: { path: string }) => {
        if (path === ".github/workflows/ci.yml")
          return Promise.resolve({
            data: { content: mainWithTwo, encoding: "base64" },
          });
        if (path === ".github/workflows/deploy.yml")
          return Promise.resolve({
            data: { content: deployYaml, encoding: "base64" },
          });
        if (path === ".github/workflows/deploy2.yml")
          return Promise.resolve({
            data: { content: deploy2Yaml, encoding: "base64" },
          });
        return Promise.reject(new Error(`Unexpected path: ${path}`));
      },
    );
    const nodes = await fetchAllWorkflowNodes(
      mockOctokit as never,
      "myorg",
      "myrepo",
      "ci",
      ".github/workflows/ci.yml",
      "abc123",
    );
    expect(nodes[1].name).toBe("deploy");
    expect(nodes[2].name).toBe("deploy-2");
  });

  it("handles a workflow whose YAML is unparsable — uses filename as name and discovers no children", async () => {
    const badYaml = Buffer.from("{ not: valid: yaml: [").toString("base64");
    mockOctokit.rest.repos.getContent.mockImplementation(
      ({ path }: { path: string }) => {
        if (path === ".github/workflows/ci.yml") {
          return Promise.resolve({
            data: { content: badYaml, encoding: "base64" },
          });
        }
        return Promise.reject(new Error(`Unexpected path: ${path}`));
      },
    );
    const nodes = await fetchAllWorkflowNodes(
      mockOctokit as never,
      "myorg",
      "myrepo",
      "ci",
      ".github/workflows/ci.yml",
      "abc123",
    );
    expect(nodes).toHaveLength(1);
    expect(nodes[0].name).toBe("ci"); // falls back to rawName when YAML is unparsable
    expect(nodes[0].jobPrefix).toBe("");
  });
});
