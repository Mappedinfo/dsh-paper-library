from __future__ import annotations


def test_package_imports() -> None:
    import dsh_paper_library as pkg

    assert pkg.__version__
