import { Dimensions, StyleSheet } from 'react-native';
import { fireEvent, render, screen, userEvent, within } from '@testing-library/react-native';

import { Button } from '../../src/portal/ui/Button';
import { ConfirmDialog } from '../../src/portal/ui/ConfirmDialog';
import { DataTable, DefinitionList } from '../../src/portal/ui/DataTable';
import { EmptyState, ErrorNotice, Notice, StatusTag } from '../../src/portal/ui/feedback';
import { FormField } from '../../src/portal/ui/FormField';
import { offline } from '../helpers/portal';

function dialog(overrides?: Partial<Parameters<typeof ConfirmDialog>[0]>) {
  const onConfirm = jest.fn();
  const onCancel = jest.fn();
  const props = {
    visible: true, title: 'Delete all sales data', confirmLabel: 'Delete all sales data', onConfirm, onCancel,
    body: 'This deletes 400 days of sales data for Main Street Bar. Notes stay. This can’t be undone.',
    ...overrides,
  };
  return { props, onConfirm, onCancel };
}

describe('ConfirmDialog (spec 15.7)', () => {
  test('the typed-name variant keeps its action disabled until the name matches', async () => {
    const { props, onConfirm, onCancel } = dialog({ typedName: 'Main Street Bar' });
    await render(<ConfirmDialog {...props} />);
    expect(screen.getByRole('heading', { name: 'Delete all sales data' })).toBeTruthy();
    expect(screen.getByText(props.body)).toBeTruthy();
    const user = userEvent.setup();
    const action = screen.getByRole('button', { name: 'Delete all sales data' });
    expect(action.props.accessibilityState).toMatchObject({ disabled: true });
    await user.press(action);
    expect(onConfirm).not.toHaveBeenCalled();
    await fireEvent.changeText(screen.getByLabelText('Type Main Street Bar to confirm.'), 'Main Street');
    expect(screen.getByRole('button', { name: 'Delete all sales data' }).props.accessibilityState).toMatchObject({ disabled: true });
    await fireEvent.changeText(screen.getByLabelText('Type Main Street Bar to confirm.'), 'Main Street Bar');
    await user.press(screen.getByRole('button', { name: 'Delete all sales data' }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    await user.press(screen.getByRole('button', { name: 'Cancel' }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  test('while it runs the action says so and waits; an error shows the shared copy; closed, it renders nothing', async () => {
    const { props } = dialog({ pending: true, pendingLabel: 'Deleting…', error: offline() });
    const view = await render(<ConfirmDialog {...props} />);
    expect(screen.getByRole('button', { name: 'Deleting…' }).props.accessibilityState).toMatchObject({ disabled: true });
    expect(screen.getByText('Can’t reach Townwise. Check your connection and try again.')).toBeTruthy();
    await view.rerender(<ConfirmDialog {...props} visible={false} />);
    expect(screen.queryByText(props.body)).toBeNull();
  });

  test('while it runs, Cancel and the back button wait for its answer', async () => {
    const { props, onCancel } = dialog({ pending: true, pendingLabel: 'Deleting…' });
    const view = await render(<ConfirmDialog {...props} />);
    /** The host Modal around the dialog, where Android's back button lands (onRequestClose). */
    function modal(): Parameters<typeof fireEvent>[0] {
      let node = screen.getByText(props.body);
      while (node.type !== 'Modal' && node.parent !== null) node = node.parent;
      return node;
    }
    const cancel = screen.getByRole('button', { name: 'Cancel' });
    expect(cancel.props.accessibilityState).toMatchObject({ disabled: true });
    await userEvent.setup().press(cancel);
    await fireEvent(modal(), 'requestClose');
    expect(onCancel).not.toHaveBeenCalled();

    await view.rerender(<ConfirmDialog {...props} pending={false} />);
    await fireEvent(modal(), 'requestClose');
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});

describe('buttons (spec 15.6, 15.7)', () => {
  test('a disabled control stays in place, says it is disabled and does nothing when pressed', async () => {
    const onPress = jest.fn();
    await render(<><Button label="Upload sales history" disabled onPress={onPress} /><Button variant="outline" label="Check again" onPress={onPress} /></>);
    const user = userEvent.setup();
    const upload = screen.getByRole('button', { name: 'Upload sales history' });
    expect(upload.props.accessibilityState).toMatchObject({ disabled: true });
    await user.press(upload);
    expect(onPress).not.toHaveBeenCalled();
    await user.press(screen.getByRole('button', { name: 'Check again' }));
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  test('the primary is white with a dark label; mint fills no button', async () => {
    await render(<Button label="Send request" onPress={() => undefined} />);
    const box = StyleSheet.flatten(screen.getByRole('button', { name: 'Send request' }).props.style) as { backgroundColor?: string };
    expect(box.backgroundColor).toBe('#eff2f6');
    const label = StyleSheet.flatten(screen.getByText('Send request').props.style) as { color?: string };
    expect(label.color).toBe('#080a0d');
  });
});

describe('fields, notices and tags', () => {
  test('a FormField: its label, 16px text, the helper as the hint, messages, and read-only under view-as', async () => {
    const view = await render(<FormField label="Organization name" helper="As you’d like it to appear." messages={['Enter your organization’s name.']} value="" />);
    const input = screen.getByLabelText('Organization name');
    expect((StyleSheet.flatten(input.props.style) as { fontSize?: number }).fontSize).toBe(16);
    expect(input.props.accessibilityHint).toBe('As you’d like it to appear.');
    expect(screen.getByText('Enter your organization’s name.')).toBeTruthy();
    expect(input.props.editable).toBe(true);
    await view.rerender(<FormField label="Organization name" value="" readOnly />);
    expect(screen.getByLabelText('Organization name').props.editable).toBe(false);
  });

  test('notices are status messages and errors are alerts, numbered, with Try again', async () => {
    const onRetry = jest.fn();
    await render(<><Notice text="Saved." /><ErrorNotice error={offline()} onRetry={onRetry} /></>);
    expect(screen.getByRole('status')).toBeTruthy();
    expect(screen.getByText('Saved.')).toBeTruthy();
    expect(screen.getByRole('alert')).toBeTruthy();
    expect(screen.getAllByText('01')).toHaveLength(2);
    await fireEvent.press(screen.getByRole('button', { name: 'Try again' }));
    expect(onRetry).toHaveBeenCalled();
  });

  test('StatusTag for build status and kinds; an empty state says what to do', async () => {
    await render(<><StatusTag kind="progress" label="In progress" /><StatusTag kind="planned" label="Planned" /><StatusTag label="College town" /><EmptyState text="Your admin hasn’t added a location yet." /></>);
    for (const text of ['In progress', 'Planned', 'College town', 'Your admin hasn’t added a location yet.']) expect(screen.getByText(text)).toBeTruthy();
  });
});

describe('DataTable (spec 15.7)', () => {
  const columns = [{ key: 'month', label: 'Month' }, { key: 'guests', label: 'Guests', numeric: true }];
  const rows = [{ key: 'jan', cells: { month: 'Jan 2026', guests: '1,204' } }, { key: 'feb', cells: { month: 'Feb 2026', guests: '' } }];

  test('wide: one head row and a row per entry, in a named region', async () => {
    await render(<DataTable label="By month" columns={columns} rows={rows} />);
    const table = screen.getByLabelText('By month');
    expect(within(table).getAllByText('Guests')).toHaveLength(1);
    expect(within(table).getByText('1,204')).toBeTruthy();
  });

  test('640px and below: each row becomes label and value pairs, skipping empty cells', async () => {
    const spy = jest.spyOn(Dimensions, 'get').mockReturnValue({ width: 375, height: 800, scale: 2, fontScale: 1 });
    try {
      await render(<DataTable label="By month" columns={columns} rows={rows} />);
      const table = screen.getByLabelText('By month');
      expect(within(table).getAllByText('Month')).toHaveLength(2);
      expect(within(table).getAllByText('Guests')).toHaveLength(1);
    } finally {
      spy.mockRestore();
    }
  });
});

describe('DefinitionList (spec 15.7)', () => {
  const items = [{ term: 'Organization', value: 'Sample Diner' }, { term: 'Town', value: 'Stowe, VT' }];

  /** The space between one pair and the next: the pair's bottom margin plus the list's row gap. */
  async function spacing(width: number): Promise<number> {
    const spy = jest.spyOn(Dimensions, 'get').mockReturnValue({ width, height: 800, scale: 2, fontScale: 1 });
    try {
      await render(<DefinitionList items={items} />);
      const pair = screen.getByText('Organization').parent;
      const list = pair?.parent;
      const margin = (StyleSheet.flatten(pair?.props.style) as { marginBottom?: number } | undefined)?.marginBottom ?? 0;
      const gap = (StyleSheet.flatten(list?.props.style) as { gap?: number } | undefined)?.gap ?? 0;
      return margin + gap;
    } finally {
      spy.mockRestore();
    }
  }

  test('on phones the pairs are 12px apart, with no row gap on top of their margin, as on the boards', async () => {
    // A 20px term and a 20px value, then 12px: 52px from one pair to the next.
    expect(await spacing(375)).toBe(12);
  });

  test('wider, the term and value share a row and the rows are 8px apart', async () => {
    expect(await spacing(768)).toBe(8);
  });
});
