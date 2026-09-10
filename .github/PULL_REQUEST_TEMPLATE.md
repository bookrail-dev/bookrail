## What this changes

One subject per pull request. Describe the behaviour that changes, not the files.

## Why

## How it is tested

The test that fails before this change and passes after it, by name.

## Checklist

- [ ] `pnpm lint && pnpm typecheck && pnpm test && pnpm format:check && pnpm build` is green
- [ ] Every commit is signed off (`git commit -s`), per CONTRIBUTING.md
- [ ] No em dash anywhere: docs, site, CLI and MCP output, errors, source comments, commits
- [ ] Documentation updated in this pull request if the behaviour is documented
- [ ] No new runtime dependency, or one with its reason written above
- [ ] No applied migration was edited; a schema change is a new migration file
