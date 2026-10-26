import * as YAML from 'yaml';

/** `# secureci-allow <rule>` with an optional `: <reason>`. */
function directive(rule: string): RegExp {
  const name = rule.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^#\\s*secureci-allow\\s+${name}(?=\\s|:|$)(?::(.*))?$`);
}

/** Source offset of every comment, mapped to its text (`# ...`). */
function commentOffsets(content: string): Map<number, string> {
  const comments = new Map<number, string>();
  let offset = 0;
  for (const token of new YAML.Lexer().lex(content)) {
    const type = YAML.CST.tokenType(token);
    if (type === 'comment') comments.set(offset, token);
    // Control tokens mark the parser's state; they aren't in the source.
    if (type !== 'doc-mode' && type !== 'flow-error-end' && type !== 'scalar') {
      offset += token.length;
    }
  }
  return comments;
}

/**
 * Steps carrying a `# secureci-allow <rule>: <reason>` comment, as
 * `jobs.<id>.steps[<i>]` paths mapped to the reason ('' when it's missing).
 * The comment goes at the end of the step's first line (`- uses: ...`) or
 * on a line of its own directly above the step; comments separated by a
 * blank line, or inside the step, don't count.
 */
export function stepAllowComments(
  content: string,
  rule: string
): Map<string, string> {
  const allowed = new Map<string, string>();
  const doc = YAML.parseDocument(content);
  if (doc.errors.length > 0) return allowed;
  const jobs = doc.get('jobs');
  if (!YAML.isMap(jobs)) return allowed;

  const comments = commentOffsets(content);
  const pattern = directive(rule);
  const lineStart = (offset: number) =>
    content.lastIndexOf('\n', offset - 1) + 1;

  for (const pair of jobs.items) {
    const steps = YAML.isMap(pair.value) ? pair.value.get('steps') : undefined;
    if (!YAML.isSeq(steps)) continue;
    steps.items.forEach((step, i) => {
      if (!YAML.isNode(step) || !step.range) return;
      const start = step.range[0];
      const lineEnd = content.indexOf('\n', start);
      const texts: string[] = [];
      for (const [offset, text] of comments) {
        if (offset >= start && (lineEnd === -1 || offset < lineEnd)) {
          texts.push(text);
        }
      }
      // Whole-line comments directly above the step.
      let line = lineStart(start);
      while (line > 0) {
        const above = lineStart(line - 1);
        const indent = content.slice(above, line).search(/\S/);
        const text = indent === -1 ? undefined : comments.get(above + indent);
        if (text === undefined) break;
        texts.push(text);
        line = above;
      }
      for (const text of texts) {
        const match = pattern.exec(text.trimEnd());
        if (match) {
          allowed.set(
            `jobs.${String(pair.key)}.steps[${i}]`,
            (match[1] ?? '').trim()
          );
          break;
        }
      }
    });
  }
  return allowed;
}
