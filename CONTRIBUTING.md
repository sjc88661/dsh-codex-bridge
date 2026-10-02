# Contributing

Use Node.js 22.19+ (22 or 24 recommended) and npm. Install dependencies and run the complete local checks:

```sh
npm ci
npm run check
```

The tests use model-free fixtures and do not require a running Harness or paid requests. An opt-in real Harness roundtrip can be useful when changing integration behavior; run it only in an environment where that execution is intended, and report the profile/provider/model actually used. A passing local suite does not imply that a live Harness roundtrip was run.

Keep changes within the requested files, document user-visible config or CLI changes, and do not include local journals, credentials, task histories, or generated dependencies. See [configuration](docs/CONFIGURATION.md) and [release instructions](docs/RELEASING.md).
