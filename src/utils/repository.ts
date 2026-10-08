import * as path from 'path';

/**
 * The repository root that `./` references in a workflow resolve against
 * (as on GitHub, where they're relative to the repository, not the file):
 * the directory holding `.github/workflows/<file>`, else the current
 * directory.
 */
export function repositoryRoot(workflowPath: string): string {
  const dir = path.dirname(path.resolve(workflowPath));
  return path.basename(dir) === 'workflows' &&
    path.basename(path.dirname(dir)) === '.github'
    ? path.dirname(path.dirname(dir))
    : process.cwd();
}
