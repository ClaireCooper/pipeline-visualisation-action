import { describe, it, expect } from "vitest";
import * as yaml from "js-yaml";
import { buildVisualiserYaml } from "./transform";

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

describe("buildVisualiserYaml", () => {
  it("produces correct YAML with durations and needs", () => {
    const result = buildVisualiserYaml("CI", workflowYaml, jobs);
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
    const result = buildVisualiserYaml("Simple", simpleYaml, [
      {
        name: "only-job",
        started_at: "2024-01-01T00:00:00Z",
        completed_at: "2024-01-01T00:01:00Z",
      },
    ]);
    const parsed = yaml.load(result) as Record<string, unknown>;
    expect(parsed).toEqual({
      Simple: { jobs: { "only-job": { duration: 60 } } },
    });
  });

  it("excludes jobs with no timing entry", () => {
    const result = buildVisualiserYaml("CI", workflowYaml, []);
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
    const result = buildVisualiserYaml("CI", yamlWithJobName, [
      {
        name: "My Build",
        started_at: "2024-01-01T00:00:00Z",
        completed_at: "2024-01-01T00:00:30Z",
      },
    ]);
    const parsed = yaml.load(result) as Record<string, unknown>;
    expect(parsed).toEqual({
      CI: { jobs: { build: { duration: 30 } } },
    });
  });

  it("throws a descriptive error for malformed YAML", () => {
    expect(() => buildVisualiserYaml("CI", "{ invalid: yaml: [", [])).toThrow(
      "Failed to parse workflow YAML",
    );
  });

  it("throws when YAML parses to a non-object", () => {
    expect(() => buildVisualiserYaml("CI", "just a string", [])).toThrow(
      "Workflow YAML must be an object",
    );
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
    const result = buildVisualiserYaml("CI", yamlWithNullJob, [
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
    ]);
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
    const result = buildVisualiserYaml("CI", yamlWithStringNeeds, [
      {
        name: "test",
        started_at: "2024-01-01T00:00:00Z",
        completed_at: "2024-01-01T00:00:10Z",
      },
    ]);
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
    const result = buildVisualiserYaml("CI", yamlNoNameField, [
      {
        name: "build",
        started_at: "2024-01-01T00:00:00Z",
        completed_at: "2024-01-01T00:01:00Z",
      },
    ]);
    const parsed = yaml.load(result) as Record<string, unknown>;
    expect(parsed).toEqual({
      CI: { jobs: { build: { duration: 60 } } },
    });
  });

  it("omits duration when started_at is null on a present timing entry", () => {
    const result = buildVisualiserYaml(
      "CI",
      `
name: CI
jobs:
  build:
    runs-on: ubuntu-latest
`,
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
      "CI",
      `
name: CI
jobs:
  build:
    runs-on: ubuntu-latest
`,
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
      "CI",
      `
name: CI
jobs:
  build:
    runs-on: ubuntu-latest
`,
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

  it("throws when YAML parses to an array", () => {
    expect(() => buildVisualiserYaml("CI", "- a\n- b", [])).toThrow(
      "Workflow YAML must be an object",
    );
  });

  it("throws when YAML is an empty string", () => {
    expect(() => buildVisualiserYaml("CI", "", [])).toThrow(
      "Workflow YAML must be an object",
    );
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
    const result = buildVisualiserYaml("CI", yamlMultiNeeds, [
      {
        name: "test",
        started_at: "2024-01-01T00:00:00Z",
        completed_at: "2024-01-01T00:00:10Z",
      },
    ]);
    const parsed = yaml.load(result) as Record<string, unknown>;
    const testJob = (parsed as { CI: { jobs: { test: { needs: string[] } } } })
      .CI.jobs.test;
    expect(testJob.needs).toEqual(["build", "lint"]);
  });

  it("produces empty jobs map when workflow has no jobs key", () => {
    const result = buildVisualiserYaml("CI", "name: CI\n", []);
    const parsed = yaml.load(result) as Record<string, unknown>;
    expect(parsed).toEqual({ CI: { jobs: {} } });
  });

  it("throws when YAML is the null literal", () => {
    expect(() => buildVisualiserYaml("CI", "null", [])).toThrow(
      "Workflow YAML must be an object",
    );
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
    const result = buildVisualiserYaml("CI", yamlWithName, [
      {
        name: "build",
        started_at: "2024-01-01T00:00:00Z",
        completed_at: "2024-01-01T00:01:00Z",
      },
    ]);
    const parsed = yaml.load(result) as Record<string, unknown>;
    expect(
      (parsed as { CI: { jobs: Record<string, unknown> } }).CI.jobs,
    ).not.toHaveProperty("build");
  });

  it("emits duration: 0 for a job that completes in under 500ms", () => {
    const result = buildVisualiserYaml(
      "CI",
      `
name: CI
jobs:
  build:
    runs-on: ubuntu-latest
`,
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
