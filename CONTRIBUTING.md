# Contributing

Thanks for helping improve kz-replay. Bug reports, format research, documentation,
tests, and focused code changes are welcome.

By submitting a contribution, you confirm that you have the right to submit it
and agree that it may be distributed under the repository's AGPL-3.0-only license.
Do not contribute copied source or assets under incompatible or unclear terms.
In particular, do not commit Counter-Strike assets, converted Workshop maps,
replay caches, or generated tracks. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## Development setup

Install Node.js 24 LTS, clone the repository, and run:

```bash
npm install
npm test
npm run build
```

Run the viewer with `npm run dev`. CLI commands use the checkout explicitly, for
example `node bin/kzreplay.js inspect <record-id>`. You may run `npm link` if you
want the `kzreplay` shorthand on your `PATH`.

Environment variables are optional in development. This project does not load a
`.env` file itself; export variables in your shell or use your process manager's
environment support. `.env.example` documents the available settings.

Map conversion has additional local prerequisites described in [docs/maps.md](docs/maps.md).
You do not need map-conversion tools for parser, viewer, or documentation changes.

## Before opening a pull request

Keep changes focused and explain the user-visible result and relevant trade-offs.
Add or update tests when behavior changes. Then run:

```bash
npm test
npm run check
npm run build
npx prettier --check "{src,bin,viewer,scripts}/**/*.{js,html,css}"
```

`npm run check` uses known replay pairs and may require the repository's test data.
If you cannot run a check, say so in the pull request rather than silently omitting it.

Parser changes need extra care: never guess a field size or silently accept unread
bytes. Add a small distributable fixture where possible, and explain which upstream
format source or observed replay supports the change.

## Reports and discussions

Use a GitHub issue for reproducible bugs and proposed features. Include the Node
version, operating system, command or URL, expected result, actual result, and a
minimal reproduction. Do not post vulnerabilities or private data in a public issue;
follow [SECURITY.md](SECURITY.md) instead.

Participation is governed by [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).
