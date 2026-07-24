# Releasing Eyeball packages

The publishing pipeline is ready, but access to the `@eyeball` npm organization and the first npm release are still pending. Do not describe any package as published until a registry release has been verified. The FSL-1.1 text is also still a legal-review placeholder and must be finalized before the first public release, and the placeholder security disclosure channel must be provisioned and tested.

## Public package boundary

| Package | Role | Internal dependency direction |
| --- | --- | --- |
| `@eyeball/core` | Canonical contracts, credentials, and execution seams | Foundation |
| `@eyeball/catalog` | Manifests, auth metadata, and discovery | `core` |
| `@eyeball/toolkits` | Provider adapters | `core` |
| `@eyeball/sdk` | Public TypeScript client | `core`, `catalog` |

`@eyeball/bridge`, `@eyeball/executor`, `@eyeball/mcp-gateway`, `@eyeball/dashboard`, `@eyeball/docs`, and `@eyeball/landing` are private workspaces and are never part of a recursive publish.

The four public packages are a Changesets `fixed` group rather than independent packages. They share canonical contracts and are still pre-1.0, so one coordinated version makes compatibility and support boundaries explicit. This can be reconsidered after the APIs stabilize and the dependency graph can support independent release cadences.

The root and all four public package manifests remain at `0.2.0`, but current `main` contains six pending Changesets that move the fixed public group to `0.3.0`. The protected publish job rejects pending releases, so the generated version PR must be reviewed and merged before current `main` can publish. The original 0.2.0 cut is commit `2fa6fe0`; do not publish the current post-cut source under 0.2.0.

The private repository is pushed at `Kastarter/eyeball`, while the four package `repository` and `homepage` fields still identify `eyeball-ai/eyeball`. The founder must decide whether Kastarter is canonical or a staging push and then align the Git remote, package metadata, release tests, runbooks, and GitHub commands. See [the release decision packet](./RELEASE-DECISION.md).

This source state does not claim a registry release. Publication remains blocked on the version PR, canonical-repository decision, npm organization access and token, final license approval, monitored security disclosure channel, and the protected manual workflow.

## Required GitHub configuration

The `npm` GitHub environment, or the repository if environments are not used, must provide one custom secret:

- `NPM_TOKEN`: an npm automation token authorized to publish every package in the `@eyeball` scope. Keep this unset until the organization, package access, and final license are ready.

No custom GitHub API token is required. `GITHUB_TOKEN` is supplied by Actions and receives `contents: write` plus `pull-requests: write` only in the version-PR job.

The publish job grants `id-token: write` and passes `--provenance`. npm provenance requires the GitHub Actions OIDC context on a GitHub-hosted runner; there is no OIDC secret to create. `NPM_TOKEN` remains the registry-authentication guard in this workflow.

Protect the `npm` environment with required reviewers before adding `NPM_TOKEN`. Manual dispatch also requires the exact confirmation value `publish`.

## Release flow

1. For a future release, add a user-facing intent with `pnpm changeset`; select every directly affected public package and the appropriate semver bump.
2. Push to `main`. `.github/workflows/release.yml` validates Changesets state and fixed-version agreement, then `changesets/action` opens or updates the package-version PR.
3. Review the generated package versions, internal dependency ranges, package changelogs, and release notes. Merge that PR only when the release contents are final.
4. Run the `Release` workflow manually with `confirm=publish`. The publish job refuses to continue while pending changesets remain, then builds the four packages serially, verifies manifests and versions, previews every tarball, and publishes with npm provenance.
5. Verify all four registry entries and provenance attestations before updating documentation to claim npm availability.

Local release checks are deliberately non-publishing:

```sh
export NODE_OPTIONS="--max-old-space-size=2048"
export VITEST_MAX_THREADS=1
pnpm release:build
pnpm test:release
pnpm release:version
pnpm changeset:status
pnpm release:dry-run
```

`pnpm release:dry-run` selects only the four public packages and relies on pnpm to rewrite `workspace:*` ranges to concrete package versions in the generated manifests. Inspect the reported file list and size before every release; each compressed tarball must remain below 2 MiB unless the release review records a specific justification. Source files, tests, TypeScript configuration, and credentials must never be present.
