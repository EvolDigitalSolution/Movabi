/** Test-only AST helpers: extract executable methods/calls without whitespace windows. */
import ts from 'typescript';
import vm from 'node:vm';
export function methodSource(source: string, name: string): string {
  const file = ts.createSourceFile('subject.ts', source, ts.ScriptTarget.Latest, true);
  let found: ts.MethodDeclaration | undefined;
  function visit(node: ts.Node) {
    if (ts.isMethodDeclaration(node) && node.name.getText(file) === name) found = node;
    ts.forEachChild(node, visit);
  }
  visit(file);
  if (!found) throw Error(`Method ${name} not found`);
  return found.getText(file);
}
export function runMethod(source: string, name: string, context: any, args: any[] = [], globals: Record<string, unknown> = {}): any {
  const code = ts.transpileModule(`class Subject { ${methodSource(source, name)} }; globalThis.Subject = Subject;`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 }
  }).outputText;
  const sandbox: any = { ...globals };
  vm.runInNewContext(code, sandbox);
  const subject = Object.assign(new sandbox.Subject(), context);
  return sandbox.Subject.prototype[name].apply(subject, args);
}
export function httpCall(source: string, path: string): string {
  const file = ts.createSourceFile('subject.ts', source, ts.ScriptTarget.Latest, true);
  const found: string[] = [];
  function visit(node: ts.Node) {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
      && ['get','post','put','patch','delete'].includes(node.expression.name.text)
      && node.arguments[0]?.getText(file).includes(path)) found.push(node.getText(file));
    ts.forEachChild(node, visit);
  }
  visit(file);
  if (found.length !== 1) throw Error(`Expected one HTTP call for ${path}, found ${found.length}`);
  return found[0];
}
