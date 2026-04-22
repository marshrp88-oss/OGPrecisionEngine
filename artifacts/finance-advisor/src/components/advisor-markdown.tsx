import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useState } from "react";
import { Copy, Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface AdvisorMarkdownProps {
  content: string;
  className?: string;
}

export function AdvisorMarkdown({ content, className }: AdvisorMarkdownProps) {
  return (
    <div
      className={cn(
        "prose prose-sm dark:prose-invert max-w-none min-w-0",
        // Brighter, high-contrast body text (override prose-invert's dim grey)
        "text-foreground/95",
        "prose-p:text-foreground/95 prose-li:text-foreground/95",
        "prose-headings:text-foreground prose-headings:font-semibold prose-headings:tracking-tight",
        "prose-h1:text-base prose-h1:mt-4 prose-h1:mb-2",
        "prose-h2:text-sm prose-h2:mt-4 prose-h2:mb-2 prose-h2:uppercase prose-h2:tracking-wider prose-h2:text-foreground prose-h2:font-mono",
        "prose-h3:text-sm prose-h3:mt-3 prose-h3:mb-1",
        "prose-p:my-2 prose-p:leading-relaxed",
        "prose-ul:my-2 prose-ol:my-2 prose-li:my-0.5",
        "prose-strong:text-foreground prose-strong:font-semibold",
        "prose-code:text-foreground prose-code:bg-background/60 prose-code:px-1 prose-code:py-0.5 prose-code:rounded prose-code:text-[0.85em] prose-code:font-mono prose-code:before:content-none prose-code:after:content-none",
        "prose-table:my-3 prose-table:text-xs",
        "prose-hr:my-4 prose-hr:border-border",
        "prose-blockquote:border-l-2 prose-blockquote:border-primary/40 prose-blockquote:pl-3 prose-blockquote:italic prose-blockquote:text-foreground/80",
        className,
      )}
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          pre: ({ children, ...props }) => <CodeBlock {...props}>{children}</CodeBlock>,
          table: ({ children, ...props }) => (
            <div className="not-prose my-3 overflow-x-auto rounded-md border border-border">
              <table {...props} className="w-full text-xs">
                {children}
              </table>
            </div>
          ),
          th: ({ children, ...props }) => (
            <th {...props} className="border border-border bg-muted/50 px-2 py-1 text-left font-semibold">
              {children}
            </th>
          ),
          td: ({ children, ...props }) => (
            <td {...props} className="border border-border px-2 py-1 align-top">
              {children}
            </td>
          ),
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}

function CodeBlock({ children, ...props }: React.HTMLAttributes<HTMLPreElement>) {
  const [copied, setCopied] = useState(false);
  const text = extractText(children);
  return (
    <div className="relative group not-prose my-3">
      <pre
        {...props}
        className="bg-background/80 border border-border rounded-md p-3 pr-9 text-xs leading-snug font-mono whitespace-pre-wrap break-words text-foreground/95"
      >
        {children}
      </pre>
      {text && (
        <Button
          variant="ghost"
          size="icon"
          className="absolute top-1.5 right-1.5 h-6 w-6 opacity-0 group-hover:opacity-100 transition-opacity"
          onClick={() => {
            navigator.clipboard.writeText(text);
            setCopied(true);
            setTimeout(() => setCopied(false), 1200);
          }}
        >
          {copied ? <Check className="h-3 w-3 text-emerald-500" /> : <Copy className="h-3 w-3" />}
        </Button>
      )}
    </div>
  );
}

function extractText(node: React.ReactNode): string {
  if (typeof node === "string") return node;
  if (typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(extractText).join("");
  if (node && typeof node === "object" && "props" in node) {
    return extractText((node as { props: { children: React.ReactNode } }).props.children);
  }
  return "";
}
