import { describe, it, expect } from "vitest";
import * as yaml from "js-yaml";
import {
  buildVisualiserYaml,
  normaliseWorkflowName,
  WorkflowNode,
} from "./transform";

describe("normaliseWorkflowName", () => {
  it("lowercases and hyphenates spaces", () => {
    const seen = new Set<string>();
    expect(normaliseWorkflowName("My Deploy Workflow", seen)).toBe(
      "my-deploy-workflow",
    );
  });

  it("replaces underscores with hyphens", () => {
    const seen = new Set<string>();
    expect(normaliseWorkflowName("deploy_production", seen)).toBe(
      "deploy-production",
    );
  });

  it("collapses multiple separators", () => {
    const seen = new Set<string>();
    expect(normaliseWorkflowName("deploy  --  prod", seen)).toBe("deploy-prod");
  });

  it("trims leading and trailing hyphens", () => {
    const seen = new Set<string>();
    expect(normaliseWorkflowName("  deploy  ", seen)).toBe("deploy");
  });

  it("deduplicates by appending -2, -3", () => {
    const seen = new Set<string>(["deploy"]);
    expect(normaliseWorkflowName("deploy", seen)).toBe("deploy-2");
  });

  it("increments suffix until unique", () => {
    const seen = new Set<string>(["deploy", "deploy-2"]);
    expect(normaliseWorkflowName("deploy", seen)).toBe("deploy-3");
  });

  it("adds the result to the seen set", () => {
    const seen = new Set<string>();
    normaliseWorkflowName("deploy", seen);
    expect(seen.has("deploy")).toBe(true);
  });

  it("falls back to 'workflow' when input contains only special characters", () => {
    const seen = new Set<string>();
    expect(normaliseWorkflowName("---", seen)).toBe("workflow");
  });
});

const workflowYaml = `
name: CI
jobs:
  build:
    runs-on: ubuntu-latest
  test:
    needs: [build]
    runs-on: ubuntu-latest
  lint:
    needs: [build]
    runs-on: ubuntu-latest
`;

const jobs = [
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
  {
    name: "lint",
    started_at: "2024-01-01T00:00:45Z",
    completed_at: "2024-01-01T00:01:30Z",
  },
];

const ciNode: WorkflowNode = { name: "CI", yaml: workflowYaml, jobPrefix: "" };

describe("buildVisualiserYaml", () => {
  it("produces correct YAML with durations and needs", () => {
    const result = buildVisualiserYaml([ciNode], jobs);
    const parsed = yaml.load(result) as Record<string, unknown>;
    expect(parsed).toEqual({
      CI: {
        jobs: {
          build: { duration: 45 },
          test: { duration: 120, needs: ["build"] },
          lint: { duration: 45, needs: ["build"] },
        },
      },
    });
  });

  it("omits needs when a job has none", () => {
    const simpleYaml = `
name: Simple
jobs:
  only-job:
    runs-on: ubuntu-latest
`;
    const result = buildVisualiserYaml(
      [{ name: "Simple", yaml: simpleYaml, jobPrefix: "" }],
      [
        {
          name: "only-job",
          started_at: "2024-01-01T00:00:00Z",
          completed_at: "2024-01-01T00:01:00Z",
        },
      ],
    );
    const parsed = yaml.load(result) as Record<string, unknown>;
    expect(parsed).toEqual({
      Simple: { jobs: { "only-job": { duration: 60 } } },
    });
  });

  it("excludes jobs with no timing entry", () => {
    const result = buildVisualiserYaml([ciNode], []);
    const parsed = yaml.load(result) as Record<string, unknown>;
    const ciJobs = (parsed as { CI: { jobs: Record<string, unknown> } }).CI
      .jobs;
    expect(ciJobs).toEqual({});
  });

  it("matches timing by explicit job name field when present", () => {
    const yamlWithJobName = `
name: CI
jobs:
  build:
    name: My Build
    runs-on: ubuntu-latest
`;
    const result = buildVisualiserYaml(
      [{ name: "CI", yaml: yamlWithJobName, jobPrefix: "" }],
      [
        {
          name: "My Build",
          started_at: "2024-01-01T00:00:00Z",
          completed_at: "2024-01-01T00:00:30Z",
        },
      ],
    );
    const parsed = yaml.load(result) as Record<string, unknown>;
    expect(parsed).toEqual({
      CI: { jobs: { build: { duration: 30 } } },
    });
  });

  it("throws a descriptive error for malformed YAML", () => {
    expect(() =>
      buildVisualiserYaml(
        [{ name: "CI", yaml: "{ invalid: yaml: [", jobPrefix: "" }],
        [],
      ),
    ).toThrow("Failed to parse workflow YAML");
  });

  it("throws when YAML parses to a non-object", () => {
    expect(() =>
      buildVisualiserYaml(
        [{ name: "CI", yaml: "just a string", jobPrefix: "" }],
        [],
      ),
    ).toThrow("Workflow YAML must be an object");
  });

  it("handles a job with no body (null job entry)", () => {
    const yamlWithNullJob = `
name: CI
jobs:
  build:
  test:
    needs: [build]
    runs-on: ubuntu-latest
`;
    const result = buildVisualiserYaml(
      [{ name: "CI", yaml: yamlWithNullJob, jobPrefix: "" }],
      [
        {
          name: "build",
          started_at: "2024-01-01T00:00:00Z",
          completed_at: "2024-01-01T00:00:10Z",
        },
        {
          name: "test",
          started_at: "2024-01-01T00:00:10Z",
          completed_at: "2024-01-01T00:00:20Z",
        },
      ],
    );
    const parsed = yaml.load(result) as Record<string, unknown>;
    expect(parsed).toEqual({
      CI: {
        jobs: {
          build: { duration: 10 },
          test: { duration: 10, needs: ["build"] },
        },
      },
    });
  });

  it("normalises needs to array when written as a string", () => {
    const yamlWithStringNeeds = `
name: CI
jobs:
  build:
    runs-on: ubuntu-latest
  test:
    needs: build
    runs-on: ubuntu-latest
`;
    const result = buildVisualiserYaml(
      [{ name: "CI", yaml: yamlWithStringNeeds, jobPrefix: "" }],
      [
        {
          name: "test",
          started_at: "2024-01-01T00:00:00Z",
          completed_at: "2024-01-01T00:00:10Z",
        },
      ],
    );
    const parsed = yaml.load(result) as Record<string, unknown>;
    const testJob = (parsed as { CI: { jobs: { test: { needs: string[] } } } })
      .CI.jobs.test;
    expect(testJob.needs).toEqual(["build"]);
  });

  it("matches timing by job key when no explicit name field is set", () => {
    // Exercises the fallback path: no name: field in YAML, lookup uses job key
    const yamlNoNameField = `
name: CI
jobs:
  build:
    runs-on: ubuntu-latest
`;
    const result = buildVisualiserYaml(
      [{ name: "CI", yaml: yamlNoNameField, jobPrefix: "" }],
      [
        {
          name: "build",
          started_at: "2024-01-01T00:00:00Z",
          completed_at: "2024-01-01T00:01:00Z",
        },
      ],
    );
    const parsed = yaml.load(result) as Record<string, unknown>;
    expect(parsed).toEqual({
      CI: { jobs: { build: { duration: 60 } } },
    });
  });

  it("omits duration when started_at is null on a present timing entry", () => {
    const result = buildVisualiserYaml(
      [
        {
          name: "CI",
          yaml: `
name: CI
jobs:
  build:
    runs-on: ubuntu-latest
`,
          jobPrefix: "",
        },
      ],
      [
        {
          name: "build",
          started_at: null,
          completed_at: "2024-01-01T00:01:00Z",
        },
      ],
    );
    const parsed = yaml.load(result) as Record<string, unknown>;
    expect(
      (parsed as { CI: { jobs: { build: unknown } } }).CI.jobs.build,
    ).toEqual({});
  });

  it("omits duration when completed_at is null on a present timing entry", () => {
    const result = buildVisualiserYaml(
      [
        {
          name: "CI",
          yaml: `
name: CI
jobs:
  build:
    runs-on: ubuntu-latest
`,
          jobPrefix: "",
        },
      ],
      [
        {
          name: "build",
          started_at: "2024-01-01T00:00:00Z",
          completed_at: null,
        },
      ],
    );
    const parsed = yaml.load(result) as Record<string, unknown>;
    expect(
      (parsed as { CI: { jobs: { build: unknown } } }).CI.jobs.build,
    ).toEqual({});
  });

  it("omits duration when completed_at is before started_at", () => {
    const result = buildVisualiserYaml(
      [
        {
          name: "CI",
          yaml: `
name: CI
jobs:
  build:
    runs-on: ubuntu-latest
`,
          jobPrefix: "",
        },
      ],
      [
        {
          name: "build",
          started_at: "2024-01-01T00:01:00Z",
          completed_at: "2024-01-01T00:00:00Z",
        },
      ],
    );
    const parsed = yaml.load(result) as Record<string, unknown>;
    expect(
      (parsed as { CI: { jobs: { build: unknown } } }).CI.jobs.build,
    ).toEqual({});
  });

  it("throws when YAML is an array", () => {
    expect(() =>
      buildVisualiserYaml(
        [{ name: "CI", yaml: "- a\n- b", jobPrefix: "" }],
        [],
      ),
    ).toThrow("Workflow YAML must be an object");
  });

  it("throws when YAML is an empty string", () => {
    expect(() =>
      buildVisualiserYaml([{ name: "CI", yaml: "", jobPrefix: "" }], []),
    ).toThrow("Workflow YAML must be an object");
  });

  it("preserves multi-element needs array", () => {
    const yamlMultiNeeds = `
name: CI
jobs:
  build:
    runs-on: ubuntu-latest
  lint:
    runs-on: ubuntu-latest
  test:
    needs: [build, lint]
    runs-on: ubuntu-latest
`;
    const result = buildVisualiserYaml(
      [{ name: "CI", yaml: yamlMultiNeeds, jobPrefix: "" }],
      [
        {
          name: "test",
          started_at: "2024-01-01T00:00:00Z",
          completed_at: "2024-01-01T00:00:10Z",
        },
      ],
    );
    const parsed = yaml.load(result) as Record<string, unknown>;
    const testJob = (parsed as { CI: { jobs: { test: { needs: string[] } } } })
      .CI.jobs.test;
    expect(testJob.needs).toEqual(["build", "lint"]);
  });

  it("produces empty jobs map when workflow has no jobs key", () => {
    const result = buildVisualiserYaml(
      [{ name: "CI", yaml: "name: CI\n", jobPrefix: "" }],
      [],
    );
    const parsed = yaml.load(result) as Record<string, unknown>;
    expect(parsed).toEqual({ CI: { jobs: {} } });
  });

  it("throws when YAML is the null literal", () => {
    expect(() =>
      buildVisualiserYaml([{ name: "CI", yaml: "null", jobPrefix: "" }], []),
    ).toThrow("Workflow YAML must be an object");
  });

  it("does not fall back to job key when explicit name field is present", () => {
    // Job key is "build", name field is "My Build"
    // Timing entry uses the job key "build" — should NOT match
    const yamlWithName = `
name: CI
jobs:
  build:
    name: My Build
    runs-on: ubuntu-latest
`;
    const result = buildVisualiserYaml(
      [{ name: "CI", yaml: yamlWithName, jobPrefix: "" }],
      [
        {
          name: "build",
          started_at: "2024-01-01T00:00:00Z",
          completed_at: "2024-01-01T00:01:00Z",
        },
      ],
    );
    const parsed = yaml.load(result) as Record<string, unknown>;
    expect(
      (parsed as { CI: { jobs: Record<string, unknown> } }).CI.jobs,
    ).not.toHaveProperty("build");
  });

  it("emits correct duration for a job that takes longer than a minute", () => {
    const result = buildVisualiserYaml(
      [ciNode],
      [
        {
          name: "build",
          started_at: "2024-01-01T00:00:00Z",
          completed_at: "2024-01-01T00:03:45Z",
        },
      ],
    );
    const parsed = yaml.load(result) as Record<string, unknown>;
    expect(
      (parsed as { CI: { jobs: { build: { duration: number } } } }).CI.jobs
        .build,
    ).toEqual({ duration: 225 });
  });

  it("emits correct duration for a job that takes longer than an hour", () => {
    const result = buildVisualiserYaml(
      [ciNode],
      [
        {
          name: "build",
          started_at: "2024-01-01T00:00:00Z",
          completed_at: "2024-01-01T02:34:56Z",
        },
      ],
    );
    const parsed = yaml.load(result) as Record<string, unknown>;
    expect(
      (parsed as { CI: { jobs: { build: { duration: number } } } }).CI.jobs
        .build,
    ).toEqual({ duration: 9296 });
  });

  it("ignores steps within jobs", () => {
    const yamlWithSteps = `
name: CI
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: npm ci
      - run: npm test
`;
    const result = buildVisualiserYaml(
      [{ name: "CI", yaml: yamlWithSteps, jobPrefix: "" }],
      [
        {
          name: "build",
          started_at: "2024-01-01T00:00:00Z",
          completed_at: "2024-01-01T00:01:00Z",
        },
      ],
    );
    const parsed = yaml.load(result) as Record<string, unknown>;
    expect(parsed).toEqual({ CI: { jobs: { build: { duration: 60 } } } });
  });

  it("emits each matrix variant as a separate job inheriting needs", () => {
    const matrixYaml = `
name: CI
jobs:
  build:
    runs-on: ubuntu-latest
  test:
    needs: [build]
    strategy:
      matrix:
        node: [18, 20]
    runs-on: ubuntu-latest
`;
    const result = buildVisualiserYaml(
      [{ name: "CI", yaml: matrixYaml, jobPrefix: "" }],
      [
        {
          name: "build",
          started_at: "2024-01-01T00:00:00Z",
          completed_at: "2024-01-01T00:00:30Z",
        },
        {
          name: "test (18)",
          started_at: "2024-01-01T00:00:30Z",
          completed_at: "2024-01-01T00:01:00Z",
        },
        {
          name: "test (20)",
          started_at: "2024-01-01T00:00:30Z",
          completed_at: "2024-01-01T00:01:30Z",
        },
      ],
    );
    const parsed = yaml.load(result) as Record<string, unknown>;
    expect(parsed).toEqual({
      CI: {
        jobs: {
          build: { duration: 30 },
          "test (18)": { duration: 30, needs: ["build"] },
          "test (20)": { duration: 60, needs: ["build"] },
        },
      },
    });
  });

  it("emits duration: 0 for a job that completes in under 500ms", () => {
    const result = buildVisualiserYaml(
      [
        {
          name: "CI",
          yaml: `
name: CI
jobs:
  build:
    runs-on: ubuntu-latest
`,
          jobPrefix: "",
        },
      ],
      [
        {
          name: "build",
          started_at: "2024-01-01T00:00:00.000Z",
          completed_at: "2024-01-01T00:00:00.300Z",
        },
      ],
    );
    const parsed = yaml.load(result) as Record<string, unknown>;
    expect(
      (parsed as { CI: { jobs: { build: { duration: number } } } }).CI.jobs
        .build,
    ).toEqual({ duration: 0 });
  });
});

describe("buildVisualiserYaml with reusable workflows", () => {
  const mainYaml = `
name: CI
jobs:
  build:
    runs-on: ubuntu-latest
  deploy:
    uses: ./.github/workflows/deploy.yml
    needs: [build]
`;

  const deployYaml = `
name: Deploy
jobs:
  deploy-a:
    runs-on: ubuntu-latest
  deploy-b:
    runs-on: ubuntu-latest
`;

  const workflows: WorkflowNode[] = [
    { name: "ci", yaml: mainYaml, jobPrefix: "" },
    {
      name: "deploy",
      yaml: deployYaml,
      jobPrefix: "deploy / ",
      parentUsesValue: "./.github/workflows/deploy.yml",
    },
  ];

  const jobs = [
    {
      name: "build",
      started_at: "2024-01-01T00:00:00Z",
      completed_at: "2024-01-01T00:00:30Z",
    },
    {
      name: "deploy / deploy-a",
      started_at: "2024-01-01T00:00:30Z",
      completed_at: "2024-01-01T00:01:00Z",
    },
    {
      name: "deploy / deploy-b",
      started_at: "2024-01-01T00:00:30Z",
      completed_at: "2024-01-01T00:02:00Z",
    },
  ];

  it("emits uses: <name> for reusable workflow jobs in caller", () => {
    const result = buildVisualiserYaml(workflows, jobs);
    const parsed = yaml.load(result) as Record<string, unknown>;
    const deployJob = (
      parsed as {
        ci: { jobs: { deploy: { uses: string; needs: string[] } } };
      }
    ).ci.jobs.deploy;
    expect(deployJob).toEqual({ uses: "deploy", needs: ["build"] });
  });

  it("emits correct timings for reusable workflow jobs using prefix", () => {
    const result = buildVisualiserYaml(workflows, jobs);
    const parsed = yaml.load(result) as Record<string, unknown>;
    const deployJobs = (
      parsed as {
        deploy: { jobs: Record<string, unknown> };
      }
    ).deploy.jobs;
    expect(deployJobs).toEqual({
      "deploy-a": { duration: 30 },
      "deploy-b": { duration: 90 },
    });
  });

  it("omits uses job when the referenced workflow is not in the node list", () => {
    const mainOnly: WorkflowNode[] = [
      { name: "ci", yaml: mainYaml, jobPrefix: "" },
    ];
    const result = buildVisualiserYaml(mainOnly, jobs);
    const parsed = yaml.load(result) as Record<string, unknown>;
    const ciJobs = (parsed as { ci: { jobs: Record<string, unknown> } }).ci
      .jobs;
    expect(ciJobs).not.toHaveProperty("deploy");
  });

  it("handles deeply nested reusable workflows with chained prefixes", () => {
    const subYaml = `
name: Sub
jobs:
  sub-job:
    runs-on: ubuntu-latest
`;
    const nestedWorkflows: WorkflowNode[] = [
      { name: "ci", yaml: mainYaml, jobPrefix: "" },
      {
        name: "deploy",
        yaml: `
name: Deploy
jobs:
  deploy-a:
    uses: ./.github/workflows/sub.yml
`,
        jobPrefix: "deploy / ",
        parentUsesValue: "./.github/workflows/deploy.yml",
      },
      {
        name: "sub",
        yaml: subYaml,
        jobPrefix: "deploy / deploy-a / ",
        parentUsesValue: "./.github/workflows/sub.yml",
      },
    ];
    const nestedJobs = [
      {
        name: "build",
        started_at: "2024-01-01T00:00:00Z",
        completed_at: "2024-01-01T00:00:10Z",
      },
      {
        name: "deploy / deploy-a / sub-job",
        started_at: "2024-01-01T00:00:10Z",
        completed_at: "2024-01-01T00:00:20Z",
      },
    ];
    const result = buildVisualiserYaml(nestedWorkflows, nestedJobs);
    const parsed = yaml.load(result) as Record<string, unknown>;
    const subJobs = (parsed as { sub: { jobs: Record<string, unknown> } }).sub
      .jobs;
    expect(subJobs).toEqual({ "sub-job": { duration: 10 } });
  });
});
