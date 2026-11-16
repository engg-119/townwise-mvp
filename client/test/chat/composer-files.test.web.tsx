import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useImperativeHandle, useRef } from 'react';

import { chipWords, kindOfFile } from '../../src/chat/attachments';
import { ATTACHED_PLACEHOLDER, Composer, COMPOSER_LABEL, type ComposerHandle } from '../../src/chat/ui/Composer';
import type { ComposerFiles } from '../../src/chat/ui/ComposerFiles';
import {
  ATTACH_FILES, chipLine, chipOf, REMOVED_LINE, useComposerFiles, WAIT_ID, WAIT_LINE,
} from '../../src/chat/ui/ComposerFiles.web';
import { ApiError } from '../../src/api/client';
import type { QueuedUpload } from '../../src/portal/files/uploadQueue';
import { ACCESS, meOf, refusal } from '../helpers/portal';
import { fileViewOf, filesFake, type FilesFake } from '../portal/files/fakes';
import { portalWrapper } from '../portal/files/harness';

// The composer's files on web (spec P25, D36): the + (Attach files) opens the picker; each file is a chip that
// uploads to Your data as a reference file with its percent, then is ready (or failed); the x takes it off the message
// and stops an upload still running, while a finished file stays on Your data; at most 5 a message; Send takes the
// ready ones and a turn taken back gives them back; each conversation keeps its own chips. The words for each kind.

function upload(state: QueuedUpload['state'], extra: Partial<QueuedUpload> = {}): QueuedUpload {
  return {
    key: 'u1', fileId: 'f1', name: 'winter-hours.txt', sizeBytes: 200, state, sentBytes: 0, bytesPerSecond: null, secondsLeft: null,
    error: null, file: null, ...extra,
  };
}

test('a chip is uploading with its percent, then ready with its kind, or failed', () => {
  expect(chipOf(upload('waiting'))).toMatchObject({ state: 'uploading', percent: 0, kind: 'text' });
  const sending = chipOf(upload('sending', { sentBytes: 85 }));
  expect(sending).toMatchObject({ state: 'uploading', percent: 42 });
  expect(chipLine(sending)).toBe('Uploading 42%');
  // Every byte sent but not yet kept on Your data: still uploading.
  expect(chipOf(upload('completing', { sentBytes: 200 })).percent).toBe(99);
  const ready = chipOf(upload('done', { file: fileViewOf('f1', { kind: 'text' }) }));
  expect(ready).toMatchObject({ state: 'ready', percent: 100, fileId: 'f1' });
  expect(chipLine(ready)).toBe('Text file');
  expect(chipLine(chipOf(upload('refused')))).toBe('Couldn’t add it');
  expect(chipOf(upload('failed')).state).toBe('failed');
});

test('a file Your data already has is ready, as the copy the server kept (409 file_duplicate)', () => {
  const duplicate = upload('refused', { error: { code: 'file_duplicate', detail: { fileId: '0123456789abcdef01234567' } } });
  expect(chipOf(duplicate)).toMatchObject({ state: 'ready', percent: 100, fileId: '0123456789abcdef01234567', kind: 'text' });
  expect(chipLine(chipOf(duplicate))).toBe('Text file');
  // Without the kept copy's id it is a refusal like any other.
  expect(chipOf(upload('refused', { error: { code: 'file_duplicate' } })).state).toBe('failed');
  expect(chipOf(upload('refused', { error: { code: 'storage_full', detail: { fileId: 'x' } } })).state).toBe('failed');
});

test('a PDF, Word or Excel file shows its kind; a kind TownwiseAI can’t read still attaches, and its chip says so', () => {
  const pdf = chipOf(upload('done', { name: 'menu.pdf', file: fileViewOf('f1', { kind: 'pdf' }) }));
  expect(chipLine(pdf)).toBe('PDF');
  expect(chipLine(chipOf(upload('done', { name: 'hours.docx', file: fileViewOf('f1', { kind: 'docx' }) })))).toBe('Word file');
  expect(chipLine(chipOf(upload('done', { name: 'book.xlsx', file: fileViewOf('f1', { kind: 'xlsx' }) })))).toBe('Excel file');
  expect(chipLine(chipOf(upload('done', { name: 'old.doc', file: fileViewOf('f1', { kind: 'doc' }) })))).toBe('TownwiseAI can’t read .doc files; save it as .docx');
  expect(chipLine(chipOf(upload('done', { name: 'old.xls', file: fileViewOf('f1', { kind: 'xls' }) })))).toBe('TownwiseAI can’t read .xls files; save it as .xlsx');
  expect(chipLine(chipOf(upload('done', { name: 'week.zip', file: fileViewOf('f1', { kind: 'zip' }) })))).toBe('TownwiseAI can’t read ZIP files yet');
  expect(chipLine(chipOf(upload('done', { name: 'photo.heic', file: fileViewOf('f1', { kind: 'other' }) })))).toBe('TownwiseAI can’t read this kind of file yet');
  expect(chipLine(chipOf(upload('done', { name: 'patio.png', file: fileViewOf('f1', { kind: 'other' }) })))).toBe('Picture');
});

test('a file’s kind: the stored kind once uploaded, else its name; a picture by its name', () => {
  expect(kindOfFile('sales.csv', null)).toBe('text');
  expect(kindOfFile('NOTES', null)).toBe('text');
  expect(kindOfFile('menu.PDF', null)).toBe('pdf');
  expect(kindOfFile('book.xlsx', null)).toBe('excel');
  expect(kindOfFile('patio.JPG', null)).toBe('picture');
  expect(kindOfFile('archive.zip', null)).toBe('zip');
  expect(kindOfFile('photo.heic', null)).toBe('file');
  // The server read a .csv's bytes as something else: its word wins.
  expect(kindOfFile('odd.csv', 'other')).toBe('file');
  expect(kindOfFile('patio.png', 'other')).toBe('picture');
  expect(kindOfFile('old.doc', 'doc')).toBe('word');
});

test('a bubble chip names the file and its kind, or the kind alone without a name, and says when it is off or gone', () => {
  const ref = 'f_0123456789abcdef01234567';
  expect(chipWords({ ref, kind: 'pdf', name: 'menu.pdf', state: 'on' })).toEqual({ title: 'menu.pdf', line: 'PDF' });
  expect(chipWords({ ref, kind: 'picture', name: null, state: 'on' })).toEqual({ title: 'Picture', line: null });
  expect(chipWords({ ref, kind: 'text', name: 'hours.txt', state: 'off' })).toEqual({ title: 'hours.txt', line: 'Text file. Turned off on Your data' });
  expect(chipWords({ ref, kind: 'file', name: null, state: 'gone' })).toEqual({ title: 'File', line: 'No longer on Your data' });
});

describe('in the composer', () => {
  let fake: FilesFake;

  beforeEach(() => {
    fake = filesFake({ chunkSize: 1024 });
    fake.lists[''] = [];
  });

  afterEach(cleanup);

  function Harness(props: { handle: React.Ref<ComposerFiles> }): React.JSX.Element {
    const composer = useRef<ComposerHandle>(null);
    const files = useComposerFiles('l1', null, () => { composer.current?.focus(); });
    useImperativeHandle(props.handle, () => files);
    return (
      <Composer
        focusRef={composer}
        draft=""
        onChange={() => undefined}
        streaming={false}
        canSend={!files.uploading}
        onSend={() => undefined}
        onStop={() => undefined}
        onStopAndSend={() => undefined}
        help="Leave out guest names."
        examples={[]}
        readOnlyId={null}
        placement="dock"
        attached={files.count > 0}
        sendDescribedBy={files.waitId}
        {...(files.button === null ? {} : { leading: files.button })}
        {...(files.chips === null ? {} : { attachments: files.chips })}
      />
    );
  }

  async function mount(): Promise<{ current: ComposerFiles | null }> {
    const handle: { current: ComposerFiles | null } = { current: null };
    render(<Harness handle={handle} />, { wrapper: portalWrapper(fake, meOf(ACCESS.member)) });
    await screen.findByRole('button', { name: ATTACH_FILES });
    return handle;
  }

  function pick(...files: File[]): void {
    const picker = document.querySelector<HTMLInputElement>('[data-testid="composer-files"]');
    if (picker === null) throw new Error('no file picker');
    fireEvent.change(picker, { target: { files } });
  }

  function file(name: string, size = 200): File {
    return new File(['x'.repeat(size)], name);
  }

  function chips(): HTMLElement[] {
    return within(screen.getByRole('list', { name: 'Files attached to your message' })).getAllByRole('listitem');
  }

  test('the + is named Attach files and opens the file picker', async () => {
    await mount();
    const click = jest.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(() => undefined);
    try {
      fireEvent.click(screen.getByRole('button', { name: ATTACH_FILES }));
      expect(click).toHaveBeenCalledTimes(1);
    } finally {
      click.mockRestore();
    }
  });

  test('a picked file uploads as a reference file, its chip showing the percent, then ready; Send waits meanwhile', async () => {
    await mount();
    const field = screen.getByLabelText(COMPOSER_LABEL);
    act(() => { field.focus(); });
    pick(file('winter-hours.txt'));
    await waitFor(() => { expect(fake.puts).toHaveLength(1); });
    expect(fake.calls.find((call) => call.method === 'POST' && call.path === '/files')?.body).toMatchObject({ purpose: 'reference', name: 'winter-hours.txt' });
    // The chip is the first row inside the box; the same field kept its place and its focus.
    expect(screen.getByLabelText(COMPOSER_LABEL)).toBe(field);
    expect(document.activeElement).toBe(field);
    expect(field.getAttribute('placeholder')).toBe(ATTACHED_PLACEHOLDER);
    act(() => { fake.puts[0]?.progress(84); });
    expect(within(first(chips())).getByText('winter-hours.txt')).toBeTruthy();
    expect(within(first(chips())).getByText('Uploading 42%')).toBeTruthy();
    // Send waits, and says why.
    const send = screen.getByRole('button', { name: 'Send' });
    expect(send.getAttribute('aria-disabled')).toBe('true');
    expect(send.getAttribute('aria-describedby')).toBe(WAIT_ID);
    expect(document.getElementById(WAIT_ID)?.textContent).toBe(WAIT_LINE);
    await act(async () => {
      fake.puts[0]?.ok();
      await new Promise((resolve) => { setTimeout(resolve, 0); });
    });
    await waitFor(() => { expect(within(first(chips())).getByText('Text file')).toBeTruthy(); });
    expect(screen.getByRole('button', { name: 'Send' }).getAttribute('aria-describedby')).toBeNull();
    expect(document.getElementById(WAIT_ID)).toBeNull();
  });

  test('the x stops an upload still running, and the server deletes what it has', async () => {
    await mount();
    pick(file('menu.pdf'));
    await waitFor(() => { expect(fake.puts).toHaveLength(1); });
    fireEvent.click(screen.getByRole('button', { name: 'Remove menu.pdf from this message' }));
    expect(fake.puts[0]?.signal?.aborted).toBe(true);
    await waitFor(() => { expect(fake.calls.some((call) => call.method === 'DELETE' && call.path === '/files/f1')).toBe(true); });
    expect(screen.queryByRole('list', { name: 'Files attached to your message' })).toBeNull();
    // Nothing had finished, so there is nothing to keep on Your data.
    expect(screen.queryByText(REMOVED_LINE)).toBeNull();
    expect(screen.getByLabelText(COMPOSER_LABEL).getAttribute('placeholder')).not.toBe(ATTACHED_PLACEHOLDER);
  });

  test('the x on a finished file takes it off the message and says once that it stays on Your data; focus goes to the field', async () => {
    const files = await mount();
    pick(file('a.txt'), file('b.txt'));
    await waitFor(() => { expect(fake.puts).toHaveLength(2); });
    await act(async () => {
      for (const put of fake.puts) put.ok();
      await new Promise((resolve) => { setTimeout(resolve, 0); });
    });
    await waitFor(() => { expect(screen.getAllByText('Text file')).toHaveLength(2); });
    const remove = screen.getByRole('button', { name: 'Remove a.txt from this message' });
    act(() => { remove.focus(); });
    fireEvent.click(remove);
    expect(chips()).toHaveLength(1);
    expect(screen.getAllByText(REMOVED_LINE)).toHaveLength(1);
    expect(document.activeElement).toBe(screen.getByLabelText(COMPOSER_LABEL));
    fireEvent.click(screen.getByRole('button', { name: 'Remove b.txt from this message' }));
    // Said once, and still said with no chip left.
    expect(screen.getAllByText(REMOVED_LINE)).toHaveLength(1);
    expect(fake.calls.filter((call) => call.method === 'DELETE')).toEqual([]);
    expect(files.current?.news.map((line) => line.text)).toContain('Removed b.txt from this message. It stays on Your data.');
  });

  test('a message carries at most 5 files; the rest are not uploaded, and an alert says so', async () => {
    const files = await mount();
    pick(...['1', '2', '3', '4', '5', '6', '7'].map((name) => file(`${name}.txt`)));
    await waitFor(() => { expect(chips()).toHaveLength(5); });
    expect(fake.calls.filter((call) => call.method === 'POST' && call.path === '/files').length).toBeLessThanOrEqual(5);
    expect(files.current?.alerts.map((line) => line.text)).toEqual(['A message can carry 5 files, so 2 weren’t added.']);
  });

  test('Send takes the ready files as attachments and drops a failed one; a turn taken back gives them back', async () => {
    fake.answers['POST /files'] = (body) => ((body as { name: string }).name === 'big.txt' ? refusal(413, 'file_too_large') : undefined);
    const files = await mount();
    pick(file('hours.txt'), file('big.txt'));
    await waitFor(() => { expect(fake.puts).toHaveLength(1); });
    await act(async () => {
      fake.puts[0]?.ok();
      await new Promise((resolve) => { setTimeout(resolve, 0); });
    });
    await waitFor(() => { expect(screen.getByText('Couldn’t add it')).toBeTruthy(); });
    expect(files.current?.alerts).toHaveLength(1);
    let taken: ReturnType<ComposerFiles['take']> | undefined;
    act(() => { taken = files.current?.take(); });
    expect(taken?.attachments).toEqual([{ ref: 'f_f1', kind: 'text', name: 'hours.txt', state: 'on' }]);
    expect(screen.queryByRole('list', { name: 'Files attached to your message' })).toBeNull();
    expect(files.current?.alerts).toEqual([]);
    act(() => { taken?.restore(); });
    expect(chips()).toHaveLength(1);
    expect(screen.getByText('hours.txt')).toBeTruthy();
  });

  test('a file already on Your data attaches the copy kept there, with no alert, and its x deletes nothing', async () => {
    const KEPT = '0123456789abcdef01234567';
    fake.answers['POST /files/f1/complete'] = () => new ApiError('http', 'The request was refused.', { status: 409, code: 'file_duplicate', detail: { fileId: KEPT } });
    const files = await mount();
    pick(file('hours.txt'), file('menu.txt'));
    await waitFor(() => { expect(fake.puts).toHaveLength(2); });
    await act(async () => {
      for (const put of fake.puts) put.ok();
      await new Promise((resolve) => { setTimeout(resolve, 0); });
    });
    await waitFor(() => { expect(screen.getAllByText('Text file')).toHaveLength(2); });
    expect(files.current?.alerts).toEqual([]);
    expect(files.current?.news.map((line) => line.text)).toContain('hours.txt is attached.');
    let taken: ReturnType<ComposerFiles['take']> | undefined;
    act(() => { taken = files.current?.take(); });
    expect(taken?.attachments.map((attachment) => attachment.ref)).toEqual([`f_${KEPT}`, 'f_f2']);
    act(() => { taken?.restore(); });
    fireEvent.click(screen.getByRole('button', { name: 'Remove hours.txt from this message' }));
    expect(screen.getAllByText(REMOVED_LINE)).toHaveLength(1);
    expect(fake.calls.filter((call) => call.method === 'DELETE')).toEqual([]);
  });

  test('each conversation keeps its own files', async () => {
    const files = await mount();
    pick(file('hours.txt'));
    await waitFor(() => { expect(chips()).toHaveLength(1); });
    act(() => { files.current?.switchTo(null, 'c1'); });
    expect(screen.queryByRole('list', { name: 'Files attached to your message' })).toBeNull();
    act(() => { files.current?.switchTo('c1', null); });
    expect(chips()).toHaveLength(1);
    // The upload went on meanwhile.
    expect(fake.puts).toHaveLength(1);
  });
});

function first<T>(items: readonly T[]): T {
  const item = items[0];
  if (item === undefined) throw new Error('none found');
  return item;
}
