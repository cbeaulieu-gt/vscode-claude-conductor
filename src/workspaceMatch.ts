/**
 * Pure helper for comparing VS Code workspace folder paths.
 *
 * Uses case-insensitive exact matching to handle Windows drives where the same
 * path may be reported with different casing by different VS Code APIs.
 */

/**
 * Returns true when `currentFolder` and `targetFolder` refer to the same
 * directory via case-insensitive exact comparison.
 *
 * @param currentFolder - The fsPath of the first workspace folder, or undefined
 *                        when no workspace is open.
 * @param targetFolder  - The folder path to compare against.
 */
export function isSameWorkspaceFolder(
  currentFolder: string | undefined,
  targetFolder: string
): boolean {
  if (!currentFolder) {
    return false;
  }
  return currentFolder.toLowerCase() === targetFolder.toLowerCase();
}
