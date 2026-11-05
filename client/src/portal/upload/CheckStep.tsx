import { StyleSheet, View } from 'react-native';

import { theme } from '../../theme';
import { formatCount, formatDate } from '../format';
import type { Coverage, Role } from '../schemas';
import { Actions, Button, LinkButton } from '../ui/Button';
import { DataTable, DefinitionList } from '../ui/DataTable';
import { Messages } from '../ui/feedback';
import { Columns, Stack } from '../ui/layout';
import { Eyebrow, Heading, Lead, Small } from '../ui/text';
import {
  alreadyHaveLine, badNumberLine, COPY, EXCLUSION, formatDollars, moreDaysLine, noDateLine, otherLocationLine,
  repeatedDatesLine, rowsBecameDays, sendErrorOf, sendLabel,
} from './copy';
import { LIST_LIMIT, totalsOf, type CheckResult, type DaysResult, type SalesDay } from './days';

// Step 3, Check the totals (spec 11.2 step 3): how many rows became days, the totals to compare with the
// point-of-sale system, skipped rows by reason with row numbers only, the days left out by date, what happens to
// days the location already has, and the first and last days exactly as they will be sent.

const PREVIEW = 7;

function DaysTable(props: { label: string; days: readonly SalesDay[] }): React.JSX.Element {
  return (
    <DataTable
      label={props.label}
      columns={[
        { key: 'date', label: props.label, flex: 2 },
        { key: 'guests', label: 'Guests', numeric: true },
        { key: 'sales', label: 'Net sales', numeric: true },
      ]}
      rows={props.days.map((day) => ({
        key: day.date,
        cells: {
          date: formatDate(day.date),
          guests: day.guests === null ? '' : formatCount(day.guests),
          sales: day.netSalesCents === null ? '' : formatDollars(day.netSalesCents),
        },
      }))}
    />
  );
}

function tableLabel(edge: 'First' | 'Last', count: number): string {
  return count === 1 ? `${edge} day` : `${edge} ${String(count)} days`;
}

function Block(props: { title: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <Stack gap={theme.space[3]}>
      <Eyebrow>{props.title}</Eyebrow>
      {props.children}
    </Stack>
  );
}

function Summary(props: { result: DaysResult; role: Role; coverage: Coverage }): React.JSX.Element {
  const { result, role, coverage } = props;
  const { days } = result;
  const totals = totalsOf(days);
  const skipped = [
    ...(result.noDate.count > 0 ? [noDateLine(result.noDate)] : []),
    ...(result.badNumber.count > 0 ? [badNumberLine(result.badNumber)] : []),
    ...(result.otherLocation > 0 ? [otherLocationLine(result.otherLocation)] : []),
  ];
  const more = moreDaysLine(result.excluded.length);
  const first = days.slice(0, PREVIEW);
  const last = days.slice(Math.max(PREVIEW, days.length - PREVIEW));
  const main = (
    <Stack gap={theme.space[8]}>
      <Block title="Totals in this file">
        <DefinitionList
          mono
          items={[
            { term: 'Guests', value: result.guestsMapped ? formatCount(totals.guests) : COPY.notInFile },
            { term: 'Net sales', value: result.netSalesMapped ? formatDollars(totals.netSalesCents) : COPY.notInFile },
          ]}
        />
        <Small>{COPY.checkAgainst}</Small>
      </Block>
      {skipped.length === 0 ? null : <Block title="Skipped rows"><Messages items={skipped} /></Block>}
      {result.excluded.length === 0 ? null : (
        <Block title="Days left out">
          <DefinitionList mono items={result.excluded.slice(0, LIST_LIMIT).map((day) => ({ term: formatDate(day.date), value: EXCLUSION[day.reason] }))} />
          {more === null ? null : <Small>{more}</Small>}
        </Block>
      )}
      {coverage.dayCount > 0 && coverage.firstDate !== null && coverage.lastDate !== null ? (
        <Block title="Days you already have">
          <Small>{alreadyHaveLine(role, coverage.firstDate, coverage.lastDate)}</Small>
        </Block>
      ) : null}
    </Stack>
  );
  const side = days.length === 0 ? undefined : (
    <Stack>
      <Eyebrow>What Townwise will receive</Eyebrow>
      <Small>{COPY.onlyThese}</Small>
      <DaysTable label={tableLabel('First', first.length)} days={first} />
      {last.length === 0 ? null : <DaysTable label={tableLabel('Last', last.length)} days={last} />}
    </Stack>
  );
  return <Columns main={main} {...(side === undefined ? {} : { side })} gap={theme.space[8]} />;
}

export function CheckStep(props: {
  result: CheckResult;
  role: Role;
  coverage: Coverage;
  sendError: unknown;
  onSend: () => void;
  onRestart: () => void;
  onBack: () => void;
  cancelHref: string;
}): React.JSX.Element {
  const { result } = props;
  const back = <Button variant="link" label="Back" onPress={props.onBack} />;
  const cancel = <LinkButton href={props.cancelHref} label="Cancel" />;
  const heading = <Heading level={3}>Check the totals</Heading>;

  if (result.kind !== 'days') {
    const text = result.kind === 'no_dates' ? COPY.noDates
      : result.kind === 'decimal_comma' ? COPY.decimalComma
        : result.kind === 'too_many_days' ? COPY.tooManyDays
          : repeatedDatesLine(result.dates, result.repeats);
    return (
      <Stack gap={theme.space[6]}>
        {heading}
        <View style={styles.error}>
          <Messages live="alert" items={[text]} />
          {back}
        </View>
      </Stack>
    );
  }

  const count = result.days.length;
  const failure = props.sendError === null ? null : sendErrorOf(props.sendError);
  const first = result.days[0];
  const last = result.days[count - 1];
  let actions: React.ReactNode;
  if (count === 0) {
    actions = <Actions>{back}{cancel}</Actions>;
  } else if (failure?.action === 'missing') {
    actions = <Actions><LinkButton href="/dashboard" label="Locations" /></Actions>;
  } else if (failure?.action === 'restart') {
    actions = <Actions><Button variant="outline" label="Try again" onPress={props.onRestart} />{cancel}</Actions>;
  } else if (failure?.action === 'retry') {
    actions = <Actions><Button variant="outline" label="Try again" onPress={props.onSend} />{back}{cancel}</Actions>;
  } else {
    actions = <Actions><Button label={sendLabel(count)} onPress={props.onSend} />{back}{cancel}</Actions>;
  }

  return (
    <Stack gap={theme.space[6]}>
      {heading}
      {first === undefined || last === undefined ? (
        <Messages live="status" items={[COPY.nothingToSend]} />
      ) : (
        <Lead>{rowsBecameDays(result.rows, count, first.date, last.date)}</Lead>
      )}
      {result.addedUp ? <Small>{COPY.addedUp}</Small> : null}
      <Summary result={result} role={props.role} coverage={props.coverage} />
      {failure === null ? null : <Messages live="alert" items={[failure.text]} />}
      {actions}
    </Stack>
  );
}


const styles = StyleSheet.create({
  error: { gap: theme.space[4], alignItems: 'flex-start' },
});
