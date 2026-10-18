import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";

// Existing progression fixtures isolate their graph in a VM. Execute the real
// pure model helper too, without replacing its policy with a fixture copy.
const source = readFileSync(new URL("../../features/economy/domain/model.ts", import.meta.url), "utf8");
const tree = ts.createSourceFile("model.ts", source, ts.ScriptTarget.Latest, true);
const declaration = tree.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === "recipeBuildingLevel");
if (!declaration) throw new Error("Recipe level helper is missing");
const context = { exports: {} };
vm.runInNewContext(ts.transpileModule(declaration.getText(tree), { compilerOptions: {
  target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS,
} }).outputText, context);
export const recipeBuildingLevel = context.exports.recipeBuildingLevel;
