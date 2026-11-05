import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as ts from 'typescript';

// expo-router's <Link asChild> merges its child's `style` as `{ ...linkStyle, ...childStyle }`: a function style is
// dropped and an array throws in development (src/portal/ui/hover.ts). The location tabs, LinkButton and the
// console's status filters once lost every style that way, at every width. This keeps each child's style a plain
// object, with hover tracked in state.

const root = join(__dirname, '../..');

function sources(dir: string): string[] {
  return readdirSync(join(root, dir), { recursive: true, encoding: 'utf8' })
    .filter((file) => file.endsWith('.tsx'))
    .map((file) => join(dir, file));
}

type StyleKind = 'function' | 'array' | 'object' | 'none';

interface Site {
  where: string;
  style: StyleKind;
}

function attribute(attributes: ts.JsxAttributes, name: string): ts.JsxAttribute | undefined {
  return attributes.properties.find((property): property is ts.JsxAttribute => ts.isJsxAttribute(property) && property.name.getText() === name);
}

function kindOf(style: ts.JsxAttribute | undefined): StyleKind {
  if (style?.initializer === undefined) return 'none';
  if (!ts.isJsxExpression(style.initializer) || style.initializer.expression === undefined) return 'object';
  let expression = style.initializer.expression;
  while (ts.isParenthesizedExpression(expression)) expression = expression.expression;
  if (ts.isArrowFunction(expression) || ts.isFunctionExpression(expression)) return 'function';
  if (ts.isArrayLiteralExpression(expression)) return 'array';
  return 'object';
}

/** Every element with `asChild`, and the kind of style its one child element is given. */
function asChildSites(file: string, text: string): Site[] {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const sites: Site[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isJsxElement(node) && attribute(node.openingElement.attributes, 'asChild') !== undefined) {
      const child = node.children.find((candidate) => ts.isJsxElement(candidate) || ts.isJsxSelfClosingElement(candidate));
      const opening = child === undefined ? undefined : ts.isJsxElement(child) ? child.openingElement : child;
      const line = source.getLineAndCharacterOfPosition(node.getStart()).line + 1;
      sites.push({ where: `${file}:${String(line)}`, style: opening === undefined ? 'none' : kindOf(attribute(opening.attributes, 'style')) });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return sites;
}

const files = [...sources('app'), ...sources('src')];
const sites = files.flatMap((file) => asChildSites(file, readFileSync(join(root, file), 'utf8')));

test('the scan reads the code and tells the style kinds apart', () => {
  const sample = [
    '<Link href="/a" asChild><Pressable style={(state) => [styles.tab]} /></Link>;',
    '<Link href="/b" asChild>{/* note */}<Pressable style={[styles.tab, styles.on]}><Text>B</Text></Pressable></Link>;',
    '<Link href="/c" asChild><Pressable style={StyleSheet.flatten([styles.tab])} /></Link>;',
    '<Link href="/d" asChild><Pressable style={styles.tab} /></Link>;',
  ].join('\n');
  expect(asChildSites('sample.tsx', sample).map((site) => site.style)).toEqual(['function', 'array', 'object', 'object']);
  // The links the portal's shared pieces draw: LinkButton, the location tabs, the top bar's nav, the console's
  // status filters and its row names.
  expect(sites.length).toBeGreaterThanOrEqual(5);
  for (const file of ['src/portal/ui/Button.tsx', 'src/portal/shell/LocationShell.tsx', 'src/portal/console/parts.tsx']) {
    expect(sites.some((site) => site.where.startsWith(`${file}:`))).toBe(true);
  }
});

test('no child of Link asChild is given a function or an array style', () => {
  expect(sites.filter((site) => site.style === 'function' || site.style === 'array')).toEqual([]);
});
