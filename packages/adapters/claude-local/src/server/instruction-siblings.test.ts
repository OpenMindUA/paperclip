import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BUNDLE_ENTRY_FILE_NAME,
  INSTRUCTION_SIBLING_LIMITS,
  readInstructionSiblingFiles,
} from "./instruction-siblings.js";
import { prepareClaudePromptBundle } from "./prompt-cache.js";

describe("readInstructionSiblingFiles", () => {
  const cleanupDirs: string[] = [];
  const onLog = vi.fn(async () => {});

  async function makeInstructionsDir() {
    const dir = await mkdtemp(path.join(os.tmpdir(), "paperclip-claude-siblings-"));
    cleanupDirs.push(dir);
    await writeFile(path.join(dir, "AGENTS.md"), "entry\n", "utf8");
    return dir;
  }

  afterEach(async () => {
    vi.clearAllMocks();
    while (cleanupDirs.length > 0) {
      const dir = cleanupDirs.pop();
      if (dir) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it("returns the sorted Markdown siblings and leaves out the entry file", async () => {
    const dir = await makeInstructionsDir();
    await writeFile(path.join(dir, "TOOLS.md"), "tools\n", "utf8");
    await writeFile(path.join(dir, "HEARTBEAT.md"), "heartbeat\n", "utf8");
    await writeFile(path.join(dir, "SOUL.MD"), "soul\n", "utf8");
    await writeFile(path.join(dir, "notes.txt"), "not markdown\n", "utf8");
    await writeFile(path.join(dir, ".hidden.md"), "hidden\n", "utf8");

    const files = await readInstructionSiblingFiles({
      entryFilePath: path.join(dir, "AGENTS.md"),
      maxDepth: 0,
      onLog,
    });

    expect(files).toEqual([
      { relativePath: "HEARTBEAT.md", contents: "heartbeat\n" },
      { relativePath: "SOUL.MD", contents: "soul\n" },
      { relativePath: "TOOLS.md", contents: "tools\n" },
    ]);
  });

  it("walks subdirectories only up to maxDepth and skips hidden and dependency directories", async () => {
    const dir = await makeInstructionsDir();
    await mkdir(path.join(dir, "memory", "deep"), { recursive: true });
    await mkdir(path.join(dir, ".git"), { recursive: true });
    await mkdir(path.join(dir, "node_modules"), { recursive: true });
    await writeFile(path.join(dir, "memory", "notes.md"), "notes\n", "utf8");
    await writeFile(path.join(dir, "memory", "deep", "old.md"), "old\n", "utf8");
    await writeFile(path.join(dir, ".git", "x.md"), "git\n", "utf8");
    await writeFile(path.join(dir, "node_modules", "y.md"), "dep\n", "utf8");

    const entryFilePath = path.join(dir, "AGENTS.md");
    const topLevelOnly = await readInstructionSiblingFiles({ entryFilePath, maxDepth: 0, onLog });
    const oneLevel = await readInstructionSiblingFiles({ entryFilePath, maxDepth: 1, onLog });
    const twoLevels = await readInstructionSiblingFiles({ entryFilePath, maxDepth: 2, onLog });

    expect(topLevelOnly).toEqual([]);
    expect(oneLevel.map((file) => file.relativePath)).toEqual(["memory/notes.md"]);
    expect(twoLevels.map((file) => file.relativePath)).toEqual(["memory/deep/old.md", "memory/notes.md"]);
  });

  it("does not follow symlinks out of the instructions directory", async () => {
    const dir = await makeInstructionsDir();
    const outside = await mkdtemp(path.join(os.tmpdir(), "paperclip-claude-outside-"));
    cleanupDirs.push(outside);
    await writeFile(path.join(outside, "secret.md"), "secret\n", "utf8");
    await symlink(path.join(outside, "secret.md"), path.join(dir, "linked.md"));
    await symlink(outside, path.join(dir, "linked-dir"));

    const files = await readInstructionSiblingFiles({
      entryFilePath: path.join(dir, "AGENTS.md"),
      maxDepth: 2,
      onLog,
    });

    expect(files).toEqual([]);
  });

  it("skips an oversized file and the reserved bundle entry name, and reports both", async () => {
    const dir = await makeInstructionsDir();
    await writeFile(path.join(dir, "TOOLS.md"), "tools\n", "utf8");
    await writeFile(path.join(dir, "big.md"), "x".repeat(INSTRUCTION_SIBLING_LIMITS.maxFileBytes + 1), "utf8");
    await writeFile(path.join(dir, BUNDLE_ENTRY_FILE_NAME), "clash\n", "utf8");

    const files = await readInstructionSiblingFiles({
      entryFilePath: path.join(dir, "AGENTS.md"),
      maxDepth: 0,
      onLog,
    });

    expect(files.map((file) => file.relativePath)).toEqual(["TOOLS.md"]);
    const messages = onLog.mock.calls.map((call) => String((call as unknown[])[1]));
    expect(messages.some((message) => message.includes('"big.md"'))).toBe(true);
    expect(messages.some((message) => message.includes(`"${BUNDLE_ENTRY_FILE_NAME}"`))).toBe(true);
  });

  it("stops at the file-count limit and reports the truncation", async () => {
    const dir = await makeInstructionsDir();
    for (let index = 0; index < INSTRUCTION_SIBLING_LIMITS.maxFiles + 3; index += 1) {
      await writeFile(path.join(dir, `note-${String(index).padStart(3, "0")}.md`), "n\n", "utf8");
    }

    const files = await readInstructionSiblingFiles({
      entryFilePath: path.join(dir, "AGENTS.md"),
      maxDepth: 0,
      onLog,
    });

    expect(files).toHaveLength(INSTRUCTION_SIBLING_LIMITS.maxFiles);
    const messages = onLog.mock.calls.map((call) => String((call as unknown[])[1]));
    expect(messages.some((message) => message.includes("truncated"))).toBe(true);
  });
});

describe("prepareClaudePromptBundle with sibling instruction files", () => {
  const cleanupDirs: string[] = [];

  afterEach(async () => {
    vi.unstubAllEnvs();
    while (cleanupDirs.length > 0) {
      const dir = cleanupDirs.pop();
      if (dir) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  async function stubPaperclipHome() {
    const home = await mkdtemp(path.join(os.tmpdir(), "paperclip-claude-bundle-home-"));
    cleanupDirs.push(home);
    vi.stubEnv("PAPERCLIP_HOME", home);
    vi.stubEnv("PAPERCLIP_INSTANCE_ID", "default");
  }

  it("writes the siblings next to the entry file and keeps the key of a bundle without siblings", async () => {
    await stubPaperclipHome();
    const base = { companyId: "company-1", skills: [], instructionsContents: "entry", onLog: async () => {} };

    const withoutSiblings = await prepareClaudePromptBundle(base);
    const emptySiblings = await prepareClaudePromptBundle({ ...base, siblingFiles: [] });
    const withSiblings = await prepareClaudePromptBundle({
      ...base,
      siblingFiles: [
        { relativePath: "TOOLS.md", contents: "tools\n" },
        { relativePath: "memory/notes.md", contents: "notes\n" },
      ],
    });
    const changedSibling = await prepareClaudePromptBundle({
      ...base,
      siblingFiles: [
        { relativePath: "TOOLS.md", contents: "other tools\n" },
        { relativePath: "memory/notes.md", contents: "notes\n" },
      ],
    });

    expect(emptySiblings.bundleKey).toBe(withoutSiblings.bundleKey);
    expect(withSiblings.bundleKey).not.toBe(withoutSiblings.bundleKey);
    expect(changedSibling.bundleKey).not.toBe(withSiblings.bundleKey);
    expect(await readFile(path.join(withSiblings.rootDir, BUNDLE_ENTRY_FILE_NAME), "utf8")).toBe("entry");
    expect(await readFile(path.join(withSiblings.rootDir, "TOOLS.md"), "utf8")).toBe("tools\n");
    expect(await readFile(path.join(withSiblings.rootDir, "memory", "notes.md"), "utf8")).toBe("notes\n");
    await expect(readFile(path.join(withoutSiblings.rootDir, "TOOLS.md"), "utf8")).rejects.toThrow();
  });

  it("refuses a sibling path that would leave the bundle directory", async () => {
    await stubPaperclipHome();

    const bundle = await prepareClaudePromptBundle({
      companyId: "company-1",
      skills: [],
      instructionsContents: "entry",
      siblingFiles: [{ relativePath: "../escaped.md", contents: "escaped\n" }],
      onLog: async () => {},
    });

    await expect(readFile(path.join(path.dirname(bundle.rootDir), "escaped.md"), "utf8")).rejects.toThrow();
  });
});
