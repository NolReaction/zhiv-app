import path from "node:path";
import ts from "typescript";

const sourceExtension = /\.[cm]?[jt]sx?$/;
const domainPath = /^features\/(?:economy|world)\/domain\//;
const sourceSuffixes = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs", ".d.ts", ".json", ".css"];

/** Parse actual module references, keeping erased type imports out of runtime boundaries. */
export function moduleReferences(file, text) {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const references = [];
  function add(node, specifier, typeOnly = false) {
    if (!specifier || (!ts.isStringLiteral(specifier) && !ts.isNoSubstitutionTemplateLiteral(specifier))) return;
    const { line, character } = source.getLineAndCharacterOfPosition(node.getStart(source));
    references.push({ specifier: specifier.text, typeOnly: Boolean(typeOnly), line: line + 1, column: character + 1 });
  }
  function visit(node) {
    if (ts.isImportDeclaration(node)) {
      const clause = node.importClause;
      const names = clause?.namedBindings;
      const onlyNamedTypes = names && ts.isNamedImports(names) && names.elements.length > 0
        && names.elements.every(item => item.isTypeOnly) && !clause.name;
      add(node, node.moduleSpecifier, clause?.isTypeOnly || onlyNamedTypes);
    } else if (ts.isExportDeclaration(node)) {
      const names = node.exportClause;
      const onlyNamedTypes = names && ts.isNamedExports(names) && names.elements.length > 0
        && names.elements.every(item => item.isTypeOnly);
      add(node, node.moduleSpecifier, node.isTypeOnly || onlyNamedTypes);
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
      add(node, node.argument.literal, true);
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      add(node, node.moduleReference.expression, node.isTypeOnly);
    } else if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword
      || (ts.isIdentifier(node.expression) && node.expression.text === "require"))) {
      add(node, node.arguments[0]);
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return references;
}

export function resolveLocalReference(from, specifier, hasFile) {
  if (!specifier.startsWith(".") && !specifier.startsWith("@/")) return null;
  const clean = specifier.replace(/[?#].*$/, "");
  const base = path.posix.normalize(clean.startsWith("@/") ? clean.slice(2) : path.posix.join(path.posix.dirname(from), clean));
  const candidates = [base];
  if (/\.[cm]?jsx?$/.test(base)) {
    const extension = path.posix.extname(base);
    const stem = base.slice(0, -extension.length);
    const replacements = extension === ".mjs" ? [".mts"] : extension === ".cjs" ? [".cts"] : [".ts", ".tsx"];
    candidates.push(...replacements.map(suffix => stem + suffix));
  }
  candidates.push(...sourceSuffixes.map(suffix => base + suffix));
  candidates.push(...sourceSuffixes.map(suffix => `${base}/index${suffix}`));
  return { target: candidates.find(hasFile) ?? null, expected: base };
}

function isUi(target) {
  return target.startsWith("components/") || /^features\/[^/]+\/ui\//.test(target) || /\.css$/.test(target);
}

/** These rules protect established boundaries; integration modules may connect domains. */
export function inspectArchitecture(sources, { hasFile = file => sources.has(file) } = {}) {
  const diagnostics = [];
  const graph = new Map();
  function report(file, reference, rule, message) {
    diagnostics.push({ file, line: reference.line, column: reference.column, rule, message });
  }
  for (const [file, text] of sources) {
    if (!sourceExtension.test(file) || file.endsWith(".d.ts")) continue;
    if (file.startsWith("features/")) graph.set(file, []);
    for (const reference of moduleReferences(file, text)) {
      const resolved = resolveLocalReference(file, reference.specifier, hasFile);
      if (resolved && !resolved.target) {
        report(file, reference, "missing-local-import", `Cannot resolve ${reference.specifier}. Update the reference after moving a file.`);
        continue;
      }
      if (reference.typeOnly) continue;
      const target = resolved?.target;
      if (target?.startsWith("features/") && graph.has(file)) graph.get(file).push({ target, reference });
      if (domainPath.test(file)) {
        const uiPackage = /^(?:react|react-dom|next|lucide-react)(?:\/|$)/.test(reference.specifier);
        const clientLayer = target && (isUi(target) || target.endsWith(".tsx")
          || /^features\/(?:economy|world)\/(?:sync|state)\//.test(target));
        if (uiPackage || clientLayer) {
          report(file, reference, "domain-dependency", `Domain code cannot load ${reference.specifier}. Keep rules independent of UI and client sessions; compose them in sync/integration/UI.`);
        }
      }
      if (file.startsWith("features/economy/sync/") && target && isUi(target)) {
        report(file, reference, "sync-ui-dependency", `Economy sync cannot load ${reference.specifier}. Move shared controller helpers out of UI.`);
      }
      if (target?.startsWith("app/") && !file.startsWith("app/")) {
        report(file, reference, "route-orchestration", `Only route composition may load ${reference.specifier}. Reusable modules belong outside app/.`);
      }
      if (target === "features/app/app-shell.tsx" && !file.startsWith("app/") && !file.startsWith("features/app/")) {
        report(file, reference, "app-orchestration", `Feature modules cannot load the app shell. Pass data or callbacks from the shell instead.`);
      }
    }
  }

  // Feature modules currently form a runtime DAG. Local API stores in lib/dev are outside this rule.
  const visited = new Set(), active = new Set(), stack = [];
  function visit(file) {
    visited.add(file); active.add(file); stack.push(file);
    for (const { target, reference } of graph.get(file) ?? []) {
      if (!graph.has(target)) continue;
      if (active.has(target)) {
        const cycle = [...stack.slice(stack.indexOf(target)), target];
        report(file, reference, "feature-cycle", `Runtime feature dependency cycle: ${cycle.join(" -> ")}. Extract shared data or invert the dependency.`);
      } else if (!visited.has(target)) visit(target);
    }
    stack.pop(); active.delete(file);
  }
  for (const file of graph.keys()) if (!visited.has(file)) visit(file);
  return diagnostics.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.rule.localeCompare(b.rule));
}
