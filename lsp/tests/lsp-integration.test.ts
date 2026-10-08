/**
 * Integration tests for LSP - spawns real language servers and detects errors
 *
 * Run with: npm run test:integration
 *
 * Skips tests if language server is not installed.
 */

// Suppress stream errors from vscode-jsonrpc when LSP process exits
process.on('uncaughtException', (err) => {
  if (err.message?.includes('write after end')) return;
  console.error('Uncaught:', err);
  process.exit(1);
});

import { mkdtemp, rm, writeFile, mkdir } from "fs/promises";
import { existsSync, statSync } from "fs";
import { tmpdir } from "os";
import { join, delimiter } from "path";
import { LSPManager, collectSymbols } from "../lsp-core.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";

// ============================================================================
// Test utilities
// ============================================================================

const tests: Array<{ name: string; fn: () => Promise<void> }> = [];
let skipped = 0;

function test(name: string, fn: () => Promise<void>) {
  tests.push({ name, fn });
}

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(message);
}

class SkipTest extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "SkipTest";
  }
}

function skip(reason: string): never {
  throw new SkipTest(reason);
}

// Search paths matching lsp-core.ts
const SEARCH_PATHS = [
  ...(process.env.PATH?.split(delimiter) || []),
  "/usr/local/bin",
  "/opt/homebrew/bin",
  `${process.env.HOME || ""}/.pub-cache/bin`,
  `${process.env.HOME || ""}/fvm/default/bin`,
  `${process.env.HOME || ""}/go/bin`,
  `${process.env.HOME || ""}/.cargo/bin`,
];

function commandExists(cmd: string): boolean {
  for (const dir of SEARCH_PATHS) {
    const full = join(dir, cmd);
    try {
      if (existsSync(full) && statSync(full).isFile()) return true;
    } catch {}
  }
  return false;
}

// ============================================================================
// TypeScript
// ============================================================================

test("typescript: detects type errors", async () => {
  if (!commandExists("typescript-language-server")) {
    skip("typescript-language-server not installed");
  }

  const dir = await mkdtemp(join(tmpdir(), "lsp-ts-"));
  const manager = new LSPManager(dir);

  try {
    await writeFile(join(dir, "package.json"), "{}");
    await writeFile(join(dir, "tsconfig.json"), JSON.stringify({
      compilerOptions: { strict: true, noEmit: true }
    }));

    // Code with type error
    const file = join(dir, "index.ts");
    await writeFile(file, `const x: string = 123;`);

    const { diagnostics } = await manager.touchFileAndWait(file, 10000);

    assert(diagnostics.length > 0, `Expected errors, got ${diagnostics.length}`);
    assert(
      diagnostics.some(d => d.message.toLowerCase().includes("type") || d.severity === 1),
      `Expected type error, got: ${diagnostics.map(d => d.message).join(", ")}`
    );
  } finally {
    await manager.shutdown();
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

test("typescript: valid code has no errors", async () => {
  if (!commandExists("typescript-language-server")) {
    skip("typescript-language-server not installed");
  }

  const dir = await mkdtemp(join(tmpdir(), "lsp-ts-"));
  const manager = new LSPManager(dir);

  try {
    await writeFile(join(dir, "package.json"), "{}");
    await writeFile(join(dir, "tsconfig.json"), JSON.stringify({
      compilerOptions: { strict: true, noEmit: true }
    }));

    const file = join(dir, "index.ts");
    await writeFile(file, `const x: string = "hello";`);

    const { diagnostics } = await manager.touchFileAndWait(file, 10000);
    const errors = diagnostics.filter(d => d.severity === 1);

    assert(errors.length === 0, `Expected no errors, got: ${errors.map(d => d.message).join(", ")}`);
  } finally {
    await manager.shutdown();
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

// ============================================================================
// C# (.NET 10 / csharp-ls)
// ============================================================================

async function withCSharpProject(fn: (dir: string, manager: LSPManager, file: string) => Promise<void>): Promise<void> {
  if (!commandExists("csharp-ls")) skip("csharp-ls not installed");
  if (!commandExists("dotnet")) skip("dotnet not installed");
  const run = promisify(execFile);
  const { stdout: sdks } = await run("dotnet", ["--list-sdks"], { timeout: 10000 });
  if (!/^10\./m.test(sdks)) skip(".NET 10 SDK not installed");

  const dir = await mkdtemp(join(tmpdir(), "lsp-csharp-"));
  const manager = new LSPManager(dir);
  try {
    const project = join(dir, "App.csproj");
    await writeFile(project, `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup><TargetFramework>net10.0</TargetFramework></PropertyGroup>
</Project>\n`);
    // Explicit restore is required for Roslyn/MSBuild to resolve framework references.
    // A restore or server failure is a test failure, never a reason to skip.
    await run("dotnet", ["restore", project, "--nologo"], { cwd: dir, timeout: 60000 });
    await fn(dir, manager, join(dir, "Calculator.cs"));
  } finally {
    await manager.shutdown();
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

async function csharpQuery<T>(request: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout;
  try {
    return await Promise.race([request, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("C# query timed out")), 20000);
    })]);
  } finally {
    clearTimeout(timer!);
  }
}

test("csharp: reports an actual type error in a restored net10.0 project", async () => {
  await withCSharpProject(async (_dir, manager, file) => {
    await writeFile(file, `public static class Calculator
{
    public static string Message() => 123;
}\n`);
    const result = await manager.touchFileAndWait(file, 30000);
    assert(!result.unsupported, result.error || "C# project should be supported");
    assert(result.receivedResponse, "Expected csharp-ls diagnostics response");
    assert(result.diagnostics.some(d => d.severity === 1 && String(d.code) === "CS0029" && d.range.start.line === 2),
      `Expected CS0029 (int to string) on line 3, got: ${JSON.stringify(result.diagnostics)}`);
  });
});

test("csharp: valid code responds without errors and supports symbol queries", async () => {
  await withCSharpProject(async (_dir, manager, file) => {
    const code = `public static class Calculator
{
    public static int Double(int value) => value * 2;
    public static int Run() => Double(21);
}\n`;
    await writeFile(file, code);
    const result = await manager.touchFileAndWait(file, 30000);
    assert(!result.unsupported, result.error || "C# project should be supported");
    assert(result.receivedResponse, "Valid code must receive a diagnostics response, not merely time out");
    assert(result.diagnostics.every(d => d.severity !== 1), `Expected no errors, got: ${JSON.stringify(result.diagnostics)}`);

    const symbols = await csharpQuery(manager.getDocumentSymbols(file));
    const names = collectSymbols(symbols).join("\n");
    assert(names.includes("Calculator") && names.includes("Double"), `Expected class and method symbols, got: ${names}`);
    const column = code.split("\n")[3].indexOf("Double") + 1;
    const hover = await csharpQuery(manager.getHover(file, 4, column));
    assert(hover !== null && JSON.stringify(hover.contents).includes("Double"), `Expected method hover, got: ${JSON.stringify(hover)}`);
    const definitions = await csharpQuery(manager.getDefinition(file, 4, column));
    assert(definitions.some(d => d.uri === pathToFileURL(file).href && d.range.start.line === 2),
      `Expected definition at Double declaration, got: ${JSON.stringify(definitions)}`);
    const references = await csharpQuery(manager.getReferences(file, 4, column));
    assert(references.filter(r => r.uri === pathToFileURL(file).href).length >= 2,
      `Expected declaration and call references, got: ${JSON.stringify(references)}`);
  });
});

// ============================================================================
// Dart
// ============================================================================

test("dart: detects type errors", async () => {
  if (!commandExists("dart")) {
    skip("dart not installed");
  }

  const dir = await mkdtemp(join(tmpdir(), "lsp-dart-"));
  const manager = new LSPManager(dir);

  try {
    await writeFile(join(dir, "pubspec.yaml"), "name: test_app\nenvironment:\n  sdk: ^3.0.0");

    await mkdir(join(dir, "lib"));
    const file = join(dir, "lib/main.dart");
    // Type error: assigning int to String
    await writeFile(file, `
void main() {
  String x = 123;
  print(x);
}
`);

    const { diagnostics } = await manager.touchFileAndWait(file, 15000);

    assert(diagnostics.length > 0, `Expected errors, got ${diagnostics.length}`);
  } finally {
    await manager.shutdown();
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

test("dart: valid code has no errors", async () => {
  if (!commandExists("dart")) {
    skip("dart not installed");
  }

  const dir = await mkdtemp(join(tmpdir(), "lsp-dart-"));
  const manager = new LSPManager(dir);

  try {
    await writeFile(join(dir, "pubspec.yaml"), "name: test_app\nenvironment:\n  sdk: ^3.0.0");

    await mkdir(join(dir, "lib"));
    const file = join(dir, "lib/main.dart");
    await writeFile(file, `
void main() {
  String x = "hello";
  print(x);
}
`);

    const { diagnostics } = await manager.touchFileAndWait(file, 15000);
    const errors = diagnostics.filter(d => d.severity === 1);

    assert(errors.length === 0, `Expected no errors, got: ${errors.map(d => d.message).join(", ")}`);
  } finally {
    await manager.shutdown();
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

// ============================================================================
// Rust
// ============================================================================

test("rust: detects type errors", async () => {
  if (!commandExists("rust-analyzer")) {
    skip("rust-analyzer not installed");
  }

  const dir = await mkdtemp(join(tmpdir(), "lsp-rust-"));
  const manager = new LSPManager(dir);

  try {
    await writeFile(join(dir, "Cargo.toml"), `[package]\nname = "test"\nversion = "0.1.0"\nedition = "2021"`);

    await mkdir(join(dir, "src"));
    const file = join(dir, "src/main.rs");
    await writeFile(file, `fn main() {\n    let x: i32 = "hello";\n}`);

    // rust-analyzer needs a LOT of time to initialize (compiles the project)
    const { diagnostics } = await manager.touchFileAndWait(file, 60000);

    assert(diagnostics.length > 0, `Expected errors, got ${diagnostics.length}`);
  } finally {
    await manager.shutdown();
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

test("rust: valid code has no errors", async () => {
  if (!commandExists("rust-analyzer")) {
    skip("rust-analyzer not installed");
  }

  const dir = await mkdtemp(join(tmpdir(), "lsp-rust-"));
  const manager = new LSPManager(dir);

  try {
    await writeFile(join(dir, "Cargo.toml"), `[package]\nname = "test"\nversion = "0.1.0"\nedition = "2021"`);

    await mkdir(join(dir, "src"));
    const file = join(dir, "src/main.rs");
    await writeFile(file, `fn main() {\n    let x = "hello";\n    println!("{}", x);\n}`);

    const { diagnostics } = await manager.touchFileAndWait(file, 60000);
    const errors = diagnostics.filter(d => d.severity === 1);

    assert(errors.length === 0, `Expected no errors, got: ${errors.map(d => d.message).join(", ")}`);
  } finally {
    await manager.shutdown();
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

// ============================================================================
// Go
// ============================================================================

test("go: detects type errors", async () => {
  if (!commandExists("gopls")) {
    skip("gopls not installed");
  }

  const dir = await mkdtemp(join(tmpdir(), "lsp-go-"));
  const manager = new LSPManager(dir);

  try {
    await writeFile(join(dir, "go.mod"), "module test\n\ngo 1.21");

    const file = join(dir, "main.go");
    // Type error: cannot use int as string
    await writeFile(file, `package main

func main() {
	var x string = 123
	println(x)
}
`);

    const { diagnostics } = await manager.touchFileAndWait(file, 15000);

    assert(diagnostics.length > 0, `Expected errors, got ${diagnostics.length}`);
  } finally {
    await manager.shutdown();
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

test("go: valid code has no errors", async () => {
  if (!commandExists("gopls")) {
    skip("gopls not installed");
  }

  const dir = await mkdtemp(join(tmpdir(), "lsp-go-"));
  const manager = new LSPManager(dir);

  try {
    await writeFile(join(dir, "go.mod"), "module test\n\ngo 1.21");

    const file = join(dir, "main.go");
    await writeFile(file, `package main

func main() {
	var x string = "hello"
	println(x)
}
`);

    const { diagnostics } = await manager.touchFileAndWait(file, 15000);
    const errors = diagnostics.filter(d => d.severity === 1);

    assert(errors.length === 0, `Expected no errors, got: ${errors.map(d => d.message).join(", ")}`);
  } finally {
    await manager.shutdown();
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

// ============================================================================
// Kotlin
// ============================================================================

test("kotlin: detects syntax errors", async () => {
  if (!commandExists("kotlin-language-server")) {
    skip("kotlin-language-server not installed");
  }

  const dir = await mkdtemp(join(tmpdir(), "lsp-kt-"));
  const manager = new LSPManager(dir);

  try {
    // Minimal Gradle markers so the LSP picks a root
    await writeFile(join(dir, "settings.gradle.kts"), "rootProject.name = \"test\"\n");
    await writeFile(join(dir, "build.gradle.kts"), "// empty\n");

    await mkdir(join(dir, "src/main/kotlin"), { recursive: true });
    const file = join(dir, "src/main/kotlin/Main.kt");

    // Syntax error
    await writeFile(file, "fun main() { val x = }\n");

    const { diagnostics, receivedResponse } = await manager.touchFileAndWait(file, 30000);

    assert(receivedResponse, "Expected Kotlin LSP to respond");
    assert(diagnostics.length > 0, `Expected errors, got ${diagnostics.length}`);
  } finally {
    await manager.shutdown();
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

test("kotlin: valid code has no errors", async () => {
  if (!commandExists("kotlin-language-server")) {
    skip("kotlin-language-server not installed");
  }

  const dir = await mkdtemp(join(tmpdir(), "lsp-kt-"));
  const manager = new LSPManager(dir);

  try {
    await writeFile(join(dir, "settings.gradle.kts"), "rootProject.name = \"test\"\n");
    await writeFile(join(dir, "build.gradle.kts"), "// empty\n");

    await mkdir(join(dir, "src/main/kotlin"), { recursive: true });
    const file = join(dir, "src/main/kotlin/Main.kt");

    await writeFile(file, "fun main() { val x = 1; println(x) }\n");

    const { diagnostics, receivedResponse } = await manager.touchFileAndWait(file, 30000);

    assert(receivedResponse, "Expected Kotlin LSP to respond");
    const errors = diagnostics.filter(d => d.severity === 1);
    assert(errors.length === 0, `Expected no errors, got: ${errors.map(d => d.message).join(", ")}`);
  } finally {
    await manager.shutdown();
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

// ============================================================================
// Python
// ============================================================================

test("python: detects type errors", async () => {
  if (!commandExists("pyright-langserver")) {
    skip("pyright-langserver not installed");
  }

  const dir = await mkdtemp(join(tmpdir(), "lsp-py-"));
  const manager = new LSPManager(dir);

  try {
    await writeFile(join(dir, "pyproject.toml"), `[project]\nname = "test"`);

    const file = join(dir, "main.py");
    // Type error with type annotation
    await writeFile(file, `
def greet(name: str) -> str:
    return "Hello, " + name

x: str = 123  # Type error
result = greet(456)  # Type error
`);

    const { diagnostics } = await manager.touchFileAndWait(file, 10000);

    assert(diagnostics.length > 0, `Expected errors, got ${diagnostics.length}`);
  } finally {
    await manager.shutdown();
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

test("python: valid code has no errors", async () => {
  if (!commandExists("pyright-langserver")) {
    skip("pyright-langserver not installed");
  }

  const dir = await mkdtemp(join(tmpdir(), "lsp-py-"));
  const manager = new LSPManager(dir);

  try {
    await writeFile(join(dir, "pyproject.toml"), `[project]\nname = "test"`);

    const file = join(dir, "main.py");
    await writeFile(file, `
def greet(name: str) -> str:
    return "Hello, " + name

x: str = "world"
result = greet(x)
`);

    const { diagnostics } = await manager.touchFileAndWait(file, 10000);
    const errors = diagnostics.filter(d => d.severity === 1);

    assert(errors.length === 0, `Expected no errors, got: ${errors.map(d => d.message).join(", ")}`);
  } finally {
    await manager.shutdown();
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

// ============================================================================
// Rename (TypeScript)
// ============================================================================

test("typescript: rename symbol", async () => {
  if (!commandExists("typescript-language-server")) {
    skip("typescript-language-server not installed");
  }

  const dir = await mkdtemp(join(tmpdir(), "lsp-ts-rename-"));
  const manager = new LSPManager(dir);

  try {
    await writeFile(join(dir, "package.json"), "{}");
    await writeFile(join(dir, "tsconfig.json"), JSON.stringify({
      compilerOptions: { strict: true, noEmit: true }
    }));

    const file = join(dir, "index.ts");
    await writeFile(file, `function greet(name: string) {
  return "Hello, " + name;
}
const result = greet("world");
`);

    // Touch file first to ensure it's loaded
    await manager.touchFileAndWait(file, 10000);

    // Rename 'greet' at line 1, col 10
    const edit = await manager.rename(file, 1, 10, "sayHello");

    if (!edit) throw new Error("Expected rename to return WorkspaceEdit");
    assert(
      edit.changes !== undefined || edit.documentChanges !== undefined,
      "Expected changes or documentChanges in WorkspaceEdit"
    );

    // Should have edits for both the function definition and the call
    const allEdits: any[] = [];
    if (edit.changes) {
      for (const edits of Object.values(edit.changes)) {
        allEdits.push(...(edits as any[]));
      }
    }
    if (edit.documentChanges) {
      for (const change of edit.documentChanges as any[]) {
        if (change.edits) allEdits.push(...change.edits);
      }
    }

    assert(allEdits.length >= 2, `Expected at least 2 edits (definition + usage), got ${allEdits.length}`);
  } finally {
    await manager.shutdown();
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

// ============================================================================
// Code Actions (TypeScript)
// ============================================================================

test("typescript: get code actions for error", async () => {
  if (!commandExists("typescript-language-server")) {
    skip("typescript-language-server not installed");
  }

  const dir = await mkdtemp(join(tmpdir(), "lsp-ts-actions-"));
  const manager = new LSPManager(dir);

  try {
    await writeFile(join(dir, "package.json"), "{}");
    await writeFile(join(dir, "tsconfig.json"), JSON.stringify({
      compilerOptions: { strict: true, noEmit: true }
    }));

    const file = join(dir, "index.ts");
    // Missing import - should offer "Add import" code action
    await writeFile(file, `const x: Promise<string> = Promise.resolve("hello");
console.log(x);
`);

    // Touch to get diagnostics first
    await manager.touchFileAndWait(file, 10000);

    // Get code actions at line 1
    const actions = await manager.getCodeActions(file, 1, 1, 1, 50);

    // May or may not have actions depending on the code, but shouldn't throw
    assert(Array.isArray(actions), "Expected array of code actions");
  } finally {
    await manager.shutdown();
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

test("typescript: code actions for missing function", async () => {
  if (!commandExists("typescript-language-server")) {
    skip("typescript-language-server not installed");
  }

  const dir = await mkdtemp(join(tmpdir(), "lsp-ts-actions2-"));
  const manager = new LSPManager(dir);

  try {
    await writeFile(join(dir, "package.json"), "{}");
    await writeFile(join(dir, "tsconfig.json"), JSON.stringify({
      compilerOptions: { strict: true, noEmit: true }
    }));

    const file = join(dir, "index.ts");
    // Call undefined function - should offer quick fix
    await writeFile(file, `const result = undefinedFunction();
`);

    await manager.touchFileAndWait(file, 10000);

    // Get code actions where the error is
    const actions = await manager.getCodeActions(file, 1, 16, 1, 33);

    // TypeScript should offer to create the function
    assert(Array.isArray(actions), "Expected array of code actions");
    // Note: we don't assert on action count since it depends on TS version
  } finally {
    await manager.shutdown();
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

// ============================================================================
// Run tests
// ============================================================================

async function runTests(): Promise<void> {
  console.log("Running LSP integration tests...\n");
  console.log("Note: Tests are skipped if language server is not installed.\n");

  let passed = 0;
  let failed = 0;

  for (const { name, fn } of tests) {
    try {
      await fn();
      console.log(`  ${name}... ✓`);
      passed++;
    } catch (error) {
      if (error instanceof SkipTest) {
        console.log(`  ${name}... ⊘ (${error.message})`);
        skipped++;
      } else {
        const msg = error instanceof Error ? error.message : String(error);
        console.log(`  ${name}... ✗`);
        console.log(`    Error: ${msg}\n`);
        failed++;
      }
    }
  }

  console.log(`\n${passed} passed, ${failed} failed, ${skipped} skipped`);

  if (failed > 0) {
    process.exit(1);
  }
}

runTests();
