import { describe, expect, it } from 'vitest';

import { cleanCsv } from '../../src/files/clean.ts';

describe('cleaned copy (spec 11A)', () => {
  it('is exactly the days written: date, guests, net sales in dollars, empty for none', () => {
    expect(cleanCsv([
      { date: '2025-01-01', guests: 120, netSalesCents: 345_605 },
      { date: '2025-01-02', guests: null, netSalesCents: 7 },
      { date: '2025-01-03', guests: 0, netSalesCents: null },
    ])).toBe('date,guests,net_sales\r\n2025-01-01,120,3456.05\r\n2025-01-02,,0.07\r\n2025-01-03,0,\r\n');
    expect(cleanCsv([])).toBe('date,guests,net_sales\r\n');
  });
});
