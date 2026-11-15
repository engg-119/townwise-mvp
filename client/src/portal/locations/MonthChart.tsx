// By month's chart on Sales data (spec P12). Native has no SVG (D21), and the page already says where the charts
// are, so it draws nothing here and By month keeps its table. MonthChart.web.tsx draws it, from the location's own
// reads.

export interface MonthChartProps { locationId: string }

export const MonthChart: (props: MonthChartProps) => React.JSX.Element | null = () => null;
