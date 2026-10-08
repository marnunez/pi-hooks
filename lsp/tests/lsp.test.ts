/**
 * Tests for LSP hook - configuration and utility functions
 *
 * Run with: npm test
 *
 * These tests cover:
 * - Project root detection for various languages
 * - Language ID mappings
 * - URI construction
 * - Server configuration correctness
 */

import { mkdtemp, rm, writeFile, mkdir, symlink, chmod } from "fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "os";
import { join } from "path";
import { pathToFileURL } from "url";
import { LSP_SERVERS, LANGUAGE_IDS, LSPManager } from "../lsp-core.js";
import { diagnosticsWaitMsForFile, warmupExtensionForDirectory } from "../lsp.js";

// ============================================================================
// Test utilities
// ============================================================================

interface TestResult {
  name: string;
  passed: boolean;
  error?: string;
}

const tests: Array<{ name: string; fn: () => Promise<void> }> = [];

function test(name: string, fn: () => Promise<void>) {
  tests.push({ name, fn });
}

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(message);
}

function assertEquals<T>(actual: T, expected: T, message: string) {
  assert(
    actual === expected,
    `${message}\nExpected: ${JSON.stringify(expected)}\nActual: ${JSON.stringify(actual)}`
  );
}

function assertIncludes(arr: string[], item: string, message: string) {
  assert(arr.includes(item), `${message}\nArray: [${arr.join(", ")}]\nMissing: ${item}`);
}

/** Create a temp directory with optional file structure */
async function withTempDir(
  structure: Record<string, string | null>, // null = directory, string = file content
  fn: (dir: string) => Promise<void>
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "lsp-test-"));
  try {
    for (const [path, content] of Object.entries(structure)) {
      const fullPath = join(dir, path);
      if (content === null) {
        await mkdir(fullPath, { recursive: true });
      } else {
        await mkdir(join(dir, path.split("/").slice(0, -1).join("/")), { recursive: true }).catch(() => {});
        await writeFile(fullPath, content);
      }
    }
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

// ============================================================================
// Language ID tests
// ============================================================================

test("LANGUAGE_IDS: TypeScript extensions", async () => {
  assertEquals(LANGUAGE_IDS[".ts"], "typescript", ".ts should map to typescript");
  assertEquals(LANGUAGE_IDS[".tsx"], "typescriptreact", ".tsx should map to typescriptreact");
  assertEquals(LANGUAGE_IDS[".mts"], "typescript", ".mts should map to typescript");
  assertEquals(LANGUAGE_IDS[".cts"], "typescript", ".cts should map to typescript");
});

test("LANGUAGE_IDS: JavaScript extensions", async () => {
  assertEquals(LANGUAGE_IDS[".js"], "javascript", ".js should map to javascript");
  assertEquals(LANGUAGE_IDS[".jsx"], "javascriptreact", ".jsx should map to javascriptreact");
  assertEquals(LANGUAGE_IDS[".mjs"], "javascript", ".mjs should map to javascript");
  assertEquals(LANGUAGE_IDS[".cjs"], "javascript", ".cjs should map to javascript");
});

test("LANGUAGE_IDS: Dart extension", async () => {
  assertEquals(LANGUAGE_IDS[".dart"], "dart", ".dart should map to dart");
});

test("LANGUAGE_IDS: Go extension", async () => {
  assertEquals(LANGUAGE_IDS[".go"], "go", ".go should map to go");
});

test("LANGUAGE_IDS: Rust extension", async () => {
  assertEquals(LANGUAGE_IDS[".rs"], "rust", ".rs should map to rust");
});

test("LANGUAGE_IDS: Kotlin extensions", async () => {
  assertEquals(LANGUAGE_IDS[".kt"], "kotlin", ".kt should map to kotlin");
  assertEquals(LANGUAGE_IDS[".kts"], "kotlin", ".kts should map to kotlin");
});

test("LANGUAGE_IDS: Swift extension", async () => {
  assertEquals(LANGUAGE_IDS[".swift"], "swift", ".swift should map to swift");
});

test("LANGUAGE_IDS: Python extensions", async () => {
  assertEquals(LANGUAGE_IDS[".py"], "python", ".py should map to python");
  assertEquals(LANGUAGE_IDS[".pyi"], "python", ".pyi should map to python");
});

test("LANGUAGE_IDS: Vue/Svelte/Astro extensions", async () => {
  assertEquals(LANGUAGE_IDS[".vue"], "vue", ".vue should map to vue");
  assertEquals(LANGUAGE_IDS[".svelte"], "svelte", ".svelte should map to svelte");
  assertEquals(LANGUAGE_IDS[".astro"], "astro", ".astro should map to astro");
});

// ============================================================================
// Server configuration tests
// ============================================================================

test("LSP_SERVERS: has TypeScript server", async () => {
  const server = LSP_SERVERS.find(s => s.id === "typescript");
  assert(server !== undefined, "Should have typescript server");
  assertIncludes(server!.extensions, ".ts", "Should handle .ts");
  assertIncludes(server!.extensions, ".tsx", "Should handle .tsx");
  assertIncludes(server!.extensions, ".js", "Should handle .js");
  assertIncludes(server!.extensions, ".jsx", "Should handle .jsx");
});

test("LSP_SERVERS: has Dart server", async () => {
  const server = LSP_SERVERS.find(s => s.id === "dart");
  assert(server !== undefined, "Should have dart server");
  assertIncludes(server!.extensions, ".dart", "Should handle .dart");
});

test("LSP_SERVERS: has Rust Analyzer server", async () => {
  const server = LSP_SERVERS.find(s => s.id === "rust-analyzer");
  assert(server !== undefined, "Should have rust-analyzer server");
  assertIncludes(server!.extensions, ".rs", "Should handle .rs");
});

test("LSP_SERVERS: has Gopls server", async () => {
  const server = LSP_SERVERS.find(s => s.id === "gopls");
  assert(server !== undefined, "Should have gopls server");
  assertIncludes(server!.extensions, ".go", "Should handle .go");
});

test("LSP_SERVERS: has Kotlin server", async () => {
  const server = LSP_SERVERS.find(s => s.id === "kotlin");
  assert(server !== undefined, "Should have kotlin server");
  assertIncludes(server!.extensions, ".kt", "Should handle .kt");
  assertIncludes(server!.extensions, ".kts", "Should handle .kts");
});

test("LSP_SERVERS: has Swift server", async () => {
  const server = LSP_SERVERS.find(s => s.id === "swift");
  assert(server !== undefined, "Should have swift server");
  assertIncludes(server!.extensions, ".swift", "Should handle .swift");
});

test("LSP_SERVERS: has Pyright server", async () => {
  const server = LSP_SERVERS.find(s => s.id === "pyright");
  assert(server !== undefined, "Should have pyright server");
  assertIncludes(server!.extensions, ".py", "Should handle .py");
  assertIncludes(server!.extensions, ".pyi", "Should handle .pyi");
});

// ============================================================================
// TypeScript root detection tests
// ============================================================================

test("typescript: finds root with package.json", async () => {
  await withTempDir({
    "package.json": "{}",
    "src/index.ts": "export const x = 1;",
  }, async (dir) => {
    const server = LSP_SERVERS.find(s => s.id === "typescript")!;
    const root = server.findRoot(join(dir, "src/index.ts"), dir);
    assertEquals(root, dir, "Should find root at package.json location");
  });
});

test("typescript: finds root with tsconfig.json", async () => {
  await withTempDir({
    "tsconfig.json": "{}",
    "src/index.ts": "export const x = 1;",
  }, async (dir) => {
    const server = LSP_SERVERS.find(s => s.id === "typescript")!;
    const root = server.findRoot(join(dir, "src/index.ts"), dir);
    assertEquals(root, dir, "Should find root at tsconfig.json location");
  });
});

test("typescript: finds root with jsconfig.json", async () => {
  await withTempDir({
    "jsconfig.json": "{}",
    "src/app.js": "const x = 1;",
  }, async (dir) => {
    const server = LSP_SERVERS.find(s => s.id === "typescript")!;
    const root = server.findRoot(join(dir, "src/app.js"), dir);
    assertEquals(root, dir, "Should find root at jsconfig.json location");
  });
});

test("typescript: returns undefined for deno projects", async () => {
  await withTempDir({
    "deno.json": "{}",
    "main.ts": "console.log('deno');",
  }, async (dir) => {
    const server = LSP_SERVERS.find(s => s.id === "typescript")!;
    const root = server.findRoot(join(dir, "main.ts"), dir);
    assertEquals(root, undefined, "Should return undefined for deno projects");
  });
});

test("typescript: nested package finds nearest root", async () => {
  await withTempDir({
    "package.json": "{}",
    "packages/web/package.json": "{}",
    "packages/web/src/index.ts": "export const x = 1;",
  }, async (dir) => {
    const server = LSP_SERVERS.find(s => s.id === "typescript")!;
    const root = server.findRoot(join(dir, "packages/web/src/index.ts"), dir);
    assertEquals(root, join(dir, "packages/web"), "Should find nearest package.json");
  });
});

// ============================================================================
// Dart root detection tests
// ============================================================================

test("dart: finds root with pubspec.yaml", async () => {
  await withTempDir({
    "pubspec.yaml": "name: my_app",
    "lib/main.dart": "void main() {}",
  }, async (dir) => {
    const server = LSP_SERVERS.find(s => s.id === "dart")!;
    const root = server.findRoot(join(dir, "lib/main.dart"), dir);
    assertEquals(root, dir, "Should find root at pubspec.yaml location");
  });
});

test("dart: finds root with analysis_options.yaml", async () => {
  await withTempDir({
    "analysis_options.yaml": "linter: rules:",
    "lib/main.dart": "void main() {}",
  }, async (dir) => {
    const server = LSP_SERVERS.find(s => s.id === "dart")!;
    const root = server.findRoot(join(dir, "lib/main.dart"), dir);
    assertEquals(root, dir, "Should find root at analysis_options.yaml location");
  });
});

test("dart: nested package finds nearest root", async () => {
  await withTempDir({
    "pubspec.yaml": "name: monorepo",
    "packages/core/pubspec.yaml": "name: core",
    "packages/core/lib/core.dart": "void init() {}",
  }, async (dir) => {
    const server = LSP_SERVERS.find(s => s.id === "dart")!;
    const root = server.findRoot(join(dir, "packages/core/lib/core.dart"), dir);
    assertEquals(root, join(dir, "packages/core"), "Should find nearest pubspec.yaml");
  });
});

// ============================================================================
// Rust root detection tests
// ============================================================================

test("rust: finds root with Cargo.toml", async () => {
  await withTempDir({
    "Cargo.toml": "[package]\nname = \"my_crate\"",
    "src/lib.rs": "pub fn hello() {}",
  }, async (dir) => {
    const server = LSP_SERVERS.find(s => s.id === "rust-analyzer")!;
    const root = server.findRoot(join(dir, "src/lib.rs"), dir);
    assertEquals(root, dir, "Should find root at Cargo.toml location");
  });
});

test("rust: nested workspace member finds nearest Cargo.toml", async () => {
  await withTempDir({
    "Cargo.toml": "[workspace]\nmembers = [\"crates/*\"]",
    "crates/core/Cargo.toml": "[package]\nname = \"core\"",
    "crates/core/src/lib.rs": "pub fn init() {}",
  }, async (dir) => {
    const server = LSP_SERVERS.find(s => s.id === "rust-analyzer")!;
    const root = server.findRoot(join(dir, "crates/core/src/lib.rs"), dir);
    assertEquals(root, join(dir, "crates/core"), "Should find nearest Cargo.toml");
  });
});

// ============================================================================
// Go root detection tests (including gopls bug fix verification)
// ============================================================================

test("gopls: finds root with go.mod", async () => {
  await withTempDir({
    "go.mod": "module example.com/myapp",
    "main.go": "package main",
  }, async (dir) => {
    const server = LSP_SERVERS.find(s => s.id === "gopls")!;
    const root = server.findRoot(join(dir, "main.go"), dir);
    assertEquals(root, dir, "Should find root at go.mod location");
  });
});

test("gopls: finds root with go.work (workspace)", async () => {
  await withTempDir({
    "go.work": "go 1.21\nuse ./app",
    "app/go.mod": "module example.com/app",
    "app/main.go": "package main",
  }, async (dir) => {
    const server = LSP_SERVERS.find(s => s.id === "gopls")!;
    const root = server.findRoot(join(dir, "app/main.go"), dir);
    assertEquals(root, dir, "Should find root at go.work location (workspace root)");
  });
});

test("gopls: prefers go.work over go.mod", async () => {
  await withTempDir({
    "go.work": "go 1.21\nuse ./app",
    "go.mod": "module example.com/root",
    "app/go.mod": "module example.com/app",
    "app/main.go": "package main",
  }, async (dir) => {
    const server = LSP_SERVERS.find(s => s.id === "gopls")!;
    const root = server.findRoot(join(dir, "app/main.go"), dir);
    // go.work is found first, so it should return the go.work location
    assertEquals(root, dir, "Should prefer go.work over go.mod");
  });
});

test("gopls: returns undefined when no go.mod or go.work (bug fix verification)", async () => {
  await withTempDir({
    "main.go": "package main",
  }, async (dir) => {
    const server = LSP_SERVERS.find(s => s.id === "gopls")!;
    const root = server.findRoot(join(dir, "main.go"), dir);
    // This test verifies the bug fix: previously this would return undefined
    // because `undefined !== cwd` was true, skipping the go.mod check
    assertEquals(root, undefined, "Should return undefined when no go.mod or go.work");
  });
});

test("gopls: finds go.mod when go.work not present (bug fix verification)", async () => {
  await withTempDir({
    "go.mod": "module example.com/myapp",
    "cmd/server/main.go": "package main",
  }, async (dir) => {
    const server = LSP_SERVERS.find(s => s.id === "gopls")!;
    const root = server.findRoot(join(dir, "cmd/server/main.go"), dir);
    // This is the key test for the bug fix
    // Previously: findRoot(go.work) returns undefined, then `undefined !== cwd` is true,
    // so it would return undefined without checking go.mod
    // After fix: if go.work not found, falls through to check go.mod
    assertEquals(root, dir, "Should find go.mod when go.work is not present");
  });
});

// ============================================================================
// Kotlin root detection tests
// ============================================================================

test("kotlin: finds root with settings.gradle.kts", async () => {
  await withTempDir({
    "settings.gradle.kts": "rootProject.name = \"myapp\"",
    "app/src/main/kotlin/Main.kt": "fun main() {}",
  }, async (dir) => {
    const server = LSP_SERVERS.find(s => s.id === "kotlin")!;
    const root = server.findRoot(join(dir, "app/src/main/kotlin/Main.kt"), dir);
    assertEquals(root, dir, "Should find root at settings.gradle.kts location");
  });
});

test("kotlin: prefers settings.gradle(.kts) over nested build.gradle", async () => {
  await withTempDir({
    "settings.gradle": "rootProject.name = 'root'",
    "app/build.gradle": "plugins {}",
    "app/src/main/kotlin/Main.kt": "fun main() {}",
  }, async (dir) => {
    const server = LSP_SERVERS.find(s => s.id === "kotlin")!;
    const root = server.findRoot(join(dir, "app/src/main/kotlin/Main.kt"), dir);
    assertEquals(root, dir, "Should prefer settings.gradle at workspace root");
  });
});

test("kotlin: finds root with pom.xml", async () => {
  await withTempDir({
    "pom.xml": "<project></project>",
    "src/main/kotlin/Main.kt": "fun main() {}",
  }, async (dir) => {
    const server = LSP_SERVERS.find(s => s.id === "kotlin")!;
    const root = server.findRoot(join(dir, "src/main/kotlin/Main.kt"), dir);
    assertEquals(root, dir, "Should find root at pom.xml location");
  });
});

// ============================================================================
// C# configuration and project discovery
// ============================================================================

const csharp = LSP_SERVERS.find(s => s.id === "csharp")!;

test("csharp: language ID, server extensions and hook timeout", async () => {
  assertEquals(LANGUAGE_IDS[".cs"], "csharp", ".cs should map to csharp");
  assert(csharp !== undefined, "Should have C# server");
  assertEquals(csharp.extensions.join(","), ".cs", "Should handle only .cs");
  assertEquals(diagnosticsWaitMsForFile("Program.cs"), 30000, "Allow time for MSBuild project loading");
  assertEquals(diagnosticsWaitMsForFile("index.ts"), 3000, "Keep default wait unchanged");
});

test("csharp: spawns csharp-ls on PATH with no --stdio argument", async () => {
  await withTempDir({ "bin/csharp-ls": "#!/bin/sh\nexec sleep 30\n" }, async dir => {
    const binary = join(dir, "bin/csharp-ls");
    await chmod(binary, 0o755);
    // Import in a fresh process because the executable search path is captured at import time.
    const source = `
      import { LSP_SERVERS } from ${JSON.stringify(new URL("../lsp-core.ts", import.meta.url).href)};
      const handle = await LSP_SERVERS.find(s => s.id === "csharp").spawn(${JSON.stringify(dir)});
      if (!handle) throw new Error("Server did not spawn");
      console.log(JSON.stringify({ args: handle.process.spawnargs, cwd: ${JSON.stringify(dir)} }));
      handle.process.kill();
    `;
    const { stdout } = await promisify(execFile)(process.execPath,
      ["--import", import.meta.resolve("tsx"), "--input-type=module", "--eval", source],
      { env: { ...process.env, PATH: `${join(dir, "bin")}${process.platform === "win32" ? ";" : ":"}${process.env.PATH || ""}` }, timeout: 10000 });
    const result = JSON.parse(stdout.trim());
    assertEquals(result.args.length, 1, "csharp-ls uses stdio by default, without flags");
    assertEquals(result.args[0], binary, "Should use csharp-ls from PATH");
  });
});

for (const marker of ["Workspace.sln", "Workspace.slnx", "App.csproj"]) {
  test(`csharp: discovers ${marker} and warms up`, async () => {
    await withTempDir({ [marker]: "", "src/Program.cs": "class Program {}" }, async dir => {
      assertEquals(csharp.findRoot(join(dir, "src/Program.cs"), dir), dir, "Should find named marker at cwd");
      assertEquals(warmupExtensionForDirectory(dir), ".cs", "Should warm up C# for project marker");
    });
  });
}

for (const marker of ["Workspace.sln", "Workspace.slnx"]) {
  test(`csharp: prefers ancestor ${marker} over nested projects`, async () => {
    await withTempDir({
      [marker]: "",
      "src/App/App.csproj": "",
      "src/App/Program.cs": "class Program {}",
      "src/Library/Library.csproj": "",
      "src/Library/Library.cs": "class Library {}",
    }, async dir => {
      for (const file of ["src/App/Program.cs", "src/Library/Library.cs"]) {
        assertEquals(csharp.findRoot(join(dir, file), dir), dir, "Projects should share the solution root");
      }
    });
  });
}

test("csharp: nearest solution wins when solutions are nested", async () => {
  await withTempDir({ "Outer.sln": "", "nested/Inner.slnx": "", "nested/App/App.csproj": "", "nested/App/File.cs": "" }, async dir => {
    assertEquals(csharp.findRoot(join(dir, "nested/App/File.cs"), dir), join(dir, "nested"), "Should prefer nearest solution");
  });
});

test("csharp: nearest project wins without a solution", async () => {
  await withTempDir({ "Outer.csproj": "", "nested/Inner.csproj": "", "nested/src/File.cs": "" }, async dir => {
    assertEquals(csharp.findRoot(join(dir, "nested/src/File.cs"), dir), join(dir, "nested"), "Should use nearest csproj");
  });
});

test("csharp: does not search above cwd even for a solution", async () => {
  await withTempDir({ "Outer.slnx": "", "app/App.csproj": "", "app/src/File.cs": "", "standalone/File.cs": "" }, async dir => {
    assertEquals(csharp.findRoot(join(dir, "app/src/File.cs"), join(dir, "app")), join(dir, "app"), "Solution above cwd must not override local project");
    assertEquals(csharp.findRoot(join(dir, "standalone/File.cs"), join(dir, "standalone")), undefined, "Solution above cwd must not support standalone file");
  });
});

test("csharp: rejects outside files and misleading cwd prefixes", async () => {
  await withTempDir({ "app/App.csproj": "", "app-other/Other.sln": "", "app-other/src/File.cs": "", "unrelated/deep/Other.csproj": "", "unrelated/deep/File.cs": "" }, async dir => {
    for (const file of ["app-other/src/File.cs", "unrelated/deep/File.cs"]) {
      assertEquals(csharp.findRoot(join(dir, file), join(dir, "app")), undefined, "Outside files cannot borrow an unrelated root");
    }
  });
});

test("csharp: uses real ancestry across symlinks", async () => {
  await withTempDir({ "app/App.csproj": "", "app/File.cs": "", "outside/Other.csproj": "", "outside/File.cs": "" }, async dir => {
    await symlink(join(dir, "app"), join(dir, "alias"), "dir");
    await symlink(join(dir, "outside"), join(dir, "app/external"), "dir");
    assertEquals(csharp.findRoot(join(dir, "alias/File.cs"), join(dir, "alias")), join(dir, "app"), "Symlink cwd should resolve to the real project");
    assertEquals(csharp.findRoot(join(dir, "app/external/File.cs"), join(dir, "app")), undefined, "Symlink must not escape cwd");
  });
});

test("csharp: ignores sibling markers and marker-shaped directories", async () => {
  await withTempDir({ "sibling/Other.slnx": "", "sibling/Other.csproj": "", "App.csproj": null, "Fake.sln": null, "Fake.slnx": null, "src/File.cs": "class File {}" }, async dir => {
    assertEquals(csharp.findRoot(join(dir, "src/File.cs"), dir), undefined, "Only ancestor marker files should count");
    assertEquals(warmupExtensionForDirectory(dir), undefined, "Do not warm up for directories or sibling markers");
  });
});

test("csharp: unsupported standalone files explain project requirements", async () => {
  await withTempDir({ "File.cs": "class File {}" }, async dir => {
    const manager = new LSPManager(dir);
    try {
      const result = await manager.touchFileAndWait(join(dir, "File.cs"), 100);
      assert(result.unsupported === true, "Standalone C# is unsupported");
      assert(result.error?.includes("Standalone C# files are unsupported") === true, "Should explain standalone limitation");
      assert(result.error?.includes("*.slnx") === true && result.error?.includes("*.csproj") === true, "Should list project markers");
      const batch = await manager.getDiagnosticsForFiles([join(dir, "File.cs")], 100);
      assertEquals(batch.items[0].status, "unsupported", "Batch diagnostics should also report unsupported");
    } finally {
      await manager.shutdown();
    }
  });
});

// ============================================================================
// Swift root detection tests
// ============================================================================

test("swift: finds root with Package.swift", async () => {
  await withTempDir({
    "Package.swift": "// swift-tools-version: 5.9",
    "Sources/App/main.swift": "print(\"hi\")",
  }, async (dir) => {
    const server = LSP_SERVERS.find(s => s.id === "swift")!;
    const root = server.findRoot(join(dir, "Sources/App/main.swift"), dir);
    assertEquals(root, dir, "Should find root at Package.swift location");
  });
});

test("swift: finds root with Xcode project", async () => {
  await withTempDir({
    "MyApp.xcodeproj/project.pbxproj": "// pbxproj",
    "MyApp/main.swift": "print(\"hi\")",
  }, async (dir) => {
    const server = LSP_SERVERS.find(s => s.id === "swift")!;
    const root = server.findRoot(join(dir, "MyApp/main.swift"), dir);
    assertEquals(root, dir, "Should find root at Xcode project location");
  });
});

test("swift: finds root with Xcode workspace", async () => {
  await withTempDir({
    "MyApp.xcworkspace/contents.xcworkspacedata": "<Workspace/>",
    "MyApp/main.swift": "print(\"hi\")",
  }, async (dir) => {
    const server = LSP_SERVERS.find(s => s.id === "swift")!;
    const root = server.findRoot(join(dir, "MyApp/main.swift"), dir);
    assertEquals(root, dir, "Should find root at Xcode workspace location");
  });
});

// ============================================================================
// Python root detection tests
// ============================================================================

test("pyright: finds root with pyproject.toml", async () => {
  await withTempDir({
    "pyproject.toml": "[project]\nname = \"myapp\"",
    "src/main.py": "print('hello')",
  }, async (dir) => {
    const server = LSP_SERVERS.find(s => s.id === "pyright")!;
    const root = server.findRoot(join(dir, "src/main.py"), dir);
    assertEquals(root, dir, "Should find root at pyproject.toml location");
  });
});

test("pyright: finds root with setup.py", async () => {
  await withTempDir({
    "setup.py": "from setuptools import setup",
    "myapp/main.py": "print('hello')",
  }, async (dir) => {
    const server = LSP_SERVERS.find(s => s.id === "pyright")!;
    const root = server.findRoot(join(dir, "myapp/main.py"), dir);
    assertEquals(root, dir, "Should find root at setup.py location");
  });
});

test("pyright: finds root with requirements.txt", async () => {
  await withTempDir({
    "requirements.txt": "flask>=2.0",
    "app.py": "from flask import Flask",
  }, async (dir) => {
    const server = LSP_SERVERS.find(s => s.id === "pyright")!;
    const root = server.findRoot(join(dir, "app.py"), dir);
    assertEquals(root, dir, "Should find root at requirements.txt location");
  });
});

// ============================================================================
// URI construction tests (pathToFileURL)
// ============================================================================

test("pathToFileURL: handles simple paths", async () => {
  const uri = pathToFileURL("/home/user/project/file.ts").href;
  assertEquals(uri, "file:///home/user/project/file.ts", "Should create proper file URI");
});

test("pathToFileURL: encodes special characters", async () => {
  const uri = pathToFileURL("/home/user/my project/file.ts").href;
  assert(uri.includes("my%20project"), "Should URL-encode spaces");
});

test("pathToFileURL: handles unicode", async () => {
  const uri = pathToFileURL("/home/user/项目/file.ts").href;
  // pathToFileURL properly encodes unicode
  assert(uri.startsWith("file:///"), "Should start with file:///");
  assert(uri.includes("file.ts"), "Should contain filename");
});

// ============================================================================
// Vue/Svelte root detection tests
// ============================================================================

test("vue: finds root with package.json", async () => {
  await withTempDir({
    "package.json": "{}",
    "src/App.vue": "<template></template>",
  }, async (dir) => {
    const server = LSP_SERVERS.find(s => s.id === "vue")!;
    const root = server.findRoot(join(dir, "src/App.vue"), dir);
    assertEquals(root, dir, "Should find root at package.json location");
  });
});

test("vue: finds root with vite.config.ts", async () => {
  await withTempDir({
    "vite.config.ts": "export default {}",
    "src/App.vue": "<template></template>",
  }, async (dir) => {
    const server = LSP_SERVERS.find(s => s.id === "vue")!;
    const root = server.findRoot(join(dir, "src/App.vue"), dir);
    assertEquals(root, dir, "Should find root at vite.config.ts location");
  });
});

test("svelte: finds root with svelte.config.js", async () => {
  await withTempDir({
    "svelte.config.js": "export default {}",
    "src/App.svelte": "<script></script>",
  }, async (dir) => {
    const server = LSP_SERVERS.find(s => s.id === "svelte")!;
    const root = server.findRoot(join(dir, "src/App.svelte"), dir);
    assertEquals(root, dir, "Should find root at svelte.config.js location");
  });
});

// ============================================================================
// Additional Rust tests (parity with TypeScript)
// ============================================================================

test("rust: finds root in src subdirectory", async () => {
  await withTempDir({
    "Cargo.toml": "[package]\nname = \"myapp\"",
    "src/main.rs": "fn main() {}",
    "src/lib.rs": "pub mod utils;",
    "src/utils/mod.rs": "pub fn helper() {}",
  }, async (dir) => {
    const server = LSP_SERVERS.find(s => s.id === "rust-analyzer")!;
    const root = server.findRoot(join(dir, "src/utils/mod.rs"), dir);
    assertEquals(root, dir, "Should find root from deeply nested src file");
  });
});

test("rust: workspace with multiple crates", async () => {
  await withTempDir({
    "Cargo.toml": "[workspace]\nmembers = [\"crates/*\"]",
    "crates/api/Cargo.toml": "[package]\nname = \"api\"",
    "crates/api/src/lib.rs": "pub fn serve() {}",
    "crates/core/Cargo.toml": "[package]\nname = \"core\"",
    "crates/core/src/lib.rs": "pub fn init() {}",
  }, async (dir) => {
    const server = LSP_SERVERS.find(s => s.id === "rust-analyzer")!;
    // Each crate should find its own Cargo.toml
    const apiRoot = server.findRoot(join(dir, "crates/api/src/lib.rs"), dir);
    const coreRoot = server.findRoot(join(dir, "crates/core/src/lib.rs"), dir);
    assertEquals(apiRoot, join(dir, "crates/api"), "API crate should find its Cargo.toml");
    assertEquals(coreRoot, join(dir, "crates/core"), "Core crate should find its Cargo.toml");
  });
});

test("rust: returns undefined when no Cargo.toml", async () => {
  await withTempDir({
    "main.rs": "fn main() {}",
  }, async (dir) => {
    const server = LSP_SERVERS.find(s => s.id === "rust-analyzer")!;
    const root = server.findRoot(join(dir, "main.rs"), dir);
    assertEquals(root, undefined, "Should return undefined when no Cargo.toml");
  });
});

// ============================================================================
// Additional Dart tests (parity with TypeScript)
// ============================================================================

test("dart: Flutter project with pubspec.yaml", async () => {
  await withTempDir({
    "pubspec.yaml": "name: my_flutter_app\ndependencies:\n  flutter:\n    sdk: flutter",
    "lib/main.dart": "import 'package:flutter/material.dart';",
    "lib/screens/home.dart": "class HomeScreen {}",
  }, async (dir) => {
    const server = LSP_SERVERS.find(s => s.id === "dart")!;
    const root = server.findRoot(join(dir, "lib/screens/home.dart"), dir);
    assertEquals(root, dir, "Should find root for Flutter project");
  });
});

test("dart: returns undefined when no marker files", async () => {
  await withTempDir({
    "main.dart": "void main() {}",
  }, async (dir) => {
    const server = LSP_SERVERS.find(s => s.id === "dart")!;
    const root = server.findRoot(join(dir, "main.dart"), dir);
    assertEquals(root, undefined, "Should return undefined when no pubspec.yaml or analysis_options.yaml");
  });
});

test("dart: monorepo with multiple packages", async () => {
  await withTempDir({
    "pubspec.yaml": "name: monorepo",
    "packages/auth/pubspec.yaml": "name: auth",
    "packages/auth/lib/auth.dart": "class Auth {}",
    "packages/ui/pubspec.yaml": "name: ui",
    "packages/ui/lib/widgets.dart": "class Button {}",
  }, async (dir) => {
    const server = LSP_SERVERS.find(s => s.id === "dart")!;
    const authRoot = server.findRoot(join(dir, "packages/auth/lib/auth.dart"), dir);
    const uiRoot = server.findRoot(join(dir, "packages/ui/lib/widgets.dart"), dir);
    assertEquals(authRoot, join(dir, "packages/auth"), "Auth package should find its pubspec");
    assertEquals(uiRoot, join(dir, "packages/ui"), "UI package should find its pubspec");
  });
});

// ============================================================================
// Additional Python tests (parity with TypeScript)
// ============================================================================

test("pyright: finds root with pyrightconfig.json", async () => {
  await withTempDir({
    "pyrightconfig.json": "{}",
    "src/app.py": "print('hello')",
  }, async (dir) => {
    const server = LSP_SERVERS.find(s => s.id === "pyright")!;
    const root = server.findRoot(join(dir, "src/app.py"), dir);
    assertEquals(root, dir, "Should find root at pyrightconfig.json location");
  });
});

test("pyright: returns undefined when no marker files", async () => {
  await withTempDir({
    "script.py": "print('hello')",
  }, async (dir) => {
    const server = LSP_SERVERS.find(s => s.id === "pyright")!;
    const root = server.findRoot(join(dir, "script.py"), dir);
    assertEquals(root, undefined, "Should return undefined when no Python project markers");
  });
});

test("pyright: monorepo with multiple packages", async () => {
  await withTempDir({
    "pyproject.toml": "[project]\nname = \"monorepo\"",
    "packages/api/pyproject.toml": "[project]\nname = \"api\"",
    "packages/api/src/main.py": "from flask import Flask",
    "packages/worker/pyproject.toml": "[project]\nname = \"worker\"",
    "packages/worker/src/tasks.py": "def process(): pass",
  }, async (dir) => {
    const server = LSP_SERVERS.find(s => s.id === "pyright")!;
    const apiRoot = server.findRoot(join(dir, "packages/api/src/main.py"), dir);
    const workerRoot = server.findRoot(join(dir, "packages/worker/src/tasks.py"), dir);
    assertEquals(apiRoot, join(dir, "packages/api"), "API package should find its pyproject.toml");
    assertEquals(workerRoot, join(dir, "packages/worker"), "Worker package should find its pyproject.toml");
  });
});

// ============================================================================
// Additional Go tests
// ============================================================================

test("gopls: monorepo with multiple modules", async () => {
  await withTempDir({
    "go.work": "go 1.21\nuse (\n  ./api\n  ./worker\n)",
    "api/go.mod": "module example.com/api",
    "api/main.go": "package main",
    "worker/go.mod": "module example.com/worker",
    "worker/main.go": "package main",
  }, async (dir) => {
    const server = LSP_SERVERS.find(s => s.id === "gopls")!;
    // With go.work present, all files should use workspace root
    const apiRoot = server.findRoot(join(dir, "api/main.go"), dir);
    const workerRoot = server.findRoot(join(dir, "worker/main.go"), dir);
    assertEquals(apiRoot, dir, "API module should use go.work root");
    assertEquals(workerRoot, dir, "Worker module should use go.work root");
  });
});

test("gopls: nested cmd directory", async () => {
  await withTempDir({
    "go.mod": "module example.com/myapp",
    "cmd/server/main.go": "package main",
    "cmd/cli/main.go": "package main",
    "internal/db/db.go": "package db",
  }, async (dir) => {
    const server = LSP_SERVERS.find(s => s.id === "gopls")!;
    const serverRoot = server.findRoot(join(dir, "cmd/server/main.go"), dir);
    const cliRoot = server.findRoot(join(dir, "cmd/cli/main.go"), dir);
    const dbRoot = server.findRoot(join(dir, "internal/db/db.go"), dir);
    assertEquals(serverRoot, dir, "cmd/server should find go.mod at root");
    assertEquals(cliRoot, dir, "cmd/cli should find go.mod at root");
    assertEquals(dbRoot, dir, "internal/db should find go.mod at root");
  });
});

// ============================================================================
// Additional TypeScript tests
// ============================================================================

test("typescript: pnpm workspace", async () => {
  await withTempDir({
    "package.json": "{}",
    "pnpm-workspace.yaml": "packages:\n  - packages/*",
    "packages/web/package.json": "{}",
    "packages/web/src/App.tsx": "export const App = () => null;",
    "packages/api/package.json": "{}",
    "packages/api/src/index.ts": "export const handler = () => {};",
  }, async (dir) => {
    const server = LSP_SERVERS.find(s => s.id === "typescript")!;
    const webRoot = server.findRoot(join(dir, "packages/web/src/App.tsx"), dir);
    const apiRoot = server.findRoot(join(dir, "packages/api/src/index.ts"), dir);
    assertEquals(webRoot, join(dir, "packages/web"), "Web package should find its package.json");
    assertEquals(apiRoot, join(dir, "packages/api"), "API package should find its package.json");
  });
});

test("typescript: returns undefined when no config files", async () => {
  await withTempDir({
    "script.ts": "const x = 1;",
  }, async (dir) => {
    const server = LSP_SERVERS.find(s => s.id === "typescript")!;
    const root = server.findRoot(join(dir, "script.ts"), dir);
    assertEquals(root, undefined, "Should return undefined when no package.json or tsconfig.json");
  });
});

test("typescript: prefers nearest tsconfig over package.json", async () => {
  await withTempDir({
    "package.json": "{}",
    "apps/web/tsconfig.json": "{}",
    "apps/web/src/index.ts": "export const x = 1;",
  }, async (dir) => {
    const server = LSP_SERVERS.find(s => s.id === "typescript")!;
    const root = server.findRoot(join(dir, "apps/web/src/index.ts"), dir);
    // Should find tsconfig.json first (it's nearer than root package.json)
    assertEquals(root, join(dir, "apps/web"), "Should find nearest config file");
  });
});

// ============================================================================
// Additional Vue/Svelte tests
// ============================================================================

test("vue: Nuxt project", async () => {
  await withTempDir({
    "package.json": "{}",
    "nuxt.config.ts": "export default {}",
    "pages/index.vue": "<template></template>",
    "components/Button.vue": "<template></template>",
  }, async (dir) => {
    const server = LSP_SERVERS.find(s => s.id === "vue")!;
    const pagesRoot = server.findRoot(join(dir, "pages/index.vue"), dir);
    const componentsRoot = server.findRoot(join(dir, "components/Button.vue"), dir);
    assertEquals(pagesRoot, dir, "Pages should find root");
    assertEquals(componentsRoot, dir, "Components should find root");
  });
});

test("vue: returns undefined when no config", async () => {
  await withTempDir({
    "App.vue": "<template></template>",
  }, async (dir) => {
    const server = LSP_SERVERS.find(s => s.id === "vue")!;
    const root = server.findRoot(join(dir, "App.vue"), dir);
    assertEquals(root, undefined, "Should return undefined when no package.json or vite.config");
  });
});

test("svelte: SvelteKit project", async () => {
  await withTempDir({
    "package.json": "{}",
    "svelte.config.js": "export default {}",
    "src/routes/+page.svelte": "<script></script>",
    "src/lib/components/Button.svelte": "<script></script>",
  }, async (dir) => {
    const server = LSP_SERVERS.find(s => s.id === "svelte")!;
    const routeRoot = server.findRoot(join(dir, "src/routes/+page.svelte"), dir);
    const libRoot = server.findRoot(join(dir, "src/lib/components/Button.svelte"), dir);
    assertEquals(routeRoot, dir, "Route should find root");
    assertEquals(libRoot, dir, "Lib component should find root");
  });
});

test("svelte: returns undefined when no config", async () => {
  await withTempDir({
    "App.svelte": "<script></script>",
  }, async (dir) => {
    const server = LSP_SERVERS.find(s => s.id === "svelte")!;
    const root = server.findRoot(join(dir, "App.svelte"), dir);
    assertEquals(root, undefined, "Should return undefined when no package.json or svelte.config.js");
  });
});

// ============================================================================
// Stop boundary tests (findNearestFile respects cwd boundary)
// ============================================================================

test("stop boundary: does not search above cwd", async () => {
  await withTempDir({
    "package.json": "{}", // This is at root
    "projects/myapp/src/index.ts": "export const x = 1;",
    // Note: no package.json in projects/myapp
  }, async (dir) => {
    const server = LSP_SERVERS.find(s => s.id === "typescript")!;
    // When cwd is set to projects/myapp, it should NOT find the root package.json
    const projectDir = join(dir, "projects/myapp");
    const root = server.findRoot(join(projectDir, "src/index.ts"), projectDir);
    assertEquals(root, undefined, "Should not find package.json above cwd boundary");
  });
});

test("stop boundary: finds marker at cwd level", async () => {
  await withTempDir({
    "projects/myapp/package.json": "{}",
    "projects/myapp/src/index.ts": "export const x = 1;",
  }, async (dir) => {
    const server = LSP_SERVERS.find(s => s.id === "typescript")!;
    const projectDir = join(dir, "projects/myapp");
    const root = server.findRoot(join(projectDir, "src/index.ts"), projectDir);
    assertEquals(root, projectDir, "Should find package.json at cwd level");
  });
});

// ============================================================================
// Edge cases
// ============================================================================

test("edge: deeply nested file finds correct root", async () => {
  await withTempDir({
    "package.json": "{}",
    "src/components/ui/buttons/primary/Button.tsx": "export const Button = () => null;",
  }, async (dir) => {
    const server = LSP_SERVERS.find(s => s.id === "typescript")!;
    const root = server.findRoot(join(dir, "src/components/ui/buttons/primary/Button.tsx"), dir);
    assertEquals(root, dir, "Should find root even for deeply nested files");
  });
});

test("edge: file at root level finds root", async () => {
  await withTempDir({
    "package.json": "{}",
    "index.ts": "console.log('root');",
  }, async (dir) => {
    const server = LSP_SERVERS.find(s => s.id === "typescript")!;
    const root = server.findRoot(join(dir, "index.ts"), dir);
    assertEquals(root, dir, "Should find root for file at root level");
  });
});

test("edge: no marker files returns undefined", async () => {
  await withTempDir({
    "random.ts": "const x = 1;",
  }, async (dir) => {
    const server = LSP_SERVERS.find(s => s.id === "typescript")!;
    const root = server.findRoot(join(dir, "random.ts"), dir);
    assertEquals(root, undefined, "Should return undefined when no marker files");
  });
});

// ============================================================================
// Run tests
// ============================================================================

async function runTests(): Promise<void> {
  console.log("Running LSP tests...\n");

  const results: TestResult[] = [];
  let passed = 0;
  let failed = 0;

  for (const { name, fn } of tests) {
    try {
      await fn();
      results.push({ name, passed: true });
      console.log(`  ${name}... ✓`);
      passed++;
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      results.push({ name, passed: false, error: errorMsg });
      console.log(`  ${name}... ✗`);
      console.log(`    Error: ${errorMsg}\n`);
      failed++;
    }
  }

  console.log(`\n${passed} passed, ${failed} failed`);

  if (failed > 0) {
    process.exit(1);
  }
}

runTests();
