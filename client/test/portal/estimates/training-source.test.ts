import { forecastRunSchema } from '../../../src/portal/estimates/api';
import { runLines } from '../../../src/portal/estimates/ModelCard';

// A forecast run's training source reads in words, and a source this client doesn’t know yet reads as plain sales
// history instead of failing the model card. Synthetic data only.

function runWith(trainingSource: string) {
  return forecastRunSchema.parse({
    id: 'r1', metric: 'guests', model: { family: 'hybrid_linear_xgboost', version: 'v3', label: 'Townwise demand model v3' },
    trainingSource, trainedFrom: '2025-01-01', dataThrough: '2026-10-21', madeAt: '2026-11-01', frozen: false,
    interval: { level: 0.8, widened: false }, backtest: null,
  });
}

test('the two known sources read in their own words', () => {
  expect(runLines(runWith('files_from_owner'))[0]).toContain('trained on sales exports you sent Townwise from');
  expect(runLines(runWith('townwise_lab'))[0]).toContain('trained on sales history and notes you uploaded to Townwise from');
});

test('an unknown training source reads as sales history', () => {
  expect(runLines(runWith('something_new'))[0]).toContain('trained on sales history from');
});

test.each(['constructor', 'toString', '__proto__'])('a source named like an Object key (%s) reads as sales history', (source) => {
  expect(runLines(runWith(source))[0]).toContain('trained on sales history from');
});
