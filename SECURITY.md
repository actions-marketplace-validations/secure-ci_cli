# Security Policy

## Reporting a vulnerability

Please report security issues privately, not in a public issue. Email
**hello@secure-ci.dev** with a description, steps to reproduce, and the affected
version (`secureci --version`). We aim to acknowledge reports within 3 business
days and to agree a fix and disclosure timeline with you.

## Supported versions

The latest published `@secureci/cli` release receives security fixes.

## Scope

In scope: code in this repository and the published `@secureci/cli` package,
including container isolation, secret masking, artifact and cache path handling,
and action fetching.

Out of scope: vulnerabilities in third-party actions that a workflow runs, and
the behaviour of `--container-runtime host`, which runs steps on your machine by
design once you opt in.

The package's runtime capabilities (process spawning, network, environment and
filesystem access) are described in the README under "What the package accesses,
and why".
