import { Router, type IRouter } from "express";
import { db, conversations, messages, playbookVersions } from "@workspace/db";
import { eq, asc, desc } from "drizzle-orm";
import { anthropic } from "@workspace/integrations-anthropic-ai";
import {
  ListAnthropicConversationsResponse,
  CreateAnthropicConversationBody,
  GetAnthropicConversationParams,
  GetAnthropicConversationResponse,
  DeleteAnthropicConversationParams,
  ListAnthropicMessagesParams,
  ListAnthropicMessagesResponse,
  SendAnthropicMessageParams,
  SendAnthropicMessageBody,
} from "@workspace/api-zod";

const router: IRouter = Router();

router.get("/anthropic/conversations", async (_req, res): Promise<void> => {
  const rows = await db.select().from(conversations).orderBy(desc(conversations.createdAt));
  res.json(ListAnthropicConversationsResponse.parse(rows));
});

router.post("/anthropic/conversations", async (req, res): Promise<void> => {
  const parsed = CreateAnthropicConversationBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const [row] = await db
    .insert(conversations)
    .values({ title: parsed.data.title })
    .returning();
  if (!row) {
    res.status(500).json({ error: "Failed to create conversation" });
    return;
  }
  res.status(201).json(row);
});

router.get("/anthropic/conversations/:id", async (req, res): Promise<void> => {
  const params = GetAnthropicConversationParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const [conv] = await db.select().from(conversations).where(eq(conversations.id, params.data.id));
  if (!conv) {
    res.status(404).json({ error: "Conversation not found" });
    return;
  }
  const msgs = await db
    .select()
    .from(messages)
    .where(eq(messages.conversationId, params.data.id))
    .orderBy(asc(messages.createdAt));
  res.json(GetAnthropicConversationResponse.parse({ ...conv, messages: msgs }));
});

router.delete("/anthropic/conversations/:id", async (req, res): Promise<void> => {
  const params = DeleteAnthropicConversationParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const [row] = await db.delete(conversations).where(eq(conversations.id, params.data.id)).returning();
  if (!row) {
    res.status(404).json({ error: "Conversation not found" });
    return;
  }
  res.sendStatus(204);
});

router.get("/anthropic/conversations/:id/messages", async (req, res): Promise<void> => {
  const params = ListAnthropicMessagesParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const rows = await db
    .select()
    .from(messages)
    .where(eq(messages.conversationId, params.data.id))
    .orderBy(asc(messages.createdAt));
  res.json(ListAnthropicMessagesResponse.parse(rows));
});

router.post("/anthropic/conversations/:id/messages", async (req, res): Promise<void> => {
  const params = SendAnthropicMessageParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const parsed = SendAnthropicMessageBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const [conv] = await db.select().from(conversations).where(eq(conversations.id, params.data.id));
  if (!conv) {
    res.status(404).json({ error: "Conversation not found" });
    return;
  }

  // Save user message
  await db.insert(messages).values({
    conversationId: params.data.id,
    role: "user",
    content: parsed.data.content,
  });

  // Get full conversation history
  const history = await db
    .select()
    .from(messages)
    .where(eq(messages.conversationId, params.data.id))
    .orderBy(asc(messages.createdAt));

  // Get latest playbook for system context
  const [playbook] = await db.select().from(playbookVersions).orderBy(desc(playbookVersions.effectiveFrom)).limit(1);
  const playbookContent = playbook?.content ?? "No playbook loaded.";

  const systemPrompt = `You are Reserve's financial advisor for Marshall Roberts-Payne, an Account Executive at Odoo Inc. with variable commission income. You have deep knowledge of his complete financial picture through the Reserve personal finance system.

Your role is to provide specific, methodologically rigorous financial guidance based on the Reserve Financial Playbook. You know every rule, every formula, and every constraint in the system.

PLAYBOOK (your permanent operating context):
${playbookContent}

Core behavior:
- Be precise and quantitative. Reference specific numbers from the financial data when available.
- Never deviate from the 10 Methodology Rules in the playbook.
- When asked about Safe to Spend or cycle analysis, always verify data freshness first.
- Distinguish clearly between confirmed and expected commission income.
- Be direct. Marshall is a technical user who wants signal, not padding.
- If a question would require stale data, say so and ask them to update the balance first.`;

  // Set up SSE
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");

  const anthropicMessages = history.map((m) => ({
    role: m.role as "user" | "assistant",
    content: m.content,
  }));

  let assistantContent = "";

  const stream = await anthropic.messages.stream({
    model: "claude-opus-4-5",
    max_tokens: 4096,
    system: systemPrompt,
    messages: anthropicMessages,
  });

  for await (const chunk of stream) {
    if (chunk.type === "content_block_delta" && chunk.delta.type === "text_delta") {
      const text = chunk.delta.text;
      assistantContent += text;
      res.write(`data: ${JSON.stringify({ content: text, done: false })}\n\n`);
    }
  }

  // Save assistant response
  await db.insert(messages).values({
    conversationId: params.data.id,
    role: "assistant",
    content: assistantContent,
  });

  res.write(`data: ${JSON.stringify({ content: "", done: true })}\n\n`);
  res.end();
});

export default router;
