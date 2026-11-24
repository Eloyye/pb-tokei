# Contributing to pb-tokei

Issues are welcome: bug reports, questions about a stat, footage that breaks something. For anything beyond a small fix, open an issue before a pull request so we can agree on the approach first.

There is no CLA and no sign-off. Under section 5 of the [Apache License 2.0](LICENSE), anything you submit is licensed under the same terms as the project.

## Language and decisions

- Use the [Glossary](GLOSSARY.md)'s terms in code, issues and pull requests: a Rally, not an "exchange"; a Team, not a "pair". Each entry lists the words to avoid.
- Record decisions that should outlast one pull request as an ADR in [docs/adr/](docs/adr/).
- Coding agents start from [AGENTS.md](AGENTS.md), which links the issue-tracker and triage conventions.

## Setup

You need everything in the README's [Prerequisites](README.md#prerequisites). Then:

```bash
uv run pb-tokei dev update
uv run pre-commit install
```

The pre-commit hook runs the Python and front-end checks using the locked tool versions. CI also builds the front end and checks its stamp. The Python checks run on staged Python changes, and the front-end checks run on staged changes under `web/`. `ruff check` runs with `--fix`. The hook also checks that the generated API types are up to date when `web/` or `src/pb_tokei/annotate/` changes.

## Checks

The same checks run in CI (the `checks` workflow) on every pull request and on every push to `main`.

Python:

```bash
uv run ruff format --check
uv run ruff check
uv run ty check
uv run pytest
```

Front end, from `web/`:

```bash
bun run typecheck
bun run lint
bun run fmt:check
bun run test
bun run build
```

## Working on the annotation app

Run the API and the Vite dev server side by side. Vite serves on port 5173 and forwards `/api` to the API on port 8000:

```bash
uv run pb-tokei annotate --no-browser
```

```bash
cd web && bun run dev
```

Then open <http://localhost:5173>. A stale-bundle warning from `annotate` is expected while Vite serves the current front end. The UI's layout, keys and interaction model are specified in [docs/annotation-ui.md](docs/annotation-ui.md).

## Changing the API

The front end's API types in `web/src/api/schema.d.ts` are generated from the FastAPI app. After changing the API, regenerate them from `web/`:

```bash
bun run gen:api
```

CI fails if the committed types don't match the FastAPI schema.

## Pull requests

- Keep each pull request to one issue, and link it (`Closes #N`).
- Pull requests from branches of this repository get an automated Claude review covering correctness, security, maintainability and tests. Pull requests from forks don't, because the workflow needs a repository secret.

## The README screenshot

`docs/images/annotation-app.png` is the Calibrate workspace at 1440×900, on a synthetic court clip, never broadcast footage. To retake it after a UI change:

1. Draw a short clip of court lines with OpenCV.
2. Set up a throwaway Match in a scratch Rally Log, with the clip as its video.
3. Place a few Landmarks.
4. Take the screenshot in Chrome.
