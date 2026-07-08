# Auto-Deploy to Fly.io

This repo auto-deploys to Fly.io on every push to `master`.

## How it works

- `.github/workflows/fly-deploy.yml` — GitHub Actions workflow that builds and deploys on push to `master` (and manually via `workflow_dispatch`).
- `fly.toml` — Fly configuration. The `[build]` section tells Fly to use `Dockerfile`; the `[deploy] release_command` keeps `/data/public/` in sync with the image so the served HTML always matches the deployed code.

## Required GitHub Secret

| Name | Description |
|---|---|
| `FLY_API_TOKEN` | Fly.io API token with deploy permissions. Set it at: https://github.com/dandres96/taskflow/settings/secrets/actions |

To rotate the token:
1. Create a new one at https://fly.io/app/personal/tokens
2. Update the GitHub secret with the new value
3. Revoke the old token

## Required Fly Secrets (recommended)

`fly.toml` currently has `JWT_SECRET` in plain text in `[env]`. Move it to a Fly secret:

```bash
fly secrets set JWT_SECRET="..." --app taskflow-cwti
```

Then remove the line from `fly.toml`.

## Manual deploys

If GitHub Actions is unavailable, you can deploy from your local machine:

```bash
flyctl deploy --app taskflow-cwti --remote-only
```

The `--remote-only` flag tells Fly to build the image on its own infrastructure
(no local Docker required). This requires working DNS to `api.depot.dev`.