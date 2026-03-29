# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Russian Checkers (Шашки) — a multiplayer browser game with AI opponents. The UI is in Ukrainian.

## Commands

```bash
cd russian-checkers && npm install   # install dependencies
cd russian-checkers && npm start     # start server at http://localhost:8080
```

No test suite exists (`npm test` is a placeholder).

## Architecture

All source code lives under `russian-checkers/`. There is no build step — plain JS served directly.

**Server (`server.js`)** — Express + Socket.io. Three concerns:
1. **AI move endpoints** — `POST /api/ai-move` (Claude via Anthropic SDK) and `POST /api/chatgpt-move` (OpenAI SDK). Both send the board state and valid moves as a prompt, parse a move index from the response. On API failure, falls back to a random move.
2. **Game storage** — JSON files in `data/games/`, indexed by `data/index.json` (rebuilt from files on startup). CRUD via `/api/games`. Training data export via `/api/training-data` (NDJSON).
3. **Online multiplayer** — Socket.io rooms. First two connections get white/black; extras are spectators. Server relays board state; game logic runs client-side.

**Client (`public/script.js`)** — Single-file SPA. Contains all game logic: board state, move validation, mandatory jumps, multi-jumps, king promotion, and win detection. Manages multiple game modes:
- `pvp` (local), `pvc` (vs random AI), `claude`, `chatgpt`, `aiva` (Claude vs ChatGPT), `rvc`, `rvg`, `cvc` (computer vs computer), `online` (Socket.io)
- Includes a game recorder that posts completed games to `/api/games`
- Game history modal with replay controls (step through moves)

**Config (`config.json`)** — Runtime settings for AI models (Claude/OpenAI model names, token limits, thinking config), game behavior (`computerDelayMs`, `autoPlayMaxGames`), and server port. Reloaded from disk on each AI request.

**Training data export (`scripts/export-training-data.js`)** — CLI tool to export game data as JSONL. Filters by `--agent`, `--result`, `--min-moves`, `--output`.

## Environment

Requires `ANTHROPIC_API_KEY` and `OPENAI_API_KEY` environment variables (loaded via dotenv from `.env`). Deployment config in `render.yaml` (Render) with instructions for Railway in README.

## GitHub Actions Workflow Rules

When implementing changes from a GitHub issue, always create a pull request automatically by running `gh pr create` at the end. Do not just provide a "Create PR" link.
