import "server-only";

import { createMCPClient } from "@ai-sdk/mcp";
import { createBaseMcpServer } from "@corsair-dev/mcp";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { type ToolSet } from "ai";

import { corsair } from "@/server/corsair";

/**
 * Bridges Corsair's MCP server into the Vercel AI SDK, in-process.
 *
 * `@corsair-dev/mcp` turns a Corsair instance into a genuine MCP server exposing
 * three tools — `list_operations`, `get_schema` and `run_script` — that together
 * cover the whole Gmail + Calendar surface. Rather than a loopback HTTP hop we
 * wire that server to an AI SDK client over a linked in-memory transport pair:
 * the agent route receives ordinary AI SDK tools, but every call travels the
 * real MCP protocol (JSON-RPC over the transport).
 *
 * The server is built from `corsair.withTenant(tenantId)`, so the `corsair`
 * variable inside `run_script` is already scoped to the signed-in user — the
 * agent physically cannot reach another tenant's mailbox or calendar.
 */
export async function createCorsairMcp(tenantId: string) {
  const tenant = corsair.withTenant(tenantId);

  const server = createBaseMcpServer({
    // Scoped client: run_script executes strictly as this tenant.
    corsair: tenant,
    tenantId,
    // The account is already connected; the setup tool would only distract the agent.
    setup: false,
  });

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);

  // InMemoryTransport (MCP SDK) is structurally an AI SDK MCPTransport — both
  // declare start/send/close/onmessage/onclose/onerror — so it drops straight in.
  const client = await createMCPClient({
    transport: clientTransport,
  });

  // `@ai-sdk/mcp` and `ai` resolve `provider-utils` at slightly different
  // versions, so their `Schema` brands differ at the type level even though the
  // tools are built to drop straight into `streamText`. Reconcile the two SDK
  // type-universes here, at the bridge seam, rather than leaking the cast out.
  const tools = (await client.tools()) as unknown as ToolSet;

  return {
    tools,
    /** Tear down the client and server once the stream has finished. */
    async close() {
      await client.close().catch(() => undefined);
      await server.close().catch(() => undefined);
    },
  };
}
