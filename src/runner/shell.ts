/**
 * `shell:` handling for `run:` steps, mirroring the GitHub runner: the
 * script is written to a file and passed as `{0}` to a command template.
 * https://docs.github.com/en/actions/using-workflows/workflow-syntax-for-github-actions#jobsjob_idstepsshell
 */

export interface ResolvedShell {
  /** Command line with a `{0}` placeholder for the script path. */
  template: string;
  /** Extension for the script file (some interpreters care). */
  extension: string;
}

const BASH = 'bash --noprofile --norc -eo pipefail {0}';
const SH = 'sh -e {0}';

const KNOWN_SHELLS: Record<string, ResolvedShell> = {
  bash: { template: BASH, extension: '.sh' },
  sh: { template: SH, extension: '.sh' },
  python: { template: 'python {0}', extension: '.py' },
  pwsh: { template: `pwsh -command ". '{0}'"`, extension: '.ps1' },
  powershell: {
    template: `powershell -command ". '{0}'"`,
    extension: '.ps1'
  },
  cmd: {
    template: '%ComSpec% /D /E:ON /V:OFF /S /C "CALL "{0}""',
    extension: '.cmd'
  }
};

/**
 * Resolve a step's `shell:` (after `defaults.run.shell`) to a command
 * template. With no shell, GitHub uses bash with `-eo pipefail`, or
 * `sh -e` where bash isn't installed.
 */
export function resolveShell(
  shell: string | undefined,
  options: { bashAvailable: boolean }
): ResolvedShell {
  if (!shell) {
    return options.bashAvailable ? KNOWN_SHELLS.bash : KNOWN_SHELLS.sh;
  }
  const known = KNOWN_SHELLS[shell];
  if (known) return known;
  if (shell.includes('{0}')) return { template: shell, extension: '' };
  return { template: `${shell} {0}`, extension: '' };
}

/**
 * Build the command line for a template and script path. `{0}` is replaced
 * with a single-quoted path, unless the template already quotes it.
 */
export function shellCommandLine(template: string, scriptPath: string): string {
  if (/'\{0\}'|"\{0\}"/.test(template)) {
    return template.replace('{0}', scriptPath);
  }
  const quoted = `'${scriptPath.replace(/'/g, "'\\''")}'`;
  return template.replace('{0}', quoted);
}
