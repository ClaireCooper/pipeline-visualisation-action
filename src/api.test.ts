import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  fetchRunDetails,
  fetchWorkflowPath,
  fetchWorkflowFile,
  fetchJobs,
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
        started_at: "2024-01-01T00:00:00Z",
        completed_at: "2024-01-01T00:00:45Z",
      },
      {
        name: "test",
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
      { name: "build", started_at: null, completed_at: null },
    ]);

    const result = await fetchJobs(mockOctokit as never, "owner", "repo", 99);
    expect(result).toEqual([
      { name: "build", started_at: null, completed_at: null },
    ]);
  });

  it("maps undefined started_at and completed_at to null", async () => {
    mockOctokit.paginate.mockResolvedValue([
      { name: "build", started_at: undefined, completed_at: undefined },
    ]);

    const result = await fetchJobs(mockOctokit as never, "owner", "repo", 99);
    expect(result).toEqual([
      { name: "build", started_at: null, completed_at: null },
    ]);
  });
});
