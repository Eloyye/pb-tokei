# pb-tokei

Statistics on professional side-out-scored doubles pickleball (PPA, APP, MLP), derived from recorded broadcast footage.

- Vocabulary: [GLOSSARY.md](GLOSSARY.md)
- Decisions: [docs/adr/](docs/adr/)

## Development

```bash
uv sync
uv run pre-commit install
```

Checks (also run by the pre-commit hook and in CI):

```bash
uv run ruff format --check
uv run ruff check
uv run ty check
uv run pytest
```
