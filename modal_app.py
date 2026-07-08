"""Kara 3 on Modal — one always-warm Node container behind a public HTTPS URL.

Deploy:   modal deploy modal_app.py
Secrets:  `kara-keys` (ANAM_API_KEY, ANTHROPIC_API_KEY, optional FAST_MODEL),
          created with: modal secret create kara-keys --from-dotenv .env

Design notes:
- min/max_containers=1: Kara keeps sessions, delivery guards, and published
  files in one process's memory/disk, so she must be exactly one container.
  The load test showed one small container carries 50+ concurrent
  conversations (turns are I/O-bound API relays).
- @modal.concurrent lets that single container serve many requests at once
  (SSE channels + chat streams); without it Modal would queue them serially.
- npm ci runs with --ignore-scripts to skip the Playwright Chromium download
  (demo mode never browses); better-sqlite3 is rebuilt so its prebuilt native
  binary gets fetched.
"""

import os
import subprocess

import modal

app = modal.App("kara-3")

IGNORE = [
    "node_modules",
    ".git",
    "deliverables",
    "transcripts",
    ".env",
    "modal_app.py",
    "**/.DS_Store",
]

image = (
    modal.Image.from_registry("node:22-bookworm-slim", add_python="3.12")
    .workdir("/app")
    .add_local_file("package.json", "/app/package.json", copy=True)
    .add_local_file("package-lock.json", "/app/package-lock.json", copy=True)
    .run_commands("cd /app && npm ci --ignore-scripts && npm rebuild better-sqlite3")
    .add_local_dir(".", remote_path="/app", copy=True, ignore=IGNORE)
)


@app.function(
    image=image,
    secrets=[modal.Secret.from_name("kara-keys")],
    min_containers=1,
    max_containers=1,
    cpu=2,
    memory=2048,
)
@modal.concurrent(max_inputs=1000)
@modal.web_server(8000, startup_timeout=120)
def kara():
    env = {**os.environ, "PORT": "8000", "DEMO_MODE": "1"}
    subprocess.Popen(["node", "server.js"], cwd="/app", env=env)
