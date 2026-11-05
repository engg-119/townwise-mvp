import { Children } from 'react';
import { Link } from 'expo-router';
import { StyleSheet, Text, View } from 'react-native';

import { theme } from '../theme';

// The text pages are written once with these HTML-named components. On web (html.web.tsx) each is
// the DOM element the mockups use, classes included. Here, on native, the same markup is plain
// text: a block that holds text directly is a Text, any other block a View, inline elements nest
// as Text, and in-page navigation (the "On this page" lists) is left out. Colors follow the web
// pages: secondary text, white headings, strong text and links, on the app's dark ground.

export interface TagProps {
  children?: React.ReactNode;
  className?: string;
  id?: string;
  tabIndex?: number;
  role?: 'region';
  scope?: 'col' | 'row';
  'aria-label'?: string;
  'aria-labelledby'?: string;
  'data-l'?: string;
}

export interface AnchorProps extends TagProps { href: string }

function holdsText(children: React.ReactNode): boolean {
  return Children.toArray(children).some((child) => typeof child === 'string' || typeof child === 'number');
}

function Block(props: TagProps): React.JSX.Element {
  if (holdsText(props.children)) return <Text style={styles.text}>{props.children}</Text>;
  return <View style={styles.block}>{props.children}</View>;
}

function Heading(props: TagProps): React.JSX.Element {
  return <Text role="heading" style={[styles.strong, styles.white]}>{props.children}</Text>;
}

function Inline(props: TagProps): React.JSX.Element {
  return <Text style={styles.text}>{props.children}</Text>;
}

export function Strong(props: TagProps): React.JSX.Element {
  return <Text style={[styles.strong, styles.white]}>{props.children}</Text>;
}

export function A(props: AnchorProps): React.JSX.Element {
  return <Link href={props.href} style={styles.link}>{props.children}</Link>;
}

export const Nav: (props: TagProps) => null = () => null;

export {
  Block as Div, Block as Section, Block as P, Block as Ul, Block as Ol, Block as Li,
  Block as Table, Block as Thead, Block as Tbody, Block as Tr, Block as Th, Block as Td,
  Heading as H1, Heading as H2, Inline as Span, Inline as Code,
};

const styles = StyleSheet.create({
  block: { gap: 8 },
  strong: { fontWeight: '600' },
  text: { color: theme.color.text2 },
  white: { color: theme.color.white },
  link: { color: theme.color.white, textDecorationLine: 'underline', textDecorationColor: theme.color.line },
});
