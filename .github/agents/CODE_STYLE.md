# Code Style for the SecureCI CLI

Conventions specific to this codebase. General TypeScript/JavaScript idioms you
already know (destructuring, spread, async/await, early returns, etc.) are not
repeated here — just use them. ESLint and Prettier enforce the mechanical rules;
this document covers the conventions tools can't check.

## Tooling

```bash
npm run lint     # ESLint (eslint:recommended + @typescript-eslint/recommended)
npm run format   # Prettier (@jabraf/prettier config)
npm run build    # tsc, strict mode
```

- **TypeScript strict mode** is on. No implicit `any`; prefer `unknown` or a
  specific type. `@typescript-eslint/no-explicit-any` is a warning — don't add new
  `any`.
- **Prettier** owns formatting: 2-space indent, single quotes, semicolons, ES5
  trailing commas, ~80-char soft width, parens around arrow params. Don't
  hand-format against it; CI runs `prettier --check .`.

## Naming

- **Files/directories:** `kebab-case` (`workflow-parser.ts`, `runner/`). Tests
  sit next to source as `kebab-case.test.ts`.
- **Classes / interfaces / type aliases / enums:** `PascalCase`.
- **Functions / variables:** `camelCase`. **True constants:** `UPPER_SNAKE_CASE`.

## Types and functions

- **Prefer `interface` for object shapes**; use `type` for unions, primitives and
  generics (`type Status = 'success' | 'failure'`).
- **Explicit return types on exported functions.** Inference is fine for
  internal/private helpers.
- **Prefer named `function` declarations for exports** over arrow-function
  constants. Avoid default exports unless a dependency requires one.

## Imports

Group in this order (Prettier won't reorder them for you):

```typescript
// 1. Node built-ins
import * as fs from 'fs';
import * as path from 'path';
// 2. External packages
import * as YAML from 'yaml';
import chalk from 'chalk';
// 3. Internal modules
import { Workflow } from '../types';
import { logger } from '../utils/logger';
```

## Comments

Code should be self-documenting; comment the **why**, not the **what**. Use JSDoc
on public APIs. Tag deferred work as `// TODO(username): …` or
`// TODO: … (Issue #NN)`.

```typescript
// GitHub API requires a User-Agent header to avoid rate limiting
headers['User-Agent'] = 'secureci-cli';
```

## Errors

Throw `Error` with a message that names the thing that failed, e.g.
``throw new Error(`Workflow file not found: ${workflowPath}`)`` — never a bare
`'Error'`.

## Common patterns

```typescript
import { logger } from '../utils/logger'; // secret-masking logger, not console
logger.info('Processing workflow');

import chalk from 'chalk'; // terminal colors, via the logger where possible
```

YAML is parsed with the `yaml` package (`YAML.parse`). Read files with the `fs`
module.

## Before committing

Run the full gate and make sure it's green:

```bash
npm run lint && npm run format && npm test && npm run build
```

Commit messages follow Conventional Commits — see [CONTRIBUTING.md](../../CONTRIBUTING.md).

## Summary for agents

TypeScript strict mode · kebab-case files · PascalCase types, camelCase values ·
`interface` for objects, `type` for unions · explicit return types on exports ·
named function exports · comment the why · masking `logger`, not `console` ·
`npm run lint && npm run format && npm test && npm run build` before committing.
