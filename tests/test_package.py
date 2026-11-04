import pb_tokei


def test_package_imports() -> None:
    assert callable(pb_tokei.main)
