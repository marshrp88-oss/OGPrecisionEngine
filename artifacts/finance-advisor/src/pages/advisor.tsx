import { useState, useRef, useEffect, useCallback } from "react";
import {
  useListAnthropicConversations,
  getListAnthropicConversationsQueryKey,
  useCreateAnthropicConversation,
  useListAnthropicMessages,
  getListAnthropicMessagesQueryKey,
  useDeleteAnthropicConversation,
  useRunIntegrityCheck,
  useGetDashboardCycle,
  getGetDashboardCycleQueryKey,
} from "@workspace/api-client-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import {
  Plus,
  Send,
  Trash2,
  Bot,
  User,
  AlertTriangle,
  CheckCircle2,
  StopCircle,
  Copy,
  Check,
  RefreshCw,
  Sparkles,
  ClipboardList,
  Clock,
} from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { formatDate, cn } from "@/lib/utils";
import { AdvisorMarkdown } from "@/components/advisor-markdown";
import { AdvisorSnapshotDrawer } from "@/components/advisor-snapshot-drawer";

const BASE_URL = import.meta.env.BASE_URL.replace(/\/$/, "");

const SUGGESTED_PROMPTS = [
  {
    label: "Safe to spend today",
    prompt: "Today is a normal weekday. What's my Safe to Spend right now and what's the daily burn rate I have to stay under to make next payday?",
  },
  {
    label: "Run a what-if",
    prompt: "What-if scenario: I want to spend $250 on dinner with friends Friday night. Show me the cycle impact and tell me whether to do it.",
  },
  {
    label: "Roth vs HYSA this month",
    prompt: "Should this month's surplus go to Roth IRA or stay in HYSA? Use the playbook's bucket priority and my actual numbers.",
  },
  {
    label: "Audit my fixed bills",
    prompt: "Audit my Include=TRUE bills. Anything that looks misclassified, redundant, or worth renegotiating? Be blunt.",
  },
  {
    label: "Drought stress test",
    prompt: "Stress test: assume zero commission for the next 90 days. What breaks first? What do I cut? Show the cash flow month by month.",
  },
  {
    label: "Quarterly pulse check",
    prompt: "Give me a quarterly pulse check on my full financial picture: discretionary, savings rate, debt trajectory, retirement, wealth. One paragraph per area, end with the one thing I should change.",
  },
];

interface Conversation {
  id: number;
  title: string;
  createdAt: string | Date;
}

interface Message {
  id: number;
  conversationId: number;
  role: string;
  content: string;
  createdAt: string | Date;
}

export default function Advisor() {
  const [activeConvId, setActiveConvId] = useState<number | null>(null);
  const [pendingNew, setPendingNew] = useState(false);
  const [message, setMessage] = useState("");
  const [streamingContent, setStreamingContent] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);
  const [copiedMsgId, setCopiedMsgId] = useState<number | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const { data: conversations, isLoading: convLoading } = useListAnthropicConversations({
    query: { queryKey: getListAnthropicConversationsQueryKey() },
  });
  const createConv = useCreateAnthropicConversation();
  const deleteConv = useDeleteAnthropicConversation();
  const runIntegrity = useRunIntegrityCheck();

  const { data: messages, isLoading: msgLoading } = useListAnthropicMessages(activeConvId ?? 0, {
    query: {
      queryKey: getListAnthropicMessagesQueryKey(activeConvId ?? 0),
      enabled: !!activeConvId,
    },
  });

  // Always-on cycle peek for header staleness banner
  const { data: cycle } = useGetDashboardCycle({
    query: { queryKey: getGetDashboardCycleQueryKey() },
  });

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, streamingContent]);

  // Auto-resize textarea
  useEffect(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = Math.min(ta.scrollHeight, 280) + "px";
  }, [message]);

  // Cancel any in-flight stream when the component unmounts
  useEffect(() => {
    return () => {
      abortRef.current?.abort();
    };
  }, []);

  const handleNewSession = () => {
    setActiveConvId(null);
    setPendingNew(true);
    setStreamingContent("");
    setMessage("");
    setTimeout(() => textareaRef.current?.focus(), 50);
  };

  const handleDeleteConversation = (id: number) => {
    if (!confirm("Delete this conversation?")) return;
    deleteConv.mutate(
      { id },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListAnthropicConversationsQueryKey() });
          if (activeConvId === id) setActiveConvId(null);
          toast({ title: "Conversation deleted" });
        },
      },
    );
  };

  const handleRefreshIntegrity = () => {
    runIntegrity.mutate(undefined, {
      onSuccess: (r) => {
        toast({
          title: `Integrity: ${r.overallStatus.toUpperCase()}`,
          description: `${r.checks.filter((c) => c.status === "fail").length} fail · ${r.checks.filter((c) => c.status === "warn").length} warn`,
        });
        queryClient.invalidateQueries({ queryKey: getGetDashboardCycleQueryKey() });
      },
    });
  };

  const streamResponse = useCallback(
    async (convId: number, content: string) => {
      setIsStreaming(true);
      setStreamingContent("");
      const ac = new AbortController();
      abortRef.current = ac;
      try {
        const response = await fetch(`${BASE_URL}/api/anthropic/conversations/${convId}/messages`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ content }),
          signal: ac.signal,
        });
        if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let accumulated = "";

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const parts = buffer.split("\n\n");
          buffer = parts.pop() ?? "";
          for (const part of parts) {
            const trimmed = part.trim();
            if (!trimmed.startsWith("data: ")) continue;
            try {
              const parsed = JSON.parse(trimmed.slice(6));
              if (parsed.done) {
                queryClient.invalidateQueries({ queryKey: getListAnthropicMessagesQueryKey(convId) });
                setStreamingContent("");
                setIsStreaming(false);
                return;
              }
              accumulated += parsed.content;
              setStreamingContent(accumulated);
            } catch {
              // skip malformed chunks
            }
          }
        }
        // stream ended without explicit done
        queryClient.invalidateQueries({ queryKey: getListAnthropicMessagesQueryKey(convId) });
        setStreamingContent("");
      } catch (err) {
        if ((err as Error).name === "AbortError") {
          queryClient.invalidateQueries({ queryKey: getListAnthropicMessagesQueryKey(convId) });
          setStreamingContent("");
          toast({ title: "Stopped", description: "Response generation cancelled." });
        } else {
          toast({
            title: "Failed to send message",
            description: (err as Error).message,
            variant: "destructive",
          });
        }
      } finally {
        abortRef.current = null;
        setIsStreaming(false);
      }
    },
    [queryClient, toast],
  );

  const handleSend = async (overrideContent?: string) => {
    const toSend = (overrideContent ?? message).trim();
    // Reentrancy guard: block if already streaming OR a lazy-create is in flight
    if (!toSend || isStreaming || createConv.isPending) return;

    setMessage("");

    // Lazy create: if no active conversation, make one with title from the message
    if (!activeConvId) {
      const title = toSend.length > 60 ? toSend.slice(0, 57).trim() + "…" : toSend;
      createConv.mutate(
        { data: { title } },
        {
          onSuccess: async (conv) => {
            queryClient.invalidateQueries({ queryKey: getListAnthropicConversationsQueryKey() });
            setActiveConvId(conv.id);
            setPendingNew(false);
            // Pulse integrity in background, non-blocking
            runIntegrity.mutate(undefined, {
              onSuccess: () => queryClient.invalidateQueries({ queryKey: getGetDashboardCycleQueryKey() }),
            });
            await streamResponse(conv.id, toSend);
          },
          onError: (err) => {
            toast({
              title: "Failed to start session",
              description: (err as Error).message,
              variant: "destructive",
            });
          },
        },
      );
      return;
    }

    await streamResponse(activeConvId, toSend);
  };

  const handleStop = () => {
    abortRef.current?.abort();
  };

  const handleRegenerate = async () => {
    if (!activeConvId || isStreaming) return;
    const list = (messages as Message[] | undefined) ?? [];
    // Find last user message
    const lastUser = [...list].reverse().find((m) => m.role === "user");
    if (!lastUser) {
      toast({ title: "Nothing to regenerate", variant: "destructive" });
      return;
    }
    // We don't have a delete-message endpoint, so simply re-ask the last user message.
    await streamResponse(activeConvId, lastUser.content + "\n\n(Regenerate the previous response with fresh reasoning.)");
  };

  const handleCopy = (id: number, content: string) => {
    navigator.clipboard.writeText(content);
    setCopiedMsgId(id);
    setTimeout(() => setCopiedMsgId(null), 1200);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Enter sends, Shift+Enter newline
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const allMessages = (messages as Message[] | undefined) ?? [];
  const lastAssistantId = [...allMessages].reverse().find((m) => m.role === "assistant")?.id ?? null;
  const isStale = cycle?.daysSinceUpdate != null && cycle.daysSinceUpdate > 3;

  return (
    <TooltipProvider delayDuration={300}>
      <div className="flex h-[calc(100vh-8rem)] gap-4 max-w-[1600px] mx-auto" data-testid="advisor-root">
        {/* Sidebar */}
        <div className="w-64 flex flex-col gap-3 shrink-0">
          <Button
            onClick={handleNewSession}
            disabled={createConv.isPending}
            data-testid="button-new-conversation"
            className="w-full"
          >
            <Plus className="mr-2 h-4 w-4" />New Session
          </Button>

          <div className="flex-1 overflow-y-auto space-y-1 -mr-2 pr-2">
            {convLoading && <Skeleton className="h-10 w-full" />}
            {!convLoading && (!conversations || conversations.length === 0) && !pendingNew && (
              <p className="text-xs text-muted-foreground px-2 py-4">No sessions yet. Start a new one.</p>
            )}
            {((conversations as Conversation[] | undefined) ?? []).map((conv) => (
              <div
                key={conv.id}
                className={cn(
                  "flex items-center gap-2 p-2 rounded-lg cursor-pointer group transition-colors",
                  activeConvId === conv.id ? "bg-primary/10 border border-primary/20" : "hover:bg-muted/50 border border-transparent",
                )}
                onClick={() => {
                  setActiveConvId(conv.id);
                  setPendingNew(false);
                }}
                data-testid={`button-conversation-${conv.id}`}
              >
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium truncate" title={conv.title}>{conv.title}</div>
                  <div className="text-[11px] text-muted-foreground flex items-center gap-1">
                    <Clock className="h-2.5 w-2.5" />
                    {formatDate(conv.createdAt)}
                  </div>
                </div>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-6 w-6 opacity-0 group-hover:opacity-100"
                  onClick={(e) => {
                    e.stopPropagation();
                    handleDeleteConversation(conv.id);
                  }}
                  data-testid={`button-delete-conversation-${conv.id}`}
                >
                  <Trash2 className="h-3 w-3" />
                </Button>
              </div>
            ))}
          </div>
        </div>

        {/* Chat area */}
        <div className="flex-1 flex flex-col gap-3 min-w-0">
          {/* Header bar: status + snapshot + actions */}
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <div className="flex items-center gap-2">
              {isStale && (
                <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-amber-500/10 text-amber-700 dark:text-amber-300 text-xs">
                  <AlertTriangle className="h-3.5 w-3.5" />
                  <span>Checking balance is {cycle?.daysSinceUpdate}d stale — cycle answers may be refused.</span>
                </div>
              )}
              {!isStale && cycle && (
                <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 text-xs">
                  <CheckCircle2 className="h-3.5 w-3.5" />
                  <span>Live data current ({cycle.daysSinceUpdate ?? 0}d ago)</span>
                </div>
              )}
            </div>
            <div className="flex items-center gap-2">
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={handleRefreshIntegrity}
                    disabled={runIntegrity.isPending}
                    data-testid="button-refresh-integrity"
                  >
                    <RefreshCw className={cn("mr-2 h-3.5 w-3.5", runIntegrity.isPending && "animate-spin")} />
                    Re-check
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Run integrity audit on live data</TooltipContent>
              </Tooltip>
              <AdvisorSnapshotDrawer />
            </div>
          </div>

          {/* Messages */}
          <div className="flex-1 overflow-y-auto min-h-0 -mx-2 px-2">
            {!activeConvId ? (
              <EmptyState onPickPrompt={(p) => handleSend(p)} disabled={isStreaming || createConv.isPending} />
            ) : (
              <div className="space-y-4">
                {msgLoading && <Skeleton className="h-16 w-full" />}
                {allMessages.map((msg) => (
                  <MessageBubble
                    key={msg.id}
                    msg={msg}
                    copied={copiedMsgId === msg.id}
                    onCopy={() => handleCopy(msg.id, msg.content)}
                    onRegenerate={msg.id === lastAssistantId && !isStreaming ? handleRegenerate : undefined}
                  />
                ))}
                {isStreaming && streamingContent && (
                  <div className="flex gap-3 justify-start">
                    <BotAvatar />
                    <div className="max-w-[85%] px-4 py-3 rounded-2xl rounded-tl-sm bg-muted">
                      <AdvisorMarkdown content={streamingContent} />
                      <span className="inline-block w-1.5 h-4 bg-primary/60 ml-0.5 align-middle animate-pulse" />
                    </div>
                  </div>
                )}
                {isStreaming && !streamingContent && (
                  <div className="flex gap-3">
                    <BotAvatar />
                    <div className="px-4 py-3 rounded-2xl rounded-tl-sm bg-muted">
                      <div className="flex gap-1 items-center h-5">
                        <div className="w-2 h-2 rounded-full bg-muted-foreground/60 animate-bounce" style={{ animationDelay: "0ms" }} />
                        <div className="w-2 h-2 rounded-full bg-muted-foreground/60 animate-bounce" style={{ animationDelay: "150ms" }} />
                        <div className="w-2 h-2 rounded-full bg-muted-foreground/60 animate-bounce" style={{ animationDelay: "300ms" }} />
                      </div>
                    </div>
                  </div>
                )}
                <div ref={messagesEndRef} />
              </div>
            )}
          </div>

          {/* Quick prompt strip (only when there's an active conv with messages) */}
          {activeConvId && allMessages.length > 0 && !isStreaming && (
            <div className="flex gap-1.5 overflow-x-auto pb-1 -mx-2 px-2 scrollbar-thin">
              {SUGGESTED_PROMPTS.slice(0, 4).map((p) => (
                <Button
                  key={p.label}
                  variant="outline"
                  size="sm"
                  className="shrink-0 h-7 text-[11px] font-normal text-muted-foreground hover:text-foreground"
                  onClick={() => handleSend(p.prompt)}
                  data-testid={`button-quick-${p.label.replace(/\s+/g, "-").toLowerCase()}`}
                >
                  <Sparkles className="mr-1.5 h-3 w-3" />
                  {p.label}
                </Button>
              ))}
            </div>
          )}

          {/* Composer */}
          <div className="flex gap-2 items-end">
            <div className="flex-1 relative">
              <Textarea
                ref={textareaRef}
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder={
                  activeConvId
                    ? "Ask anything — what-if scenarios, audits, decisions, projections…"
                    : "Type your first question — a session will be created automatically."
                }
                disabled={isStreaming || createConv.isPending}
                rows={1}
                className="resize-none min-h-[44px] pr-12 leading-relaxed"
                data-testid="input-message"
              />
              <div className="absolute bottom-2 right-2 text-[10px] text-muted-foreground/60 pointer-events-none font-mono">
                {message.length > 0 ? `${message.length}` : "↵ to send · ⇧↵ newline"}
              </div>
            </div>
            {isStreaming ? (
              <Button
                onClick={handleStop}
                variant="destructive"
                size="icon"
                className="h-11 w-11"
                aria-label="Stop generating response"
                data-testid="button-stop-message"
              >
                <StopCircle className="h-4 w-4" />
              </Button>
            ) : (
              <Button
                onClick={() => handleSend()}
                disabled={!message.trim() || createConv.isPending}
                size="icon"
                className="h-11 w-11"
                aria-label="Send message"
                data-testid="button-send-message"
              >
                <Send className="h-4 w-4" />
              </Button>
            )}
          </div>
        </div>
      </div>
    </TooltipProvider>
  );
}

function BotAvatar() {
  return (
    <div className="h-8 w-8 rounded-full bg-primary/10 flex items-center justify-center shrink-0 mt-1">
      <Bot className="h-4 w-4 text-primary" />
    </div>
  );
}

function UserAvatar() {
  return (
    <div className="h-8 w-8 rounded-full bg-primary/20 flex items-center justify-center shrink-0 mt-1">
      <User className="h-4 w-4 text-primary" />
    </div>
  );
}

interface MessageBubbleProps {
  msg: Message;
  copied: boolean;
  onCopy: () => void;
  onRegenerate?: () => void;
}

function MessageBubble({ msg, copied, onCopy, onRegenerate }: MessageBubbleProps) {
  const isUser = msg.role === "user";
  const decisionLog = !isUser ? extractDecisionLog(msg.content) : null;

  return (
    <div className={cn("flex gap-3", isUser ? "justify-end" : "justify-start")} data-testid={`message-${msg.id}`}>
      {!isUser && <BotAvatar />}
      <div className={cn("max-w-[85%] flex flex-col gap-1.5 group", isUser && "items-end")}>
        <div
          className={cn(
            "px-4 py-3 rounded-2xl text-sm leading-relaxed",
            isUser
              ? "bg-primary text-primary-foreground rounded-tr-sm whitespace-pre-wrap"
              : "bg-muted rounded-tl-sm",
          )}
        >
          {isUser ? msg.content : <AdvisorMarkdown content={msg.content} />}
        </div>

        {/* Decision Log card */}
        {decisionLog && (
          <div className="flex items-center gap-2 px-3 py-2 rounded-lg border border-primary/30 bg-primary/5 text-xs w-full">
            <ClipboardList className="h-3.5 w-3.5 text-primary shrink-0" />
            <span className="font-mono flex-1 truncate" title={decisionLog}>{decisionLog}</span>
            <Button
              variant="ghost"
              size="icon"
              className="h-6 w-6"
              onClick={() => navigator.clipboard.writeText(decisionLog)}
              title="Copy decision log entry"
            >
              <Copy className="h-3 w-3" />
            </Button>
          </div>
        )}

        {/* Action toolbar — assistant only */}
        {!isUser && (
          <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
            <Button
              variant="ghost"
              size="sm"
              className="h-6 px-2 text-[11px] text-muted-foreground"
              onClick={onCopy}
              data-testid={`button-copy-${msg.id}`}
            >
              {copied ? <Check className="mr-1 h-3 w-3 text-emerald-500" /> : <Copy className="mr-1 h-3 w-3" />}
              {copied ? "Copied" : "Copy"}
            </Button>
            {onRegenerate && (
              <Button
                variant="ghost"
                size="sm"
                className="h-6 px-2 text-[11px] text-muted-foreground"
                onClick={onRegenerate}
                data-testid={`button-regenerate-${msg.id}`}
              >
                <RefreshCw className="mr-1 h-3 w-3" />
                Regenerate
              </Button>
            )}
            <span className="text-[10px] text-muted-foreground/60 ml-1">{formatTime(msg.createdAt)}</span>
          </div>
        )}
        {isUser && (
          <span className="text-[10px] text-muted-foreground/60 opacity-0 group-hover:opacity-100 transition-opacity">
            {formatTime(msg.createdAt)}
          </span>
        )}
      </div>
      {isUser && <UserAvatar />}
    </div>
  );
}

function EmptyState({
  onPickPrompt,
  disabled,
}: {
  onPickPrompt: (prompt: string) => void;
  disabled: boolean;
}) {
  return (
    <div className="h-full flex flex-col items-center justify-center py-12 px-4">
      <div className="text-center mb-8 max-w-xl">
        <div className="inline-flex items-center justify-center h-14 w-14 rounded-full bg-primary/10 mb-4">
          <Bot className="h-7 w-7 text-primary" />
        </div>
        <h2 className="text-2xl font-semibold tracking-tight mb-2">Reserve Advisor</h2>
        <p className="text-sm text-muted-foreground leading-relaxed">
          Direct access to a financial advisor with the full Reserve Playbook v7.4 internalized and live read access to every number in your engine. No generic finance content. No softening. Real math against real data.
        </p>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 w-full max-w-2xl">
        {SUGGESTED_PROMPTS.map((p) => (
          <Card
            key={p.label}
            className={cn(
              "cursor-pointer hover-elevate transition-all border-border/60",
              disabled && "opacity-50 pointer-events-none",
            )}
            onClick={() => onPickPrompt(p.prompt)}
            data-testid={`card-prompt-${p.label.replace(/\s+/g, "-").toLowerCase()}`}
          >
            <CardContent className="p-3">
              <div className="flex items-start gap-2">
                <Sparkles className="h-3.5 w-3.5 text-primary mt-0.5 shrink-0" />
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium mb-0.5">{p.label}</div>
                  <div className="text-xs text-muted-foreground line-clamp-2">{p.prompt}</div>
                </div>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
      <p className="text-[11px] text-muted-foreground/70 mt-6 font-mono uppercase tracking-wider">
        Or type your own question below
      </p>
    </div>
  );
}

function extractDecisionLog(content: string): string | null {
  // Match "Decision Log [date]: ..." across either single-line or multi-line forms.
  // Captures everything until the next blank line, end of string, or a new top-level heading.
  const match = content.match(/Decision Log\s*(?:\[[^\]]+\])?\s*:\s*([\s\S]+?)(?:\n\s*\n|\n#{1,3} |$)/i);
  if (!match) return null;
  const tail = match[1].replace(/\s+/g, " ").trim();
  return tail ? `Decision Log: ${tail}` : null;
}

function formatTime(d: string | Date): string {
  const date = typeof d === "string" ? new Date(d) : d;
  return date.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
}
