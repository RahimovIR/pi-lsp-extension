/**
 * lsp_rename — Preview a rename refactoring across the workspace.
 * Returns planned edits but does NOT apply them.
 */

import { Type } from "typebox";
import type { WorkspaceEdit, TextEdit } from "vscode-languageserver-protocol";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { truncateHead, DEFAULT_MAX_LINES, DEFAULT_MAX_BYTES } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import type { LspManager } from "../lsp-manager.js";
import type { TreeSitterManager } from "../tree-sitter/parser-manager.js";
import { resolveSymbolPosition, getSymbolNames } from "../shared/resolve-position.js";
import { fileURLToPath } from "node:url";
import { relative, join } from "node:path";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";

export function formatWorkspaceEdit(edit: WorkspaceEdit, rootDir: string): { summary: string; fileCount: number; editCount: number; resourceOperations: number } {
  const lines: string[] = [];
  const files = new Set<string>();
  let editCount = 0;
  let resourceOperations = 0;
  const appendEdits = (uri: string, edits: TextEdit[], version?: number | null) => {
    files.add(uri);
    let file: string;
    try { file = relative(rootDir, fileURLToPath(uri)); } catch { file = uri; }
    lines.push(`${file}${version !== undefined ? ` (document version: ${version ?? "unspecified"})` : ""}:`);
    for (const textEdit of edits) {
      const { start, end } = textEdit.range;
      lines.push(`  ${start.line + 1}:${start.character + 1}-${end.line + 1}:${end.character + 1} → ${JSON.stringify(textEdit.newText)}`);
      editCount++;
    }
  };
  if (edit.documentChanges) {
    for (const change of edit.documentChanges) {
      if ("textDocument" in change) {
        appendEdits(change.textDocument.uri, change.edits as TextEdit[], change.textDocument.version);
      } else {
        resourceOperations++;
        lines.push(`Resource operation: ${JSON.stringify(change)}`);
      }
    }
  }
  for (const [uri, edits] of Object.entries(edit.changes ?? {})) appendEdits(uri, edits);
  return { summary: lines.join("\n"), fileCount: files.size, editCount, resourceOperations };
}

const RenameParams = Type.Object({
  path: Type.String({ description: "File path" }),
  line: Type.Optional(Type.Number({ description: "Line number (1-indexed). Required unless query is provided." })),
  character: Type.Optional(Type.Number({ description: "Column number (1-indexed). Required unless query is provided." })),
  query: Type.Optional(Type.String({ description: "Symbol name to find in the file. Alternative to line/character — resolves the symbol's position automatically." })),
  newName: Type.String({ description: "New name for the symbol" }),
});

interface RenameDetails {
  fileCount: number;
  editCount: number;
  workspaceEdit?: WorkspaceEdit;
  resourceOperations?: number;
  fullOutputPath?: string;
}

export function createRenameTool(
  manager: LspManager,
  treeSitter?: TreeSitterManager | null,
): ToolDefinition<typeof RenameParams, RenameDetails> {
  return {
    name: "lsp_rename",
    label: "LSP Rename",
    description: "Preview a rename refactoring for a symbol at a position. Returns the list of changes that would be made across all files. Does NOT apply the changes — use edit/write tools to apply them. Line and character are 1-indexed.",
    promptSnippet: "Preview rename refactoring for a symbol (returns planned edits, does not apply them)",
    parameters: RenameParams,

    async execute(_toolCallId, params) {
      const filePath = params.path.replace(/^@/, "");
      let line = params.line;
      let character = params.character;
      let resolvedFrom: string | undefined;

      // Resolve position from query if line/character not provided
      if ((line === undefined || character === undefined) && params.query) {
        const resolved = await resolveSymbolPosition(filePath, params.query, manager, treeSitter);
        if (resolved) {
          line = resolved.line;
          character = resolved.character;
          resolvedFrom = `Resolved "${params.query}" → ${resolved.symbolName} at ${line}:${character} [${resolved.source}]`;
        } else {
          const names = await getSymbolNames(filePath, manager, treeSitter);
          const hint = names.length > 0 ? `\nAvailable symbols: ${names.slice(0, 20).join(", ")}` : "";
          return { content: [{ type: "text", text: `Could not find symbol "${params.query}" in ${filePath}${hint}` }], details: { fileCount: 0, editCount: 0 } };
        }
      }

      if (line === undefined || character === undefined) {
        return { content: [{ type: "text", text: "Either line/character or query is required." }], details: { fileCount: 0, editCount: 0 } };
      }

      const client = await manager.getClientForFile(filePath).catch(() => null);
      if (!client) {
        return { content: [{ type: "text", text: manager.getUnavailableReason(filePath) }], details: { fileCount: 0, editCount: 0 } };
      }

      const uri = manager.getFileUri(filePath);
      const position = { line: line - 1, character: character - 1 };

      try {
        const result = await client.sendRequest<WorkspaceEdit | null>("textDocument/rename", {
          textDocument: { uri }, position, newName: params.newName,
        });

        if (!result) {
          const text = resolvedFrom ? `${resolvedFrom}\n\nRename not possible at this position.` : "Rename not possible at this position.";
          return { content: [{ type: "text", text }], details: { fileCount: 0, editCount: 0 } };
        }

        const rootDir = manager.resolvePath(".");
        const { summary, fileCount, editCount, resourceOperations } = formatWorkspaceEdit(result, rootDir);

        if (editCount === 0 && resourceOperations === 0) {
          const text = resolvedFrom ? `${resolvedFrom}\n\nNo edits needed for this rename.` : "No edits needed for this rename.";
          return { content: [{ type: "text", text }], details: { fileCount: 0, editCount: 0 } };
        }

        const truncation = truncateHead(summary, { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES });
        let text = "";
        if (resolvedFrom) text += `${resolvedFrom}\n\n`;
        text += `Rename "${params.newName}": ${editCount} edit(s) across ${fileCount} file(s), ${resourceOperations} resource operation(s)\n\n`;
        text += "NOTE: Preview only. Ranges are 1-based UTF-16, with an exclusive end. Recompute if documents change; this is not a version-checked apply operation.\n\n";
        text += truncation.content;
        let fullOutputPath: string | undefined;
        if (truncation.truncated) {
          const dir = await mkdtemp(join(tmpdir(), "pi-lsp-rename-"));
          fullOutputPath = join(dir, "workspace-edit.json");
          await writeFile(fullOutputPath, JSON.stringify(result, null, 2), "utf8");
          text += `\n\n[Truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines. Full raw WorkspaceEdit (0-based LSP ranges): ${fullOutputPath}]`;
        }

        return { content: [{ type: "text", text }], details: { fileCount, editCount, resourceOperations, workspaceEdit: result, fullOutputPath } };
      } catch (err: any) {
        return { isError: true, content: [{ type: "text", text: `LSP rename request failed: ${err.message}` }], details: { fileCount: 0, editCount: 0 } };
      }
    },

    renderCall(args, theme) {
      let text = theme.fg("toolTitle", theme.bold("lsp_rename "));
      if (args.query && !args.line) {
        text += theme.fg("accent", `${args.path}`);
        text += theme.fg("muted", ` query="${args.query}" → ${args.newName}`);
      } else {
        text += theme.fg("accent", `${args.path}:${args.line}:${args.character}`);
        text += theme.fg("muted", ` → ${args.newName}`);
      }
      return new Text(text, 0, 0);
    },

    renderResult(result, { isPartial }, theme) {
      if (isPartial) return new Text(theme.fg("warning", "Computing..."), 0, 0);
      const details = result.details;
      if (!details || (details.editCount === 0 && !details.resourceOperations)) return new Text(theme.fg("dim", "No edits"), 0, 0);
      return new Text(theme.fg("success", `${details.editCount} edit(s) in ${details.fileCount} file(s), ${details.resourceOperations ?? 0} resource operation(s) (preview only)`), 0, 0);
    },
  };
}
