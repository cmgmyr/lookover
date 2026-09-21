/** Render the small, deliberately safe markdown subset used by card details. */
export function renderMarkdown(source: string): string {
  const lines = source.replace(/\r\n?/g, '\n').split('\n');
  const blocks: string[] = [];
  let index = 0;

  while (index < lines.length) {
    if (lines[index]?.trim() === '') {
      index += 1;
      continue;
    }

    if (isFence(lines[index] ?? '')) {
      const code: string[] = [];
      index += 1;
      while (index < lines.length && !isFence(lines[index] ?? '')) {
        code.push(lines[index] ?? '');
        index += 1;
      }
      if (index < lines.length) {
        index += 1;
      }
      blocks.push(`<pre><code>${escapeHtml(code.join('\n'))}</code></pre>`);
      continue;
    }

    const unordered = unorderedItem(lines[index] ?? '');
    const ordered = orderedItem(lines[index] ?? '');
    if (unordered !== undefined || ordered !== undefined) {
      const orderedList = ordered !== undefined;
      const items: string[] = [];
      while (index < lines.length) {
        const item = orderedList
          ? orderedItem(lines[index] ?? '')
          : unorderedItem(lines[index] ?? '');
        if (item === undefined) {
          break;
        }
        items.push(`<li>${renderInline(item)}</li>`);
        index += 1;
      }
      blocks.push(`<${orderedList ? 'ol' : 'ul'}>${items.join('')}</${orderedList ? 'ol' : 'ul'}>`);
      continue;
    }

    const paragraph: string[] = [];
    while (index < lines.length) {
      const line = lines[index] ?? '';
      if (line.trim() === '' || isFence(line) || unorderedItem(line) !== undefined || orderedItem(line) !== undefined) {
        break;
      }
      paragraph.push(line);
      index += 1;
    }
    blocks.push(`<p>${renderInline(paragraph.join('\n'))}</p>`);
  }

  return blocks.join('');
}

function isFence(line: string): boolean {
  return /^\s*```(?:[^`]*)$/.test(line.trimEnd());
}

function unorderedItem(line: string): string | undefined {
  return /^\s*[-*+]\s+(.+)$/.exec(line)?.[1];
}

function orderedItem(line: string): string | undefined {
  return /^\s*\d+[.)]\s+(.+)$/.exec(line)?.[1];
}

function renderInline(source: string): string {
  const escaped = escapeHtml(source);
  const tokens: string[] = [];
  const token = (value: string): string => {
    const marker = `\u0000${tokens.length}\u0000`;
    tokens.push(value);
    return marker;
  };

  let result = escaped.replace(/`([^`\n]+)`/g, (_match, code: string) => token(`<code>${code}</code>`));
  result = result.replace(
    /\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g,
    (_match, label: string, href: string) => token(`<a href="${href}">${label}</a>`),
  );
  result = result.replace(/\*\*([^*\n]+)\*\*/g, (_match, bold: string) => token(`<strong>${bold}</strong>`));
  // A newline inside a paragraph is a soft break, not a line break: agents
  // hard-wrap their details, and <br> replayed those wrap points on a phone.
  result = result.replace(/\n/g, ' ');

  return result.replace(/\u0000(\d+)\u0000/g, (_match, index: string) => tokens[Number(index)] ?? '');
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    switch (character) {
      case '&': return '&amp;';
      case '<': return '&lt;';
      case '>': return '&gt;';
      case '"': return '&quot;';
      default: return '&#39;';
    }
  });
}
