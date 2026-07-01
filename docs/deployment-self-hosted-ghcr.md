# Self-Hosted Runner Deployment with GHCR on Windows

This project can be deployed with a GitHub Actions pipeline that:

1. runs `bun test`
2. builds a Docker image from `Dockerfile`
3. pushes the image to GitHub Container Registry (GHCR)
4. runs a deploy job on your Windows host through a GitHub self-hosted runner
5. pulls the new image and restarts the Compose service

This is the most standard setup for a single Docker host because CI builds an immutable image, and the server only pulls and runs that image.

## Deployment model

- CI/CD entrypoint: `.github/workflows/deploy.yml`
- Container runtime config: `compose.yml`
- Default image tag: `ghcr.io/archie0732/healthy-diet-ai-agent:main`
- Host working directory: GitHub Actions variable `DEPLOY_PATH`
- Runner OS: Windows

## Windows host requirements

Install:

- Docker Desktop with Docker Compose support enabled
- Git for Windows
- GitHub self-hosted runner for Windows

Recommended:

- keep Docker Desktop signed in and running
- run the GitHub runner as a Windows service
Example checks in PowerShell:

```powershell
docker --version
docker compose version
git --version
```

## 2. Add a self-hosted runner

In your GitHub repository:

1. Open `Settings -> Actions -> Runners`
2. Click `New self-hosted runner`
3. Choose Windows x64
4. Follow GitHub's install commands on the deployment host

Keep the runner online as a service so the deploy job can execute automatically after each push to `main`.

## 3. Configure repository settings

Add this repository variable:

- `DEPLOY_PATH`
  Example: `D:\services\healthy-diet-ai-agent`

The workflow clones or updates the repository inside that directory before running Docker Compose.

No extra registry secret is required for same-repository pushes to GHCR because the workflow uses the built-in `GITHUB_TOKEN`. The same token is also used by the deploy job to fetch the repository on the self-hosted runner, so this works for private repositories too.

## 4. Prepare the deployment directory

Create the directory stored in `DEPLOY_PATH`, clone the repository once, then add the production `.env` file there.

Example:

```powershell
New-Item -ItemType Directory -Path 'D:\services\healthy-diet-ai-agent' -Force
git clone https://github.com/archie0732/healthy-diet-ai-agent.git 'D:\services\healthy-diet-ai-agent'
Set-Location 'D:\services\healthy-diet-ai-agent'
Copy-Item .env.example .env
```

Update `.env` with your production values, especially:

- `AI_API_URL`
- `PORT`
- `STORAGE_BACKEND`
- `SQLITE_DB_PATH` or Supabase credentials
- `IMAGE_NAME` if you want to pin a different tag

## 5. Trigger deployment

Push to `main` or run the workflow manually from the Actions tab.

The workflow does this in order:

1. `test` job: `bun install --frozen-lockfile` and `bun test`
2. `build` job: build Docker image and push to `ghcr.io`
3. `deploy` job: on the self-hosted runner
   - `git fetch origin main`
   - `git checkout main`
   - verify `.env` exists
   - `docker compose pull`
   - `docker compose up -d`

## 6. Recommended operational checks

After the first deployment, verify on the host:

```powershell
Set-Location 'D:\services\healthy-diet-ai-agent'
docker compose ps
docker compose logs --tail=100
curl.exe http://127.0.0.1:8001/ping
```

## Notes

- The workflow currently deploys the `main` tag for the default branch.
- `docker image prune -f` is included to clean up unused layers after deployment.
- The deploy job uses `git reset --hard origin/main` inside `DEPLOY_PATH`, so do not keep uncommitted local edits in the deployment checkout.
- If Docker Desktop is not running on the Windows server, the deploy job will fail even if the runner is online.
