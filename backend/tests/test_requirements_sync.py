"""The repo-root requirements.txt (used by Vercel) must list exactly the backend's dependencies."""

from pathlib import Path

BACKEND = Path(__file__).resolve().parents[1]


def _requirements(path: Path) -> list[str]:
    lines = (line.split("#", 1)[0].strip() for line in path.read_text(encoding="utf-8").splitlines())
    return sorted(line for line in lines if line)


def test_root_requirements_mirror_backend() -> None:
    root = BACKEND.parent / "requirements.txt"
    assert _requirements(root) == _requirements(BACKEND / "requirements.txt"), (
        "requirements.txt at the repo root is out of sync with backend/requirements.txt"
    )
