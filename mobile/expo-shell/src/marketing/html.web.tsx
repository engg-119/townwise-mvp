import { createElement } from 'react';

import type { AnchorProps, TagProps } from './html';

// Web: each component is the DOM element of the same name, with its classes and attributes, so
// the text pages render the mockups' markup. Internal links are routed by MarketingShell.web.

function tag(name: string): (props: TagProps) => React.JSX.Element {
  return function Tag(props: TagProps): React.JSX.Element {
    return createElement(name, props);
  };
}

export const Div = tag('div');
export const Section = tag('section');
export const Nav = tag('nav');
export const P = tag('p');
export const H1 = tag('h1');
export const H2 = tag('h2');
export const Ul = tag('ul');
export const Ol = tag('ol');
export const Li = tag('li');
export const Table = tag('table');
export const Thead = tag('thead');
export const Tbody = tag('tbody');
export const Tr = tag('tr');
export const Th = tag('th');
export const Td = tag('td');
export const Span = tag('span');
export const Code = tag('code');
export const Strong = tag('strong');

export function A(props: AnchorProps): React.JSX.Element {
  return createElement('a', props);
}
