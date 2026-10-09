import type { Dirent } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";

export interface InstructionSiblingFile {
  /** POSIX-style path relative to the directory that holds the entry instructions file. */
  relativePath: string;
  contents: string;
}

export const INSTRUCTION_SIBLING_LIMITS = {
  maxFiles: 64,
  maxFileBytes: 256 * 1024,
  maxTotalBytes: 1024 * 1024,
} as const;

/** Name the prompt bundle gives to the entry instructions file. Siblings must not replace it. */
export const BUNDLE_ENTRY_FILE_NAME = "agent-instructions.md";

const SKIPPED_DIRECTORY_NAMES = new Set(["node_modules", "__pycache__", "venv"]);

/**
 * Collect the Markdown files that sit next to an agent's entry instructions file,
 * so they can travel to a remote execution target together with the entry file.
 * Only regular `*.md` files are read. Symlinks, hidden entries and oversized
 * files are skipped. The result is sorted, so the prompt bundle key stays stable.
 */
export async function readInstructionSiblingFiles(input: {
  entryFilePath: string;
  maxDepth: number;
  onLog: AdapterExecutionContext["onLog"];
}): Promise<InstructionSiblingFile[]> {
  const { entryFilePath, maxDepth, onLog } = input;
  const rootDir = path.dirname(entryFilePath);
  const entryRelativePath = path.basename(entryFilePath);
  const { maxFiles, maxFileBytes, maxTotalBytes } = INSTRUCTION_SIBLING_LIMITS;
  const files: InstructionSiblingFile[] = [];
  let totalBytes = 0;
  let truncated = false;

  const warn = (message: string) => onLog("stderr", `[paperclip] Warning: ${message}\n`);

  const walk = async (relativeDir: string, depth: number): Promise<void> => {
    const absoluteDir = relativeDir ? path.join(rootDir, relativeDir) : rootDir;
    let entries: Dirent[];
    try {
      entries = await fs.readdir(absoluteDir, { withFileTypes: true });
    } catch (err) {
      await warn(
        `could not list instruction files in "${absoluteDir}": ${err instanceof Error ? err.message : String(err)}`,
      );
      return;
    }
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (truncated) return;
      if (entry.name.startsWith(".")) continue;
      const relativePath = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (depth < maxDepth && !SKIPPED_DIRECTORY_NAMES.has(entry.name)) {
          await walk(relativePath, depth + 1);
        }
        continue;
      }
      if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".md")) continue;
      if (relativePath === entryRelativePath) continue;
      if (relativePath === BUNDLE_ENTRY_FILE_NAME) {
        await warn(`instruction file "${relativePath}" was not sent to the remote target: its name is reserved.`);
        continue;
      }
      const absolutePath = path.join(rootDir, relativePath);
      let contents: string;
      try {
        const stat = await fs.stat(absolutePath);
        if (stat.size > maxFileBytes) {
          await warn(`instruction file "${relativePath}" was not sent to the remote target: it is larger than ${maxFileBytes} bytes.`);
          continue;
        }
        contents = await fs.readFile(absolutePath, "utf-8");
      } catch (err) {
        await warn(
          `instruction file "${relativePath}" was not sent to the remote target: ${err instanceof Error ? err.message : String(err)}`,
        );
        continue;
      }
      const size = Buffer.byteLength(contents, "utf-8");
      if (files.length >= maxFiles || totalBytes + size > maxTotalBytes) {
        truncated = true;
        await warn(
          `instruction files from "${rootDir}" were truncated at ${files.length} files / ${totalBytes} bytes for the remote target.`,
        );
        return;
      }
      totalBytes += size;
      files.push({ relativePath, contents });
    }
  };

  await walk("", 0);
  files.sort((left, right) => (left.relativePath < right.relativePath ? -1 : left.relativePath > right.relativePath ? 1 : 0));
  return files;
}
