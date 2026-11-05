import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as ts from 'typescript';

// expo-router's <Link asChild> merges its child's `style` as `{ ...linkStyle, ...childStyle }`: a function style is
// dropped and an array throws in development (src/portal/ui/hover.ts). The location tabs, LinkButton and the
// console's status filters once lost every style that way, at every width. This keeps each child's style a plain
// object, with hover tracked in state. It is an allowlist: the one child element must be written in place, and its
// style must be an object literal, a `styles.x` member or `StyleSheet.flatten(...)`. Anything the scan cannot see
// is a plain object (a variable, a helper call, a conditional child, a spread after the style) fails.

const root = join(__dirname, '../..');

function sources(dir: string): string[] {
  return readdirSync(join(root, dir), { recursive: true, encoding: 'utf8' })
    .filter((file) => file.endsWith('.tsx'))
    .map((file) => join(dir, file));
}

interface Site {
  where: string;
  /** Why the child's style is not known to be a plain object, or null when it is. */
  problem: string | null;
}

function attribute(attributes: ts.JsxAttributes, name: string): ts.JsxAttribute | undefined {
  return attributes.properties.find((property): property is ts.JsxAttribute => ts.isJsxAttribute(property) && property.name.getText() === name);
}

function unwrap(expression: ts.Expression): ts.Expression {
  let inner = expression;
  while (ts.isParenthesizedExpression(inner)) inner = inner.expression;
  return inner;
}

/** A style expression on the allowlist; an object literal's spreads must be on it too. */
function plainStyle(expression: ts.Expression): boolean {
  const inner = unwrap(expression);
  if (ts.isObjectLiteralExpression(inner)) {
    return inner.properties.every((property) => !ts.isSpreadAssignment(property) || plainStyle(property.expression));
  }
  if (ts.isPropertyAccessExpression(inner)) return ts.isIdentifier(inner.expression) && inner.expression.text === 'styles';
  if (ts.isCallExpression(inner)) {
    const callee = inner.expression;
    return ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression) && callee.expression.text === 'StyleSheet'
      && callee.name.text === 'flatten';
  }
  return false;
}

/** The one child element of an asChild element, or why there is not exactly one written in place. */
function onlyChild(node: ts.JsxElement): ts.JsxOpeningLikeElement | string {
  const children = node.children.filter((child) => !(ts.isJsxText(child) && child.containsOnlyTriviaWhiteSpaces)
    && !(ts.isJsxExpression(child) && child.expression === undefined));
  if (children.length !== 1) return `${String(children.length)} children`;
  const [child] = children as [ts.JsxChild];
  if (ts.isJsxElement(child)) return child.openingElement;
  if (ts.isJsxSelfClosingElement(child)) return child;
  return 'a child that is not an element written in place';
}

function problemOf(child: ts.JsxOpeningLikeElement): string | null {
  const properties = child.attributes.properties;
  const styleAt = properties.findIndex((property) => ts.isJsxAttribute(property) && property.name.getText() === 'style');
  // A spread after the style (or with no style at all) can replace it with anything.
  if (properties.some((property, index) => ts.isJsxSpreadAttribute(property) && index > styleAt)) return 'a spread that can set the style';
  if (styleAt < 0) return null;
  const style = properties[styleAt] as ts.JsxAttribute;
  const initializer = style.initializer;
  if (initializer === undefined || !ts.isJsxExpression(initializer) || initializer.expression === undefined) return 'a style that is not an expression';
  return plainStyle(initializer.expression) ? null : `style={${initializer.expression.getText()}}`;
}

/** Every element with `asChild`, and what is wrong with its child's style, if anything. */
function asChildSites(file: string, text: string): Site[] {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const sites: Site[] = [];
  const visit = (node: ts.Node): void => {
    const where = (): string => `${file}:${String(source.getLineAndCharacterOfPosition(node.getStart()).line + 1)}`;
    if (ts.isJsxElement(node) && attribute(node.openingElement.attributes, 'asChild') !== undefined) {
      const child = onlyChild(node);
      sites.push({ where: where(), problem: typeof child === 'string' ? child : problemOf(child) });
    } else if (ts.isJsxSelfClosingElement(node) && attribute(node.attributes, 'asChild') !== undefined) {
      sites.push({ where: where(), problem: 'no child written in place' });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return sites;
}

const files = [...sources('app'), ...sources('src')];
const sites = files.flatMap((file) => asChildSites(file, readFileSync(join(root, file), 'utf8')));

test('the scan reads the code: it passes only the allowlist and fails everything it cannot see is a plain object', () => {
  const allowed = [
    '<Link href="/a" asChild><Pressable style={{ minHeight: 44 }} /></Link>;',
    '<Link href="/b" asChild>{/* note */}<Pressable style={styles.tab}><Text>B</Text></Pressable></Link>;',
    '<Link href="/c" asChild><Pressable style={StyleSheet.flatten([styles.tab, on ? styles.on : null])} /></Link>;',
    '<Link href="/d" asChild><Pressable {...webAria({ "aria-current": "page" })} style={(styles.tab)} /></Link>;',
    '<Link href="/e" asChild><Pressable style={{ ...styles.tab, ...StyleSheet.flatten(extra) }} /></Link>;',
    '<Link href="/f" asChild><Pressable role="link" /></Link>;',
  ].join('\n');
  expect(asChildSites('allowed.tsx', allowed).map((site) => site.problem)).toEqual([null, null, null, null, null, null]);

  const refused = [
    '<Link href="/a" asChild><Pressable style={(state) => [styles.tab]} /></Link>;',
    '<Link href="/b" asChild><Pressable style={[styles.tab, styles.on]} /></Link>;',
    '<Link href="/c" asChild><Pressable style={tabStyle} /></Link>;',
    '<Link href="/d" asChild><Pressable style={boxStyle(variant, hovered)} /></Link>;',
    '<Link href="/e" asChild><Pressable style={styles.tab} {...rest} /></Link>;',
    '<Link href="/f" asChild><Pressable {...rest} /></Link>;',
    '<Link href="/g" asChild>{current ? <Pressable style={(state) => [styles.tab]} /> : null}</Link>;',
    '<Link href="/h" asChild>{child}</Link>;',
    '<Link href="/i" asChild><Pressable style={{ ...tabStyle }} /></Link>;',
    '<Link href="/j" asChild><Pressable style={current ? styles.on : styles.tab} /></Link>;',
    '<Link href="/k" asChild><Pressable style={theme.tab} /></Link>;',
    '<Link href="/l" asChild><Pressable style={styles.tab} /><Text>two</Text></Link>;',
    '<Link href="/m" asChild children={child} />;',
  ].join('\n');
  const problems = asChildSites('refused.tsx', refused).map((site) => site.problem);
  expect(problems).toHaveLength(13);
  expect(problems.filter((problem) => problem === null)).toEqual([]);

  // The links the portal's shared pieces draw: LinkButton, the location tabs, the top bar's nav, the console's
  // status filters and its row names.
  expect(sites.length).toBeGreaterThanOrEqual(5);
  for (const file of ['src/portal/ui/Button.tsx', 'src/portal/shell/LocationShell.tsx', 'src/portal/console/parts.tsx', 'src/portal/shell/TopBar.tsx']) {
    expect(sites.some((site) => site.where.startsWith(`${file}:`))).toBe(true);
  }
});

test('every child of Link asChild is given a style the scan can see is a plain object', () => {
  expect(sites.filter((site) => site.problem !== null)).toEqual([]);
});
