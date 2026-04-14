import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import { SESSION_NAME_PREFIX } from "./sessionManager";

interface ClaudeTerminalLink extends vscode.TerminalLink {
  filePath: string;
}

/**
 * Provides clickable file path links in Claude session terminals.
 * Matches both absolute paths (C:\foo\bar.ts) and relative paths (src/app.ts).
 */
export class ClaudeTerminalLinkProvider implements vscode.TerminalLinkProvider<ClaudeTerminalLink> {
  /**
   * Regex patterns for file paths.
   * - Windows absolute: C:\Users\chris\file.ts (with optional :line:col)
   * - Unix absolute: /home/user/file.ts (with optional :line:col)
   * - Relative: src/components/App.tsx, ./foo/bar.py (with optional :line:col)
   */
  private readonly _patterns = [
    // Windows absolute path: C:\path\to\file.ext[:line[:col]]
    /[A-Za-z]:\\(?:[\w.\-]+\\)*[\w.\-]+\.\w+(?::\d+(?::\d+)?)?/g,
    // Unix absolute path: /path/to/file.ext[:line[:col]]
    /\/(?:[\w.\-]+\/)*[\w.\-]+\.\w+(?::\d+(?::\d+)?)?/g,
    // Relative path: src/file.ext or ./file.ext[:line[:col]]
    /\.{0,2}\/(?:[\w.\-]+\/)*[\w.\-]+\.\w+(?::\d+(?::\d+)?)?/g,
  ];

  provideTerminalLinks(
    context: vscode.TerminalLinkContext
  ): ClaudeTerminalLink[] {
    // Only provide links for Claude session terminals
    if (!context.terminal.name.startsWith(SESSION_NAME_PREFIX)) {
      return [];
    }

    const links: ClaudeTerminalLink[] = [];
    const line = context.line;

    for (const pattern of this._patterns) {
      // Reset lastIndex since we're reusing regex objects
      pattern.lastIndex = 0;
      let match: RegExpExecArray | null;

      while ((match = pattern.exec(line)) !== null) {
        const rawPath = match[0];
        // Strip trailing :line:col for the file path
        const filePath = rawPath.replace(/:\d+(?::\d+)?$/, "");

        links.push({
          startIndex: match.index,
          length: rawPath.length,
          tooltip: `Open ${filePath}`,
          filePath,
        });
      }
    }

    return links;
  }

  async handleTerminalLink(link: ClaudeTerminalLink): Promise<void> {
    let targetPath = link.filePath;

    // If relative, try to resolve against the workspace folder
    if (!path.isAbsolute(targetPath)) {
      const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      if (workspaceFolder) {
        const resolved = path.resolve(workspaceFolder, targetPath);
        if (fs.existsSync(resolved)) {
          targetPath = resolved;
        }
      }
    }

    try {
      const uri = vscode.Uri.file(targetPath);
      const doc = await vscode.workspace.openTextDocument(uri);
      await vscode.window.showTextDocument(doc);
    } catch {
      vscode.window.showWarningMessage(`Could not open file: ${link.filePath}`);
    }
  }
}
