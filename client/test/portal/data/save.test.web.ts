import '../../viewer/setup';

import { ApiError } from '../../../src/api/client';
import { replaceStored, saveAsCopy, saveInPlace, type SaveResult } from '../../../src/portal/data/item/save';
import { offline, refusal } from '../../helpers/portal';
import { locationsFake } from '../locations/fakes';
import { hexId, hexUploads, sent } from './editFakes';
import { dataFake, itemOf, type DataFake } from './fakes';

// Saving an edit (save.ts): the bytes go up as a new reference file through the upload queue, then take the item's
// place (text and CSV) or stay a copy beside it (a workbook). Each way it can end is a value, never a throw.

const REF = `f_${hexId(1)}`;
const TARGET = { locationId: 'l1', ref: REF, name: 'notes.txt' };
const BYTES = new TextEncoder().encode('Closed Mondays.');

function setup(): DataFake {
  const fake = dataFake({ inner: locationsFake(), items: [itemOf(REF, { name: 'notes.txt', state: 'kept', outcome: 'reference', canEdit: true })] });
  hexUploads(fake);
  return fake;
}

function creates(fake: DataFake): unknown[] {
  return fake.files.calls.filter((call) => call.method === 'POST' && call.path === '/files').map((call) => call.body);
}

test('in place: stores the bytes under the item’s name for reference, then replaces the item with that file', async () => {
  const fake = setup();
  const saving = saveInPlace(fake, TARGET, BYTES);
  const { fileId, bytes } = await sent(fake);
  await expect(saving).resolves.toEqual<SaveResult>({ at: 'saved', ref: `f_${fileId}` });
  expect(Array.from(bytes)).toEqual(Array.from(BYTES));
  expect(creates(fake)).toEqual([{ name: 'notes.txt', sizeBytes: BYTES.length, purpose: 'reference' }]);
  expect(fake.files.calls.some((call) => call.method === 'POST' && call.path === `/files/${fileId}/complete`)).toBe(true);
  expect(fake.replaces).toEqual([{ ref: REF, body: { fileId } }]);
});

test('a refused upload stores nothing and replaces nothing', async () => {
  const fake = setup();
  fake.files.answers['POST /files'] = () => refusal(409, 'daily_upload_limit');
  await expect(saveInPlace(fake, TARGET, BYTES)).resolves.toEqual<SaveResult>({ at: 'not_stored', code: 'daily_upload_limit', detail: null });
  expect(fake.files.puts).toEqual([]);
  expect(fake.replaces).toEqual([]);
});

test('bytes equal to a live file are refused at complete, with the file they match', async () => {
  const fake = setup();
  fake.files.answers[`POST /files/${hexId(0xed1)}/complete`] = () => new ApiError('http', 'You already added this file', {
    status: 409, code: 'file_duplicate', detail: { fileId: hexId(7) },
  });
  const saving = saveInPlace(fake, TARGET, BYTES);
  await sent(fake);
  await expect(saving).resolves.toEqual<SaveResult>({ at: 'not_stored', code: 'file_duplicate', detail: { fileId: hexId(7) } });
  expect(fake.replaces).toEqual([]);
});

test('a replace that fails leaves the stored file to replace again with the same id', async () => {
  const fake = setup();
  const failure = offline();
  fake.answers['POST replace'] = () => failure;
  const saving = saveInPlace(fake, TARGET, BYTES);
  const { fileId } = await sent(fake);
  await expect(saving).resolves.toEqual<SaveResult>({ at: 'not_replaced', fileId, error: failure });
  delete fake.answers['POST replace'];
  await expect(replaceStored(fake, TARGET, fileId)).resolves.toEqual<SaveResult>({ at: 'saved', ref: `f_${fileId}` });
  expect(fake.replaces).toEqual([{ ref: REF, body: { fileId } }, { ref: REF, body: { fileId } }]);
  expect(creates(fake)).toHaveLength(1);
});

test('as a copy: stored as “<name> (edited).xlsx”, and the original is not replaced', async () => {
  const fake = setup();
  const saving = saveAsCopy(fake, { ...TARGET, name: 'Hours.XLSX' }, BYTES);
  const { fileId } = await sent(fake);
  await expect(saving).resolves.toEqual<SaveResult>({ at: 'saved', ref: `f_${fileId}` });
  expect(creates(fake)).toEqual([{ name: 'Hours (edited).xlsx', sizeBytes: BYTES.length, purpose: 'reference' }]);
  expect(fake.replaces).toEqual([]);
});
