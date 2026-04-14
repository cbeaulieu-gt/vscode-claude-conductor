import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import { getExtraFolders } from "./config";

export interface FolderEntry {
  /** Resolved absolute path on disk */
  folderPath: string;
  /** Display name (basename) */
  name: string;
  /** Parent directory for display */
  parentDir: string;
  /** Where this entry came from */
  source: "recent" | "configured";
}

/**
 * Shape returned by the internal _workbench.getRecentlyOpened command.
 * This is undocumented but stable — used by many extensions.
 */
interface RecentlyOpened {
  workspaces: Array<{
    folderUri?: vscode.Uri;
    configPath?: vscode.Uri;
  }>;
}

/**
 * Fetch VS Code's recently opened folders via internal command.
 * Returns resolved folder paths in recency order.
 */
async function getRecentFolders(): Promise<string[]> {
  try {
    const recent = await vscode.commands.executeCommand<RecentlyOpened>(
      "_workbench.getRecentlyOpened"
    );
    if (!recent?.workspaces) {
      return [];
    }
    return recent.workspaces
      .filter((w): w is { folderUri: vscode.Uri } => w.folderUri !== undefined)
      .map((w) => w.folderUri.fsPath);
  } catch {
    return [];
  }
}

/**
 * Get all folders from both sources, deduplicated.
 * Recent folders first (in recency order), then extra folders.
 */
export async function getAllFolders(): Promise<FolderEntry[]> {
  const recentPaths = await getRecentFolders();
  const extraPaths = getExtraFolders();

  const seen = new Set<string>();
  const entries: FolderEntry[] = [];

  const addEntry = (folderPath: string, source: "recent" | "configured"): void => {
    const normalized = path.normalize(folderPath);
    const key = normalized.toLowerCase();
    if (seen.has(key)) {
      return;
    }
    seen.add(key);

    // Only include folders that exist on disk
    try {
      if (!fs.statSync(normalized).isDirectory()) {
        return;
      }
    } catch {
      return;
    }

    entries.push({
      folderPath: normalized,
      name: path.basename(normalized),
      parentDir: path.dirname(normalized),
      source,
    });
  };

  for (const p of recentPaths) {
    addEntry(p, "recent");
  }
  for (const p of extraPaths) {
    addEntry(p, "configured");
  }

  return entries;
}
