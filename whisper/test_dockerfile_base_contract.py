"""Static supply-chain contract for the GPU base image.

This does not replace the required Azure A100 build and smoke test. It prevents a later edit from
silently restoring interpreter mismatch or floating Python build dependencies.
"""

import re
from pathlib import Path


TEXT = (Path(__file__).parent / "Dockerfile.base").read_text(encoding="utf-8")


def test_cuda_base_image_is_pinned_by_digest():
    assert re.search(r"^FROM nvidia/cuda:[^\s]+@sha256:[0-9a-f]{64}$", TEXT, re.MULTILINE)


def test_python_packages_use_one_explicit_venv_interpreter():
    assert "python3.11 -m venv /opt/venv" in TEXT
    assert "ENV PATH=/opt/venv/bin:$PATH" in TEXT
    assert not re.search(r"^\s+python3-pip\s*\\?$", TEXT, re.MULTILINE)
    assert not re.search(r"^RUN pip install", TEXT, re.MULTILINE)


def test_build_toolchain_and_flash_attention_are_exactly_pinned():
    for package in ("pip", "setuptools", "wheel", "packaging", "ninja"):
        assert re.search(rf"\b{re.escape(package)}==[^\s\\]+", TEXT), package
    assert re.search(r"\bflash-attn==[^\s\\]+", TEXT)
    assert "pip install --no-cache-dir --upgrade" not in TEXT


def test_apt_avoids_recommended_packages_and_clears_indexes():
    assert TEXT.count("apt-get install -y --no-install-recommends") == 2
    assert "rm -rf /var/lib/apt/lists/*" in TEXT
