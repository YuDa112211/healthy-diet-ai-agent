# GHCR Self-Hosted Deploy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a GitHub Actions deployment flow that tests the project, publishes a Docker image to GHCR, and redeploys the app on a self-hosted runner with Docker Compose.

**Architecture:** Keep CI and CD in GitHub Actions. The default branch builds a versioned container image in GHCR, while the production host runs a self-hosted runner job that pulls the new image and restarts the Compose service from a fixed deployment directory.

**Tech Stack:** GitHub Actions, GHCR, Docker Compose, Bun tests

---

### Task 1: Lock deployment behavior with config tests

**Files:**
- Modify: `src/config/dockerPackaging.test.ts`
- Test: `src/config/dockerPackaging.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
test('compose deploys from a GHCR image instead of building locally', () => {
  const composePath = path.join(ROOT_DIR, 'compose.yml');
  const compose = readFileSync(composePath, 'utf8');

  expect(compose).toMatch(/image:\s+\$\{IMAGE_NAME:-ghcr\.io\/archie0732\/healthy-diet-ai-agent:main\}/);
  expect(compose).toMatch(/pull_policy:\s+always/);
  expect(compose).not.toMatch(/\n\s+build:\n/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/config/dockerPackaging.test.ts`  
Expected: FAIL because `compose.yml` still uses `build:` and `.env.example` has no `IMAGE_NAME`.

- [ ] **Step 3: Add env coverage to the same test file**

```ts
test('env example documents the deployment image override', () => {
  const envExamplePath = path.join(ROOT_DIR, '.env.example');
  const envExample = readFileSync(envExamplePath, 'utf8');

  expect(envExample).toMatch(/IMAGE_NAME=ghcr\.io\/archie0732\/healthy-diet-ai-agent:main/);
});
```

- [ ] **Step 4: Re-run the focused test**

Run: `bun test src/config/dockerPackaging.test.ts`  
Expected: still FAIL until deployment config files are updated.

- [ ] **Step 5: Commit**

```bash
git add src/config/dockerPackaging.test.ts
git commit -m "test: cover ghcr deployment packaging"
```

### Task 2: Switch Compose to registry-based deployment

**Files:**
- Modify: `compose.yml`
- Modify: `.env.example`
- Test: `src/config/dockerPackaging.test.ts`

- [ ] **Step 1: Replace local Docker build with a GHCR image reference**

```yaml
services:
  healthy-diet-ai-agent:
    image: ${IMAGE_NAME:-ghcr.io/archie0732/healthy-diet-ai-agent:main}
    pull_policy: always
    container_name: healthy-diet-ai-agent
```

- [ ] **Step 2: Document image override in the example env file**

```env
IMAGE_NAME=ghcr.io/archie0732/healthy-diet-ai-agent:main
PORT=8001
AI_API_URL=http://host.docker.internal:8080/v1/
```

- [ ] **Step 3: Run the packaging test**

Run: `bun test src/config/dockerPackaging.test.ts`  
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add compose.yml .env.example src/config/dockerPackaging.test.ts
git commit -m "feat: deploy compose from ghcr image"
```

### Task 3: Add GitHub Actions CI/CD workflow

**Files:**
- Create: `.github/workflows/deploy.yml`

- [ ] **Step 1: Add a workflow with test, build, and deploy jobs**

```yaml
name: Deploy

on:
  push:
    branches:
      - main
  workflow_dispatch:

permissions:
  contents: read
  packages: write

concurrency:
  group: deploy-main
  cancel-in-progress: true
```

- [ ] **Step 2: Configure the test job to install Bun and run the full test suite**

```yaml
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
      - run: bun install --frozen-lockfile
      - run: bun test
```

- [ ] **Step 3: Configure the build job to push to GHCR**

```yaml
  build:
    needs: test
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: docker/login-action@v3
      - uses: docker/build-push-action@v6
```

- [ ] **Step 4: Configure the deploy job to update a fixed host directory**

```yaml
  deploy:
    needs: build
    runs-on:
      - self-hosted
      - linux
    steps:
      - name: Sync repository into deployment directory
      - name: Log in to GHCR
      - name: Pull and restart the service
```

- [ ] **Step 5: Commit**

```bash
git add .github/workflows/deploy.yml
git commit -m "feat: add ghcr self-hosted deploy workflow"
```

### Task 4: Document production setup

**Files:**
- Modify: `README.md`
- Create: `docs/deployment-self-hosted-ghcr.md`

- [ ] **Step 1: Add a deployment guide with runner, secrets, and host commands**

```md
# Self-Hosted Runner Deployment with GHCR

1. Add a Linux self-hosted runner to the repository.
2. Install Docker and Docker Compose on the host.
3. Clone the repo into the path stored in the `DEPLOY_PATH` variable.
4. Create `.env` in that directory.
5. Push to `main` to trigger build and deploy.
```

- [ ] **Step 2: Link the guide from README Docker deployment content**

```md
For automated production deployment with GitHub Actions, GHCR, and a self-hosted runner, see:

- `docs/deployment-self-hosted-ghcr.md`
```

- [ ] **Step 3: Run focused verification**

Run: `bun test src/config/dockerPackaging.test.ts`  
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add README.md docs/deployment-self-hosted-ghcr.md
git commit -m "docs: add self-hosted ghcr deployment guide"
```

### Task 5: Final verification

**Files:**
- Modify: `.github/workflows/deploy.yml`
- Modify: `compose.yml`
- Modify: `.env.example`
- Modify: `README.md`
- Modify: `src/config/dockerPackaging.test.ts`
- Create: `docs/deployment-self-hosted-ghcr.md`

- [ ] **Step 1: Run the targeted regression test**

Run: `bun test src/config/dockerPackaging.test.ts`  
Expected: PASS with 0 failures.

- [ ] **Step 2: Run the full test suite**

Run: `bun test`  
Expected: PASS with exit code 0.

- [ ] **Step 3: Inspect the changed files**

Run: `git diff -- .github/workflows/deploy.yml compose.yml .env.example README.md src/config/dockerPackaging.test.ts docs/deployment-self-hosted-ghcr.md`  
Expected: only the intended deployment-related changes appear.

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/deploy.yml compose.yml .env.example README.md src/config/dockerPackaging.test.ts docs/deployment-self-hosted-ghcr.md
git commit -m "feat: automate ghcr deployment with self-hosted runner"
```
