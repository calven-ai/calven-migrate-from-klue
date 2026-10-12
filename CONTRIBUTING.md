# Contributing

Run `npm test` before a pull request. It needs Node.js 20 or later and no install step: the tool has no dependencies.

The tests run against `test/fake-klue.mjs`, a simulated Klue server. Keep test data fictional: no Klue screenshots, logos, help text or real card content in this repository.

If a real Klue export behaves differently from the simulation, open an issue with `manifest.json` or the output of `calven-migrate-from-klue inspect`. Neither contains card content.
