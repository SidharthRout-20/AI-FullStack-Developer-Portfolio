# One repository per product: the plan

Status: names and visibility decided (below); nothing created yet. Creating repositories, moving secrets and changing deployments each need a
go-ahead first.

## Why

Each product gets its own page on GitHub: its own README, stars, issues, releases, CI badge and commit history.
Someone who finds CodeLens on LinkedIn lands on a repository that is only CodeLens, not on a portfolio monorepo. The
portfolio site keeps showing all of them.

## What goes where

| Repository | Contents today | Notes |
| --- | --- | --- |
| `safarnaama` | `products/safarnama/api`, `products/safarnama/web` | Already self-contained: own package, own tests, mounted by the backend and aliased by the frontend. Easiest first. |
| `codelens` | `backend/app/products/{codelens,handover,readiness}.py`, `frontend/src/products/codelens` | Needs a small API package of its own, shaped like Safarnaama's (`codelens/api/src/codelens`), plus its web folder. |
| `tara` | `backend/app/keeper`, `frontend/src/products/keeper`, `android/`, `.github/workflows/tara-*.yml`, `.github/scripts/tara_proposal.py` | The Android build and the voice-edit workflows move with it. |
| `jasoos` | `backend/app/efi`, `frontend/src/products/efi` | Same shape as CodeLens. |
| `appcore` | `packages/py-core` (Python `appcore`), `packages/web-core` (`@appcore/web`) | Shared by every product: versioned and pinned, so a change to it never breaks a product by surprise. |
| this repository | the site, the control room, the in-development products | It keeps composing the products (below). |

## How the portfolio keeps using them

Each product publishes the two things the portfolio imports today:

- **The web app** as an npm package (`@sidharth/safarnaama-web`, published to GitHub Packages), which the site imports
  exactly where it imports `@safarnama/web` now. The Vite alias becomes a normal dependency.
- **The API** as a Python package installed from a git tag
  (`safarnaama @ git+https://github.com/<owner>/safarnaama@v1.2.0#subdirectory=api`), which `backend/app/main.py`
  mounts as it does today. One backend deployment keeps serving every product, so hosting stays free.

A product can later get its own deployment too; the portfolio then links to it instead of embedding it.

## Keeping the history

Each repository starts with that product's full commit history, not a single copy. Built into git, no extra tools, and
without creating local branches:

```bash
# from this repository, for Safarnaama (once the empty GitHub repository exists)
git remote add safarnaama https://github.com/<owner>/safarnaama.git
git push safarnaama "$(git subtree split --prefix=products/safarnama):refs/heads/main"
```

Products spread over several folders (CodeLens, Tara, Jasoos) are first moved into one folder here
(`products/codelens/...`), in a normal pull request, then split the same way.

## Order of work

1. **Safarnaama.** Split, add its own CI (lint, tests, build) and README, publish the web package and tag the API.
   Point the portfolio at the published versions. Delete `products/safarnama` here only after the live site runs on
   them.
2. **`appcore`.** Publish `@appcore/web` and the `appcore` Python package with versions; every product pins one.
3. **CodeLens**, then **Tara** (with the Android workflow and its signing key secret), then **Jasoos**: move into
   `products/<name>`, then split as in step 1.
4. This repository becomes the site plus the in-development products.

Each step is its own pull request and leaves the live site working.

## Costs and limits

- **CI:** GitHub Actions minutes are free and unlimited on standard runners for public repositories. Private ones
  share the account's monthly allowance (2,000 minutes on the free plan), so keep the product repositories public, or
  keep CI light.
- **Hosting:** unchanged while the one backend keeps mounting every product. Separate deployments per product would
  each be a Vercel Hobby project (free) and may hit cold-start and function limits sooner.
- **Database and AI keys:** each repository gets its own secrets (set in its settings, never copied in files). Products
  can keep sharing the same database with separate tables, as they do now.

## Decided (28 Nov 2026)

- **Names** follow the products: `safarnaama`, `codelens`, `tara`, `jasoos`, plus `appcore` for the shared code. A name
  can be changed later on GitHub (Settings → General → Repository name); GitHub keeps redirecting the old web and git
  URLs to the new name until another repository takes the old one, so links in posts keep working.
- **Every repository is public.** Before each one is made public, its history (which the split carries over) is
  checked for secrets and for anything that shouldn't be published, such as client names. Anything found is removed
  from that repository's history before the first push, and any real secret is rotated. Checked on 28 Nov 2026: client names
  appear in this repository's history only in the site's profile settings, the résumé PDF and the redaction code that
  hides them, none of which move to a product repository.
- `git subtree split` follows one folder. For products that first move into `products/<name>`, history from before the
  move stays here unless the split rewrites paths (`git filter-repo --path-rename`), which needs that tool installed.

## Still to decide

- GitHub Packages (free for public packages) or plain git tags for the web packages.
- Whether the frozen products move out too, or stay here until they're finished.
