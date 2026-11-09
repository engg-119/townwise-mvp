# The forecast lab job (python -m townwise_lab job). Build context is modeling/lab/.
FROM python:3.12.15-slim-bookworm@sha256:6a0e06f5ba0b373d051aabd3fffb9b873f27f9a2a3a14bcbe37dee6f0e3bbc70
COPY --from=ghcr.io/astral-sh/uv:0.11.2@sha256:c4f5de312ee66d46810635ffc5df34a1973ba753e7241ce3a08ef979ddd7bea5 /uv /bin/uv
WORKDIR /app
ENV UV_PYTHON_DOWNLOADS=never UV_LINK_MODE=copy
COPY pyproject.toml uv.lock ./
RUN uv sync --frozen --no-dev
COPY townwise_lab/ ./townwise_lab/
ARG CODE_VERSION
ENV TOWNWISE_LAB_CODE_VERSION=$CODE_VERSION
RUN useradd --system --uid 10001 --no-create-home lab
USER 10001
ENTRYPOINT ["/app/.venv/bin/python", "-m", "townwise_lab", "job"]
