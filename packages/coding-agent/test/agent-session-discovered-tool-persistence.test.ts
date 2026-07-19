import { describe, expect, it } from "bun:test";
import type { AgentTool } from "@gajae-code/agent-core";
import { buildSessionContext, SessionManager } from "../src/session/session-manager";
import { selectRestorableDiscoveredBuiltinToolNames } from "../src/tool-discovery/tool-index";

function builtin(name: string, loadMode: "discoverable" | "essential" | "none" = "discoverable"): AgentTool {
	return {
		name,
		label: name,
		description: name,
		parameters: { type: "object", properties: {} },
		execute: async () => ({ content: [{ type: "text", text: name }] }),
		loadMode: loadMode === "none" ? undefined : loadMode,
	} as AgentTool;
}

describe("discovered built-in tool persistence", () => {
	it("persists built-in-only selections in an old-reader-safe custom envelope", () => {
		const session = SessionManager.inMemory();
		session.appendDiscoveredBuiltinToolSelection(["search_tool_bm25"]);

		const context = session.buildSessionContext();
		expect(context.selectedDiscoveredBuiltinToolNames).toEqual(["search_tool_bm25"]);
		expect(context.hasPersistedMCPToolSelection).toBe(false);

		session.appendDiscoveredBuiltinToolSelection([]);
		expect(session.buildSessionContext().selectedDiscoveredBuiltinToolNames).toEqual([]);
	});

	it("keeps combined MCP and built-in selection changes atomic", () => {
		const session = SessionManager.inMemory();
		session.appendMCPToolSelection(["mcp__docs_search"], ["search_tool_bm25"]);

		expect(session.buildSessionContext()).toMatchObject({
			selectedMCPToolNames: ["mcp__docs_search"],
			selectedDiscoveredBuiltinToolNames: ["search_tool_bm25"],
			hasPersistedMCPToolSelection: true,
		});
	});

	it("keeps the prior built-in selection when a later legacy envelope omits the field", () => {
		const session = SessionManager.inMemory();
		session.appendMCPToolSelection(["mcp__docs_search"], ["search_tool_bm25"]);
		session.appendMCPToolSelection(["mcp__other_search"]);

		const context = session.buildSessionContext();
		expect(context.selectedMCPToolNames).toEqual(["mcp__other_search"]);
		expect(context.selectedDiscoveredBuiltinToolNames).toEqual(["search_tool_bm25"]);
	});

	it("preserves legacy entries without a built-in selection field", () => {
		const context = buildSessionContext([
			{
				type: "mcp_tool_selection",
				id: "selection",
				parentId: null,
				timestamp: new Date(0).toISOString(),
				selectedToolNames: ["mcp__docs_search"],
			},
		]);
		expect(context.selectedMCPToolNames).toEqual(["mcp__docs_search"]);
		expect(context.selectedDiscoveredBuiltinToolNames).toBeUndefined();
	});

	it("restores only still-eligible discoverable built-ins", () => {
		const registry = new Map<string, AgentTool>([
			["search_tool_bm25", builtin("search_tool_bm25")],
			["goal", builtin("goal", "essential")],
			["hidden_tool", builtin("hidden_tool", "none")],
			["disallowed_tool", builtin("disallowed_tool")],
		]);
		expect(
			selectRestorableDiscoveredBuiltinToolNames(
				["search_tool_bm25", "goal", "hidden_tool", "disallowed_tool", "removed_tool", "search_tool_bm25"],
				registry,
				new Set(["search_tool_bm25", "goal", "hidden_tool"]),
			),
		).toEqual(["search_tool_bm25"]);
	});
});
