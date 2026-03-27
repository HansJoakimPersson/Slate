# Slate — Agent Instructions

## What this project is

Slate is a minimal single-page chat application that talks directly to an OpenAI-compatible API from the browser. It is intentionally tiny: no build step, no framework, no bundler. The entire application lives in `index.html`.

## Repository layout

```
index.html            — the entire application (HTML + CSS + JS in one file)
tests/
  slate-chat.spec.js              — main Playwright test suite
  slate-chat.regressions.spec.js  — regression tests for specific bugs
  live-backend.spec.js            — tests that require a real backend (not run in CI)
ARCHITECTURE.md       — original design brief and architectural constraints
playwright.config.js  — test configuration (serves index.html on localhost)
package.json          — devDependencies: @playwright/test only
```

## Core constraint

**Do not split `index.html` into multiple files.** All changes go into `index.html`. No build step, no external assets, no CDN dependencies.

## Running tests

```bash
# Run main + regression suites
/opt/homebrew/bin/node node_modules/.bin/playwright test tests/slate-chat.spec.js tests/slate-chat.regressions.spec.js

# Run a single test by name
/opt/homebrew/bin/node node_modules/.bin/playwright test --grep "test name here"

# Run with npm
npm run test:e2e
```

Use the playwright binary at `/opt/homebrew/bin/node node_modules/.bin/playwright` — not a global `playwright` command.

**Do not run the full test suite after CSS-only changes.** Only run tests when behaviour changes.

## Testing policy

All user-facing interactions must be covered by Playwright tests. When adding or changing behaviour that affects what a user can do (sending messages, switching models, toggling settings, creating/renaming/deleting conversations, sidebar interactions, etc.), write or update the corresponding test.

CSS-only changes do not require a test run. Only run the suite when behaviour changes — either to verify a fix or to confirm a new feature works end-to-end.

## Code conventions

- **Vanilla JS only** — no framework, no TypeScript, no imports.
- **State** lives in a single `state` object. `state.messages` is kept as a live reference to `getActiveConversation().messages` so existing send/render code needs no changes when conversations switch.
- **Render** is a full re-render on every state change (`renderMessages`, `renderConvList`). Do not introduce incremental DOM patching.
- **CSS variables** are defined at `:root`. Use them instead of hardcoded colours. Key variables: `--background`, `--foreground`, `--secondary`, `--border`, `--muted`, `--primary`.
- **Icon buttons** use `.icon-button` with inline SVG. No icon library.

## Provider support

The app supports three API providers, each handled in the same request-building switch:
- `openai` — `POST /chat/completions` (default, points at Docker Model Runner)
- `ollama` — `POST /api/chat` (Ollama-compatible)
- `anthropic` — `POST /v1/messages`

Title generation, stop-sequence handling, and streaming differ per provider — check existing branches before adding new logic.

## Thinking / reasoning models

Some models (e.g. Qwen3 via Docker Model Runner) return reasoning in a `reasoning_content` field on SSE deltas rather than in `content`. The SSE parser wraps these chunks in `<think>…</think>` tags which `renderAssistantContent` converts to a collapsible `<details>` block with a spinner while streaming.

Do not add stop sequences (`"User:"`, `"Human:"`, etc.) to the request body — they break thinking-mode models.

## Conversation title generation

After the first assistant reply, `generateConversationTitle` fires a non-streaming request to the active provider. Key behaviours:
- Uses a system message to frame the task so the model does not treat the snippet as a conversation to continue.
- Takes **only the first non-empty line** of the response — some models hallucinate follow-on Q&A after the correct title.
- Falls back to `reasoning_content` if `content` is empty (thinking models that exhaust their token budget).
- `max_tokens: 300` to give thinking models enough budget to finish their chain.

## Sidebar

- `#convSidebar` is a fixed-width `<aside>` that collapses to 44 px with `is-collapsed`.
- When collapsed: header stacks vertically (toggle button on top, new-chat button below); conversation list is hidden.
- `#convSidebarToggle` toggles the sidebar open/closed.
- `#newConvButton` creates a new conversation and expands the sidebar if it was collapsed.

## localStorage

- `slate_conversations` — serialised `state.conversations` array.
- `slate_active_conv` — active conversation ID.
- The API key is **never** persisted.

## Test conventions

- Mock all network requests — tests never hit a real backend (except `live-backend.spec.js`).
- Title-generation requests are identified by `body.stream === false`; handle them separately in route mocks.
- The streaming mock response must be `text/event-stream` with SSE-formatted lines; a JSON `choices` body is only used for non-streaming.
