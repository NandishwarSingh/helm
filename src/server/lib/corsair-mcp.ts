import "server-only";

import { createMCPClient } from "@ai-sdk/mcp";
import { buildCorsairToolDefs } from "@corsair-dev/mcp";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { type ToolSet } from "ai";
import { z } from "zod";

import { corsair } from "@/server/corsair";
import {
  type DestructiveGate,
  runScriptSandboxed,
} from "@/server/lib/run-script-sandbox";

/**
 * Bridges Corsair's MCP server into the Vercel AI SDK, in-process.
 *
 * We build the server from Corsair's own tool definitions (`list_operations`,
 * `get_schema`, `run_script`) but replace `run_script`'s host execution: stock
 * Corsair runs the model's code with `new Function` in the server process, which
 * is arbitrary code execution reachable by email-borne prompt injection. Instead
 * we run it through an isolated-vm sandbox (see run-script-sandbox.ts) — a bare
 * V8 isolate with no Node globals and only an allowlisted, tenant-scoped
 * `corsair` bridge. The introspection tools are kept verbatim.
 *
 * The server is wired to an AI SDK client over a linked in-memory transport
 * pair, so the agent route receives ordinary AI SDK tools while every call
 * still travels the real MCP protocol. Everything is scoped to `tenantId`.
 */
export async function createCorsairMcp(tenantId: string) {
  const tenant = corsair.withTenant(tenantId);

  // The LLM loop never EXECUTES a destructive op — it STAGES one, which the
  // sandbox captures into `gate.proposed`. The user approves it on a card and
  // the route replays the signed action verbatim, so the gate stays unconfirmed
  // here: every destructive call is intercepted and captured, never run.
  const gate: DestructiveGate = { confirmed: false, budget: { remaining: 0 } };

  const server = new McpServer({
    name: "corsair",
    version: "1.0.0",
    description:
      "Interact with the user's Gmail and Google Calendar through Corsair.",
  });

  const sandboxedRunScript = async (
    args: Record<string, unknown>,
  ): Promise<CallToolResult> => {
    const code = typeof args.code === "string" ? args.code : "";
    const result = await runScriptSandboxed(tenant, code, gate);
    if (!result.ok) {
      return { isError: true, content: [{ type: "text", text: `Error: ${result.error}` }] };
    }
    return {
      content: [{ type: "text", text: JSON.stringify(result.value ?? null, null, 2) }],
    };
  };

  for (const def of buildCorsairToolDefs({ corsair: tenant, tenantId, setup: false })) {
    const handler = def.name === "run_script" ? sandboxedRunScript : def.handler;
    server.registerTool(
      def.name,
      { description: def.description, inputSchema: z.object(def.shape) },
      handler,
    );
  }

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);

  // `@ai-sdk/mcp` and `ai` resolve `provider-utils` at slightly different
  // versions, so their `Schema` brands differ at the type level even though the
  // tools are built to drop straight into `streamText`. Reconcile the two SDK
  // type-universes here, at the bridge seam.
  const client = await createMCPClient({ transport: clientTransport });
  const tools = (await client.tools()) as unknown as ToolSet;

  return {
    tools,
    /** Staged-action gate; read `gate.proposed` once the stream has finished. */
    gate,
    /** Tear the client and server down once the stream has finished. */
    async close() {
      await client.close().catch(() => undefined);
      await server.close().catch(() => undefined);
    },
  };
}
