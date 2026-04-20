import { useState, useRef, useEffect } from "react";
import {
  useListAnthropicConversations,
  getListAnthropicConversationsQueryKey,
  useCreateAnthropicConversation,
  useListAnthropicMessages,
  getListAnthropicMessagesQueryKey,
  useDeleteAnthropicConversation,
  useRunIntegrityCheck,
} from "@workspace/api-client-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Plus, Send, Trash2, Bot, User, AlertTriangle, CheckCircle2 } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { formatDate } from "@/lib/utils";

const BASE_URL = import.meta.env.BASE_URL.replace(/\/$/, "");

export default function Advisor() {
  const [activeConvId, setActiveConvId] = useState<number | null>(null);
  const [message, setMessage] = useState("");
  const [streamingContent, setStreamingContent] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);
  const [integrityStatus, setIntegrityStatus] = useState<{ status: string; failCount: number; warnCount: number } | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const { data: conversations, isLoading: convLoading } = useListAnthropicConversations({
    query: { queryKey: getListAnthropicConversationsQueryKey() }
  });
  const createConv = useCreateAnthropicConversation();
  const deleteConv = useDeleteAnthropicConversation();
  const runIntegrity = useRunIntegrityCheck();

  const { data: messages, isLoading: msgLoading } = useListAnthropicMessages(
    activeConvId ?? 0,
    { query: { queryKey: getListAnthropicMessagesQueryKey(activeConvId ?? 0), enabled: !!activeConvId } }
  );

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, streamingContent]);

  const handleNewConversation = async () => {
    const title = `Session ${new Date().toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}`;
    createConv.mutate({ data: { title } }, {
      onSuccess: async (conv) => {
        queryClient.invalidateQueries({ queryKey: getListAnthropicConversationsQueryKey() });
        setActiveConvId(conv.id);

        // Run integrity check and show status
        runIntegrity.mutate(undefined, {
          onSuccess: (result) => {
            const failCount = result.checks.filter((c) => c.status === "fail").length;
            const warnCount = result.checks.filter((c) => c.status === "warn").length;
            setIntegrityStatus({ status: result.overallStatus, failCount, warnCount });
          },
        });
      },
    });
  };

  const handleDeleteConversation = (id: number) => {
    if (!confirm("Delete this conversation?")) return;
    deleteConv.mutate({ id }, {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListAnthropicConversationsQueryKey() });
        if (activeConvId === id) setActiveConvId(null);
        toast({ title: "Conversation deleted" });
      },
    });
  };

  const handleSend = async () => {
    if (!activeConvId || !message.trim() || isStreaming) return;
    const toSend = message.trim();
    setMessage("");
    setIsStreaming(true);
    setStreamingContent("");

    try {
      const response = await fetch(`${BASE_URL}/api/anthropic/conversations/${activeConvId}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: toSend }),
      });

      if (!response.ok || !response.body) {
        throw new Error("Failed to get response");
      }

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
          const jsonStr = trimmed.slice(6);
          try {
            const parsed = JSON.parse(jsonStr);
            if (parsed.done) {
              setIsStreaming(false);
              queryClient.invalidateQueries({ queryKey: getListAnthropicMessagesQueryKey(activeConvId) });
              setStreamingContent("");
            } else {
              accumulated += parsed.content;
              setStreamingContent(accumulated);
            }
          } catch {
            // skip malformed chunks
          }
        }
      }
    } catch (err) {
      toast({ title: "Failed to send message", variant: "destructive" });
    } finally {
      setIsStreaming(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const allMessages = messages ?? [];

  return (
    <div className="flex h-[calc(100vh-8rem)] gap-4 max-w-6xl mx-auto">
      {/* Sidebar */}
      <div className="w-72 flex flex-col gap-3 shrink-0">
        <Button onClick={handleNewConversation} disabled={createConv.isPending} data-testid="button-new-conversation" className="w-full">
          <Plus className="mr-2 h-4 w-4" />New Session
        </Button>

        <div className="flex-1 overflow-y-auto space-y-1">
          {convLoading && <Skeleton className="h-10 w-full" />}
          {!convLoading && (!conversations || conversations.length === 0) && (
            <p className="text-xs text-muted-foreground px-2">No sessions yet. Start a new one.</p>
          )}
          {(conversations ?? []).map((conv) => (
            <div
              key={conv.id}
              className={`flex items-center gap-2 p-2 rounded-lg cursor-pointer group transition-colors ${activeConvId === conv.id ? "bg-primary/10 border border-primary/20" : "hover:bg-muted/50"}`}
              onClick={() => setActiveConvId(conv.id)}
              data-testid={`button-conversation-${conv.id}`}
            >
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium truncate">{conv.title}</div>
                <div className="text-xs text-muted-foreground">{formatDate(conv.createdAt)}</div>
              </div>
              <Button
                variant="ghost"
                size="icon"
                className="h-6 w-6 opacity-0 group-hover:opacity-100"
                onClick={(e) => { e.stopPropagation(); handleDeleteConversation(conv.id); }}
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
        {!activeConvId ? (
          <Card className="flex-1 flex items-center justify-center">
            <CardContent className="text-center py-16">
              <Bot className="h-16 w-16 mx-auto mb-4 text-muted-foreground/30" />
              <h2 className="text-xl font-semibold mb-2">Reserve Financial Advisor</h2>
              <p className="text-muted-foreground text-sm max-w-sm">
                Your AI advisor has full context of the Reserve playbook and methodology rules.
                Start a new session to begin.
              </p>
            </CardContent>
          </Card>
        ) : (
          <>
            {integrityStatus && (
              <div className={`flex items-center gap-2 px-3 py-2 rounded-lg text-sm ${
                integrityStatus.status === "pass" ? "bg-emerald-50 dark:bg-emerald-950/30 text-emerald-700 dark:text-emerald-300" :
                integrityStatus.status === "fail" ? "bg-destructive/10 text-destructive" :
                "bg-amber-50 dark:bg-amber-950/30 text-amber-700 dark:text-amber-300"
              }`} data-testid="status-integrity">
                {integrityStatus.status === "pass" ? <CheckCircle2 className="h-4 w-4" /> : <AlertTriangle className="h-4 w-4" />}
                <span className="font-medium">Integrity: {integrityStatus.status.toUpperCase()}</span>
                {integrityStatus.failCount > 0 && <span>{integrityStatus.failCount} failure(s)</span>}
                {integrityStatus.warnCount > 0 && <span>{integrityStatus.warnCount} warning(s)</span>}
              </div>
            )}

            <div className="flex-1 overflow-y-auto space-y-4 min-h-0">
              {msgLoading && <Skeleton className="h-16 w-full" />}
              {allMessages.map((msg) => (
                <div key={msg.id} className={`flex gap-3 ${msg.role === "user" ? "justify-end" : "justify-start"}`} data-testid={`message-${msg.id}`}>
                  {msg.role === "assistant" && (
                    <div className="h-8 w-8 rounded-full bg-primary/10 flex items-center justify-center shrink-0 mt-1">
                      <Bot className="h-4 w-4 text-primary" />
                    </div>
                  )}
                  <div className={`max-w-[75%] px-4 py-3 rounded-2xl text-sm leading-relaxed whitespace-pre-wrap ${
                    msg.role === "user"
                      ? "bg-primary text-primary-foreground rounded-tr-sm"
                      : "bg-muted rounded-tl-sm"
                  }`}>
                    {msg.content}
                  </div>
                  {msg.role === "user" && (
                    <div className="h-8 w-8 rounded-full bg-primary/20 flex items-center justify-center shrink-0 mt-1">
                      <User className="h-4 w-4 text-primary" />
                    </div>
                  )}
                </div>
              ))}

              {isStreaming && streamingContent && (
                <div className="flex gap-3 justify-start">
                  <div className="h-8 w-8 rounded-full bg-primary/10 flex items-center justify-center shrink-0 mt-1">
                    <Bot className="h-4 w-4 text-primary" />
                  </div>
                  <div className="max-w-[75%] px-4 py-3 rounded-2xl rounded-tl-sm text-sm leading-relaxed whitespace-pre-wrap bg-muted">
                    {streamingContent}
                    <span className="inline-block w-1.5 h-4 bg-primary/60 ml-0.5 animate-pulse" />
                  </div>
                </div>
              )}

              {isStreaming && !streamingContent && (
                <div className="flex gap-3">
                  <div className="h-8 w-8 rounded-full bg-primary/10 flex items-center justify-center shrink-0">
                    <Bot className="h-4 w-4 text-primary" />
                  </div>
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

            <div className="flex gap-2">
              <Input
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="Ask your advisor..."
                disabled={isStreaming}
                className="flex-1"
                data-testid="input-message"
              />
              <Button onClick={handleSend} disabled={!message.trim() || isStreaming} data-testid="button-send-message">
                <Send className="h-4 w-4" />
              </Button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
