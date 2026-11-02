/** Cached push diagnostics, or an explicit fresh document/workspace pull. */
import { Type } from "typebox";
import { DiagnosticSeverity, type Diagnostic } from "vscode-languageserver-protocol";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { truncateHead, DEFAULT_MAX_LINES, DEFAULT_MAX_BYTES } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import type { LspManager } from "../lsp-manager.js";
import type { TreeSitterManager } from "../tree-sitter/parser-manager.js";
import { resolveProvider } from "../resolve-provider.js";
import { getSyntaxErrors } from "../tree-sitter/symbol-extractor.js";
import { readFile } from "node:fs/promises";
import { relative } from "node:path";
import { fileURLToPath } from "node:url";

const DiagnosticsParams = Type.Object({
  path: Type.String({ description: "File path, or '*' for all running language servers. Workspace mode does not start servers." }),
  mode: Type.Optional(Type.Union([Type.Literal("cached"), Type.Literal("pull")], { description: "cached (default): fast asynchronous push cache, not a complete fresh check. pull: request fresh diagnostics; fails explicitly when unsupported." })),
  severity: Type.Optional(Type.Union([Type.Literal("error"), Type.Literal("warning"), Type.Literal("information"), Type.Literal("hint")], { description: "Maximum severity number to include: warning includes errors and warnings. Default includes all diagnostics." })),
});
interface DiagnosticsDetails {
  count: number;
  errors?: number;
  warnings?: number;
  files?: number;
  mode?: "cached" | "pull";
  complete?: boolean;
  totalCount?: number;
  failed?: boolean;
}
const severityNames = ["unknown", "error", "warning", "info", "hint"];
function formatDiagnostic(diag: Diagnostic, file: string): string {
  return `${file}:${diag.range.start.line + 1}:${diag.range.start.character + 1} ${severityNames[diag.severity ?? 0] ?? "unknown"}: ${diag.message}${diag.code !== undefined ? ` (${diag.code})` : ""}${diag.source ? ` [${diag.source}]` : ""}`;
}

export function createDiagnosticsTool(manager: LspManager, treeSitter?: TreeSitterManager | null): ToolDefinition<typeof DiagnosticsParams, DiagnosticsDetails> {
  return {
    name: "lsp_diagnostics",
    label: "LSP Diagnostics",
    description: "Read cached push diagnostics (default), or request fresh diagnostics with mode='pull'. path='*' queries running servers only. Cached results are not a full solution check. Pull fails explicitly if a server does not support it. Optional severity filters output without hiding total counts.",
    promptSnippet: "Check cached or fresh compiler diagnostics; use mode='pull' for an explicit current check",
    promptGuidelines: [
      "Cached diagnostics are asynchronous and may be incomplete or stale. Do not interpret an empty cache as a successful solution build.",
      "Use mode='pull' for fresh file diagnostics or path='*' for fresh workspace diagnostics from running servers; severity='error' keeps large reports compact.",
    ],
    parameters: DiagnosticsParams,
    async execute(_id, params) {
      const filePath = params.path.replace(/^@/, "");
      const mode = params.mode ?? "cached";
      const workspace = filePath === "*" || filePath === "";
      try {
        const clients = workspace
          ? manager.getStatus().filter(s => s.running).map(s => manager.getRunningClient(s.languageId)).filter(c => c !== null)
          : [await manager.getClientForFile(filePath)].filter(c => c !== null);
        if (!clients.length) {
          // Keep the existing syntax-only fallback, but never substitute it for a requested pull.
          if (!workspace && mode === "cached" && treeSitter && resolveProvider(filePath, manager, treeSitter).type === "tree-sitter") {
            const absPath = manager.resolvePath(filePath);
            const tree = await treeSitter.parse(absPath, await readFile(absPath, "utf8"));
            if (tree) {
              const errors = getSyntaxErrors(tree);
              const file = relative(manager.resolvePath("."), absPath);
              const output = errors.map(e => `${file}:${e.line + 1}:${e.character + 1} error: ${e.message}`).join("\n");
              const truncated = truncateHead(output, { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES });
              return { content: [{ type: "text", text: `${errors.length} syntax error(s) [tree-sitter — syntax only, no type checking]\n${truncated.content}${truncated.truncated ? "\n[Output truncated]" : ""}` }], details: { count: errors.length, errors: errors.length, mode, complete: false } };
            }
          }
          return { isError: mode === "pull", content: [{ type: "text", text: workspace ? "No LSP servers are running. Use a source file path to start one; retry once it is ready." : manager.getUnavailableReason(filePath) }], details: { count: 0, mode, complete: false, failed: mode === "pull" } };
        }
        const all: { file: string; diagnostic: Diagnostic }[] = [];
        const root = manager.resolvePath(".");
        for (const client of clients) {
          const uri = workspace ? undefined : manager.getFileUri(filePath);
          const reports = mode === "pull" ? await client.pullDiagnostics(uri)
            : uri ? new Map([[uri, client.getDiagnostics(uri)]]) : client.getAllDiagnostics();
          for (const [documentUri, diagnostics] of reports) {
            let file: string;
            try { file = relative(root, fileURLToPath(documentUri)); } catch { file = documentUri; }
            for (const diagnostic of diagnostics) all.push({ file, diagnostic });
          }
        }
        const maxSeverity = params.severity ? { error: 1, warning: 2, information: 3, hint: 4 }[params.severity] : Infinity;
        const selected = all.filter(d => (d.diagnostic.severity ?? 99) <= maxSeverity);
        selected.sort((a, b) => (a.diagnostic.severity ?? 99) - (b.diagnostic.severity ?? 99) || a.file.localeCompare(b.file));
        const errors = selected.filter(d => d.diagnostic.severity === DiagnosticSeverity.Error).length;
        const warnings = selected.filter(d => d.diagnostic.severity === DiagnosticSeverity.Warning).length;
        const files = new Set(selected.map(d => d.file)).size;
        const output = selected.map(d => formatDiagnostic(d.diagnostic, d.file)).join("\n");
        const truncated = truncateHead(output, { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES });
        const scope = mode === "pull" ? "Fresh pull" : "Cached push (may be incomplete or stale)";
        let text = `${scope}: ${selected.length} diagnostic(s) in ${files} file(s), ${errors} error(s), ${warnings} warning(s).`;
        if (params.severity) text += ` ${all.length} total before severity filter.`;
        if (output) text += `\n\n${truncated.content}`;
        if (truncated.truncated) text += `\n\n[Output truncated: showing ${truncated.outputLines} of ${truncated.totalLines} lines]`;
        return { content: [{ type: "text", text }], details: { count: selected.length, errors, warnings, files, mode, complete: mode === "pull", totalCount: all.length } };
      } catch (error: any) {
        return { isError: true, content: [{ type: "text", text: `Diagnostics ${mode} failed: ${error.message}. No complete diagnostic result is available.` }], details: { count: 0, mode, complete: false, failed: true } };
      }
    },
    renderCall(args, theme) {
      return new Text(theme.fg("toolTitle", theme.bold("lsp_diagnostics ")) + theme.fg("accent", `${args.path} (${args.mode ?? "cached"})`), 0, 0);
    },
    renderResult(result, { isPartial, expanded }, theme) {
      if (isPartial) return new Text(theme.fg("warning", "Checking..."), 0, 0);
      const content = result.content[0];
      const lines = content?.type === "text" ? content.text.split("\n") : ["No result"];
      const shown = expanded ? lines.slice(0, 30).join("\n") : lines[0];
      return new Text(theme.fg(result.details?.failed ? "error" : "dim", shown + (expanded && lines.length > 30 ? "\n... (more diagnostics in tool output)" : "")), 0, 0);
    },
  };
}
