# Barnaba Whisper Service Dockerfile
# ===================================
# CUDA 12.3 + HuggingFace transformers + Flash Attention 2
# Migration from faster-whisper/CTranslate2 to HuggingFace transformers (16.01.2026)

# Base image with CUDA, Python 3.11, apt dependencies, PyTorch, Flash Attention,
# Python requirements and Silero VAD preinstalled. Rebuild whisper-base only when
# Dockerfile.base or requirements.txt changes.
# Base image. Built remotely by Azure Container Registry from
# whisper/Dockerfile.base and passed as a full ACR reference:
#
# See infra/azure/build-images.ps1. The placeholder fails outside that script
# instead of reaching a private Barnaba registry.
ARG WHISPER_BASE_IMAGE=invalid.example/barnaba-whisper-base:use-build-images-script
FROM ${WHISPER_BASE_IMAGE}

# Create app directory
WORKDIR /app

# Copy application code
COPY *.py ./

# Model revision pinning (cache-bust when the model version changes).
# FULL 40-character SHA on purpose: an abbreviation resolves but is ambiguous.
ENV WHISPER_MODEL_REVISION=34415231e554d1e7005118264f41e287922f9218

# Note: Whisper model is either:
# 1. Pre-mounted via Azure Files to /models (production)
# 2. Downloaded on first run from HuggingFace (development)
# The Singleton pattern ensures it's only loaded once

# Expose port
EXPOSE 8000

# Health check with extended startup time for GPU initialization
# start-period increased to 300s for model loading
#
# /ready, NOT /health - and this is the SECOND documented difference from the
# private Dockerfile, alongside WHISPER_BASE_IMAGE above.
#   * /health answers 200 with status="warming_up" while the model loads, so as
#     a HEALTHCHECK it only proves the process is alive.
#   * /ready answers 503 until the model is actually loaded, which is the
#     condition a caller depends on.
# Azure Container Apps uses the same readiness path. A running process would
# otherwise be reported healthy while it could not transcribe.
HEALTHCHECK --interval=30s --timeout=30s --start-period=300s --retries=5 \
    CMD curl -f http://localhost:8000/ready || exit 1

# NON-ROOT. The service reads audio and writes a model cache; nothing it does
# needs uid 0, and an ASR container reachable from the gateway is exactly the
# kind of process that should not have it.
#
# The cache directory is created and chowned HERE, before USER, on purpose:
# The Azure template mounts Azure Files over /var/cache/whisper. The directory
# ownership must permit the non-root process to populate the model cache.
#
# This remains unqualified until AZURE_REFERENCE_DEPLOYMENT_PASS runs on an
# Azure A100 deployment built from the public export.
RUN groupadd -r whisper && useradd -r -g whisper -d /home/whisper -m whisper && \
    mkdir -p /var/cache/whisper /var/cache/torch /models && \
    chown -R whisper:whisper /app /var/cache/whisper /var/cache/torch /models
USER whisper

# Run the service
CMD ["python", "whisper_service.py"]
