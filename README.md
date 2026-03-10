# pipeline-visualisation-action

Uploads a YAML artifact describing your GitHub Actions workflow run,
for use with [pipeline-visualisation](https://clairecooper.github.io/pipeline-visualisation/).

Supports reusable workflows and matrix jobs.

## Required permissions

```yaml
permissions:
  contents: read
  actions: read
```

## Usage: For a single workflow

Add a job that depends on all other jobs in your workflow:

```yaml
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: echo "build"

  test:
    needs: [build]
    runs-on: ubuntu-latest
    steps:
      - run: echo "test"

  visualise:
    needs: [build, test]
    runs-on: ubuntu-latest
    permissions:
      contents: read
      actions: read
    steps:
      - uses: ClaireCooper/pipeline-visualisation-action@v1
```

## Usage: For many workflows

Create a separate workflow that fires after your target workflow completes.
This requires no changes to your existing workflow:

```yaml
on:
  workflow_run:
    workflows: [CI]
    types: [completed]

jobs:
  visualise:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      actions: read
    steps:
      - uses: ClaireCooper/pipeline-visualisation-action@v1
        with:
          run-id: ${{ github.event.workflow_run.id }}
```

## Inputs

| Input    | Default                | Description                         |
| -------- | ---------------------- | ----------------------------------- |
| `token`  | `${{ github.token }}`  | GitHub token                        |
| `run-id` | `${{ github.run_id }}` | ID of the workflow run to visualise |

## Output

The action uploads a YAML artifact named `<workflow-name>-visualisation.yaml`
(e.g. `my-workflow-visualisation.yaml`). Download it from the workflow run's
artifact list and upload it to the
[pipeline-visualisation](https://github.com/clairecooper/pipeline-visualisation)
editor to see a dependency graph and Gantt chart for the run.

The YAML format looks like this:

```yaml
my-workflow:
  jobs:
    build:
      duration: 45
    test:
      duration: 120
      needs: [build]
    lint:
      duration: 45
      needs: [build]
```

For workflows that call reusable workflows, each reusable workflow appears as
its own top-level section:

```yaml
my-workflow:
  jobs:
    build:
      duration: 45
    deploy:
      uses: deploy-workflow
      needs: [build]

deploy-workflow:
  jobs:
    upload:
      duration: 30
    notify:
      duration: 5
      needs: [upload]
```
