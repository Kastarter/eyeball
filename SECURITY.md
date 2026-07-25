# Security policy

## Reporting a vulnerability

**Do not open a public issue for a security vulnerability.**

Report privately through GitHub's
[private vulnerability reporting](https://github.com/Kastarter/eyeball/security/advisories/new)
("Report a vulnerability" under the repository's **Security** tab). Include the
affected version/commit, a description, and the smallest reproduction you can.

We aim to acknowledge a report within a few business days and will coordinate a
fix and disclosure timeline with you. Please give us a reasonable window to
remediate before any public disclosure.

## Scope

This policy covers the open-source `eyeball` repository. The hosted Cloud
control plane is a separate private system.

## Threat model & findings register

The detailed threat model, security guarantees (each pointing at its enforcing
test), and the tracked findings register live in
[docs/SECURITY.md](./docs/SECURITY.md). Open items there are known engineering
gates with severities and estimates — not surprises.
