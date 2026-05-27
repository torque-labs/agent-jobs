import React from "react";

function renderInline(text: string): React.ReactNode {
  const parts: React.ReactNode[] = [];
  const re = /(\*\*[^*]+\*\*|`[^`]+`)/g;
  let last = 0, m: RegExpExecArray | null, i = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) parts.push(text.slice(last, m.index));
    const tok = m[0];
    if (tok.startsWith("**")) parts.push(<strong key={i++}>{tok.slice(2, -2)}</strong>);
    else parts.push(<code key={i++} className="rounded bg-muted px-1 py-0.5 font-mono text-[0.85em]">{tok.slice(1, -1)}</code>);
    last = m.index + tok.length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts;
}

export function MarkdownView({ source }: { source: string }) {
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  const blocks: React.ReactNode[] = [];
  let i = 0, key = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim().startsWith("|") && /^\s*\|[-:\s|]+\|\s*$/.test(lines[i + 1] ?? "")) {
      const header = line.split("|").slice(1, -1).map((s) => s.trim());
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i].trim().startsWith("|")) { rows.push(lines[i].split("|").slice(1, -1).map((s) => s.trim())); i++; }
      blocks.push(
        <div key={key++} className="my-3 overflow-x-auto rounded-md border">
          <table className="w-full border-collapse text-sm">
            <thead><tr className="border-b bg-muted/40">{header.map((h, j) => <th key={j} className="px-3 py-2 text-left font-medium text-muted-foreground">{renderInline(h)}</th>)}</tr></thead>
            <tbody>{rows.map((r, ri) => <tr key={ri} className="border-b last:border-0">{r.map((c, ci) => <td key={ci} className="px-3 py-2 tabular-nums">{renderInline(c)}</td>)}</tr>)}</tbody>
          </table>
        </div>);
      continue;
    }
    if (line.startsWith("### ")) { blocks.push(<h3 key={key++} className="mt-4 mb-1 font-heading text-sm font-semibold tracking-tight">{renderInline(line.slice(4))}</h3>); i++; continue; }
    if (line.startsWith("## ")) { blocks.push(<h2 key={key++} className="mt-5 mb-1.5 font-heading text-lg font-semibold tracking-tight">{renderInline(line.slice(3))}</h2>); i++; continue; }
    if (line.startsWith("# ")) { blocks.push(<h1 key={key++} className="mt-2 mb-2 font-heading text-xl font-semibold tracking-tight">{renderInline(line.slice(2))}</h1>); i++; continue; }
    if (line.startsWith("> ")) { const q: string[] = []; while (i < lines.length && lines[i].startsWith("> ")) { q.push(lines[i].slice(2)); i++; } blocks.push(<blockquote key={key++} className="my-2 border-l-2 border-primary/40 pl-3 italic text-muted-foreground">{renderInline(q.join(" "))}</blockquote>); continue; }
    if (line.trim() === "---") { blocks.push(<hr key={key++} className="my-4 border-border" />); i++; continue; }
    if (/^\s*[-*]\s+/.test(line)) { const items: string[] = []; while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) { items.push(lines[i].replace(/^\s*[-*]\s+/, "")); i++; } blocks.push(<ul key={key++} className="my-2 list-disc space-y-0.5 pl-5">{items.map((it, ii) => <li key={ii}>{renderInline(it)}</li>)}</ul>); continue; }
    if (line.trim() === "") { i++; continue; }
    const para: string[] = [];
    while (i < lines.length && lines[i].trim() !== "" && !/^(#{1,3}\s|>\s|\||\s*[-*]\s|---)/.test(lines[i])) { para.push(lines[i]); i++; }
    blocks.push(<p key={key++} className="my-1.5 leading-relaxed">{renderInline(para.join(" "))}</p>);
  }
  return <div>{blocks}</div>;
}
