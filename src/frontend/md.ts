/**
 * Minimal Markdown → HTML renderer for the in-app preview pane.
 * Handles the common subset used in AI-session prompts and result reports.
 * No external dependency — just string processing.
 */

const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Apply inline formatting to an already-escaped string. */
function inline(s: string): string {
  return s
    .replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" rel="noopener noreferrer">$1</a>');
}

/**
 * Render a Markdown string to safe HTML.
 * Block elements processed: headings (h1-h4), hr, blockquote,
 * fenced code blocks, unordered / ordered lists, paragraphs.
 */
export function renderMd(raw: string): string {
  if (!raw.trim()) return '';

  const lines = raw.split('\n');
  const out: string[] = [];

  let inCode = false;
  let codeLang = '';
  const codeBuf: string[] = [];
  let inUl = false;
  let inOl = false;
  const pBuf: string[] = [];

  const flushP = (): void => {
    if (pBuf.length) { out.push(`<p>${pBuf.join('<br>')}</p>`); pBuf.length = 0; }
  };
  const flushUl = (): void => { if (inUl) { out.push('</ul>'); inUl = false; } };
  const flushOl = (): void => { if (inOl) { out.push('</ol>'); inOl = false; } };
  const flushAll = (): void => { flushP(); flushUl(); flushOl(); };

  for (const line of lines) {
    // ── fenced code ──────────────────────────────────────────
    if (line.startsWith('```')) {
      if (inCode) {
        const lang = codeLang ? ` class="language-${esc(codeLang)}"` : '';
        out.push(`<pre><code${lang}>${esc(codeBuf.join('\n'))}</code></pre>`);
        codeBuf.length = 0; codeLang = ''; inCode = false;
      } else {
        flushAll();
        codeLang = line.slice(3).trim();
        inCode = true;
      }
      continue;
    }
    if (inCode) { codeBuf.push(line); continue; }

    // ── blank line ────────────────────────────────────────────
    if (!line.trim()) { flushAll(); continue; }

    // ── hr ────────────────────────────────────────────────────
    if (/^---+$/.test(line.trim())) { flushAll(); out.push('<hr>'); continue; }

    // ── headings ──────────────────────────────────────────────
    const hm = line.match(/^(#{1,4}) (.+)/);
    if (hm) {
      flushAll();
      const lvl = hm[1].length;
      out.push(`<h${lvl}>${inline(esc(hm[2].trim()))}</h${lvl}>`);
      continue;
    }

    // ── blockquote ────────────────────────────────────────────
    if (line.startsWith('> ')) {
      flushAll();
      out.push(`<blockquote>${inline(esc(line.slice(2)))}</blockquote>`);
      continue;
    }

    // ── unordered list ────────────────────────────────────────
    if (/^[-*] /.test(line)) {
      flushP(); flushOl();
      if (!inUl) { out.push('<ul>'); inUl = true; }
      out.push(`<li>${inline(esc(line.replace(/^[-*] /, '')))}</li>`);
      continue;
    }

    // ── ordered list ─────────────────────────────────────────
    if (/^\d+\. /.test(line)) {
      flushP(); flushUl();
      if (!inOl) { out.push('<ol>'); inOl = true; }
      out.push(`<li>${inline(esc(line.replace(/^\d+\. /, '')))}</li>`);
      continue;
    }

    // ── paragraph line ────────────────────────────────────────
    flushUl(); flushOl();
    pBuf.push(inline(esc(line)));
  }

  flushAll();
  // Close any unterminated code block
  if (inCode) out.push(`<pre><code>${esc(codeBuf.join('\n'))}</code></pre>`);

  return out.join('\n');
}
