// A research thread's source ledger (D66 design decision 5, task 1.3): sources from search results, fetch results and
// citations across messages (paused ones included), https only, without fragments, each URL once with ids S1..Sn; a
// fetched page's char_location citation mapped to its page by document_index; nested callers and failed results add
// nothing. Synthetic pages only.
import type { BetaContentBlock, BetaTextCitation } from '@anthropic-ai/sdk/resources/beta/messages/messages';
import { describe, expect, it } from 'vitest';

import { buildLedger, normalizeUrl } from '../src/research/ledger.ts';
import {
  citedQuotes, docCited, fetchError, fetchResult, message, pause, text, webError, webFetch, webResults, webSearch,
} from './helpers/chat-model.ts';

const FAIR = 'https://www.example.com/fair/2026';
const ROAD = 'https://news.example.org/road-closure';
const MARKET = 'https://market.example.net/schedule';

describe('normalizeUrl', () => {
  it('keeps https without its fragment and refuses anything else', () => {
    expect(normalizeUrl('https://Example.com/a#top')).toBe('https://example.com/a');
    expect(normalizeUrl('http://example.com/a')).toBeNull();
    expect(normalizeUrl('javascript:alert(1)')).toBeNull();
    expect(normalizeUrl('not a url')).toBeNull();
  });
});

describe('buildLedger', () => {
  it('numbers each distinct https URL once across paused messages, dropping http and fragments', () => {
    const ledger = buildLedger([
      pause([webSearch('s1'), webResults('s1', [FAIR, 'http://insecure.example.net/page', `${FAIR}#parking`])]),
      pause([webSearch('s2'), webResults('s2', [ROAD, FAIR])]),
      message([citedQuotes('EVENT: the fair.', [{ url: `${FAIR}#dates`, quote: 'Fair on May 16' }]), text('done')]),
    ]);
    expect(ledger.sources.map((source) => [source.id, source.url, source.host])).toEqual([
      ['S1', FAIR, 'example.com'],
      ['S2', ROAD, 'news.example.org'],
    ]);
    expect(ledger.byId('S1')).toMatchObject({ title: 'Sentinel-title 1', pageAge: '3 days ago', quotes: ['Fair on May 16'], fetchedText: null });
    expect(ledger.byId('S3')).toBeUndefined();
  });

  it('adds a URL a citation names even when no result listed it', () => {
    const ledger = buildLedger([message([citedQuotes('EVENT: market.', [{ url: MARKET, quote: 'Wednesdays 3 to 6 pm' }])])]);
    expect(ledger.sources).toHaveLength(1);
    expect(ledger.byId('S1')).toMatchObject({ url: MARKET, quotes: ['Wednesdays 3 to 6 pm'] });
  });

  it('maps a fetched page\'s char_location citation to its page by document_index', () => {
    const ledger = buildLedger([
      pause([webSearch('s1'), webResults('s1', [FAIR, ROAD]), webFetch('f1', ROAD), fetchResult('f1', ROAD, 'Main Street closed June 1 to June 5.')]),
      message([
        webFetch('f2', MARKET), fetchResult('f2', MARKET, 'The market runs Wednesdays.'),
        docCited('EVENT: road work.', [{ documentIndex: 0, quote: 'Main Street closed June 1 to June 5.' }]),
        docCited('EVENT: market.', [{ documentIndex: 1, quote: 'The market runs Wednesdays.' }]),
        docCited('EVENT: nothing.', [{ documentIndex: 7, quote: 'out of range' }]),
      ]),
    ]);
    expect(ledger.sources.map((source) => source.url)).toEqual([FAIR, ROAD, MARKET]);
    expect(ledger.byId('S2')).toMatchObject({ fetchedText: 'Main Street closed June 1 to June 5.', quotes: ['Main Street closed June 1 to June 5.'] });
    expect(ledger.byId('S3')).toMatchObject({ fetchedText: 'The market runs Wednesdays.', quotes: ['The market runs Wednesdays.'] });
    const charAt = (index: number): BetaTextCitation => ({
      type: 'char_location', cited_text: 'x', document_index: index, document_title: null, start_char_index: 0, end_char_index: 1, file_id: null,
    });
    expect(ledger.idOfCitation(charAt(1))).toBe('S3');
    expect(ledger.idOfCitation(charAt(7))).toBeNull();
  });

  it('keeps an http fetch\'s document slot so later indexes still point at their own pages', () => {
    const ledger = buildLedger([message([
      fetchResult('f1', 'http://insecure.example.net/page', 'plain'),
      fetchResult('f2', ROAD, 'Main Street closed June 1.'),
      docCited('EVENT: road.', [{ documentIndex: 1, quote: 'Main Street closed June 1.' }, { documentIndex: 0, quote: 'plain' }]),
    ])]);
    expect(ledger.sources.map((source) => [source.id, source.url, source.quotes])).toEqual([['S1', ROAD, ['Main Street closed June 1.']]]);
  });

  it('ignores results another caller made, and failed searches and fetches', () => {
    const nested = { ...webResults('s1', [FAIR]), caller: { type: 'code_execution_20250825', tool_id: 'c1' } } as BetaContentBlock;
    const nestedFetch = { ...fetchResult('f1', ROAD, 'text'), caller: { type: 'code_execution_20250825', tool_id: 'c1' } } as BetaContentBlock;
    const ledger = buildLedger([message([nested, nestedFetch, webError('s2'), fetchError('f2'), text('nothing found')])]);
    expect(ledger.sources).toEqual([]);
  });

  it('answers the id of a search citation by its normalized URL', () => {
    const ledger = buildLedger([message([webResults('s1', [FAIR, ROAD])])]);
    const at = (url: string): BetaTextCitation => ({ type: 'web_search_result_location', cited_text: 'x', url, title: null, encrypted_index: 'i' });
    expect(ledger.idOfCitation(at(`${ROAD}#x`))).toBe('S2');
    expect(ledger.idOfCitation(at('http://news.example.org/road-closure'))).toBeNull();
  });
});
