// Shared types and utilities used by both api.ts and transform.ts.
// Extracted here to avoid a circular dependency between those two modules.

export interface WorkflowNode {
  name: string;
  yaml: string;
  jobPrefix: string;
}

export function normaliseWorkflowName(raw: string, seen: Set<string>): string {
  const base =
    raw
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "workflow";
  let candidate = base;
  let n = 2;
  while (seen.has(candidate)) {
    candidate = `${base}-${n++}`;
  }
  seen.add(candidate);
  return candidate;
}
