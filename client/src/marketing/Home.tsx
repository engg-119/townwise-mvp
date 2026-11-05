import { Redirect } from 'expo-router';

export default function Home(): React.JSX.Element {
  return <Redirect href="/dashboard" />;
}
