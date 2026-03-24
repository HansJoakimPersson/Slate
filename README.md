# Slate

A minimal, self-contained chat UI for OpenAI-compatible APIs and Ollama backends. Ships as a single HTML file — no build step, no server, no dependencies.

<div align="center">

[![E2E](https://github.com/HansJoakimPersson/Slate/actions/workflows/e2e.yml/badge.svg)](https://github.com/HansJoakimPersson/Slate/actions/workflows/e2e.yml)
[![license](https://img.shields.io/badge/license-AGPL--3.0--only-blue.svg?style=flat)](LICENSE.md)
[![Buy Me a Coffee](https://img.shields.io/badge/Buy%20me%20a%20coffee-Support-FFDD00.svg?style=flat&logo=buymeacoffee&logoColor=000000)](https://buymeacoffee.com/hansjoakimpersson)

</div>

## Download

Download the latest release here:

- [Slate-latest.html](https://github.com/HansJoakimPersson/Slate/releases/latest/download/Slate-latest.html)

## Features

- Single HTML file — open directly in the browser or serve statically
- Supports OpenAI-compatible APIs and Ollama backends
- Streaming responses with Markdown rendering
- API key stays in memory only — never persisted
- No external dependencies, no CDN, no build step
- Desktop-first layout

## Usage

Open `index.html` directly in a browser, or serve it with any static HTTP server:

```bash
python3 -m http.server 4179
```

Then open `http://127.0.0.1:4179` and configure your API endpoint and key in the settings panel.

## Development

Run the mock E2E regression suite:

```bash
npm install
npm run test:e2e
```

Run live backend smoke tests against Ollama on `127.0.0.1:12434`:

```bash
npm run test:e2e:live
```

## What the tests verify

- Model loading on startup
- Provider-specific settings behavior (Ollama vs OpenAI-compatible)
- Request construction for both provider modes
- Transcript rendering for mocked assistant replies
- Live backend smoke tests in both streaming and non-streaming modes

## Support

If you want to support this project or whatever I end up building next:

- [Buy Me a Coffee](https://buymeacoffee.com/hansjoakimpersson)

## License

Slate is licensed under `AGPL-3.0-only`. See [LICENSE.md](LICENSE.md).
