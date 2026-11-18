import { RootStack } from '../../app/_layout';
import MarketingLayout from '../../app/(marketing)/_layout';
import MarketingHome from '../../app/(marketing)/index';
import About from '../../app/(marketing)/about';
import Privacy from '../../app/(marketing)/privacy';
import Terms from '../../app/(marketing)/terms';
import PublicSecurity from '../../app/(marketing)/security';
import AuthGate from '../../app/(gate)/_layout';
import SignIn from '../../app/(gate)/sign-in';
import Totp from '../../app/(gate)/totp';
import Magic from '../../app/(gate)/auth/magic';
import PortalLayout from '../../app/(gate)/(app)/_layout';
import AccessLayout from '../../app/(gate)/(app)/(access)/_layout';
import RequestAccess from '../../app/(gate)/(app)/(access)/request-access';
import Waiting from '../../app/(gate)/(app)/(access)/waiting';
import NoAccess from '../../app/(gate)/(app)/(access)/no-access';
import Joining from '../../app/(gate)/(app)/(access)/joining';
import AccountLayout from '../../app/(gate)/(app)/(account)/_layout';
import Security from '../../app/(gate)/(app)/(account)/settings/security';
import ClientLayout from '../../app/(gate)/(app)/(client)/_layout';
import Dashboard from '../../app/(gate)/(app)/(client)/dashboard';
import Team from '../../app/(gate)/(app)/(client)/team';
import Settings from '../../app/(gate)/(app)/(client)/settings';
import AddLocation from '../../app/(gate)/(app)/(client)/locations/new';
import LocationLayout from '../../app/(gate)/(app)/(client)/locations/[locationId]/_layout';
import Forecast from '../../app/(gate)/(app)/(client)/locations/[locationId]/index';
import Calendar from '../../app/(gate)/(app)/(client)/locations/[locationId]/calendar';
import Analytics from '../../app/(gate)/(app)/(client)/locations/[locationId]/analytics';
import Sales from '../../app/(gate)/(app)/(client)/locations/[locationId]/sales/index';
import Upload from '../../app/(gate)/(app)/(client)/locations/[locationId]/sales/upload';
import Data from '../../app/(gate)/(app)/(client)/locations/[locationId]/data/index';
import DataItem from '../../app/(gate)/(app)/(client)/locations/[locationId]/data/[ref]';
import Notes from '../../app/(gate)/(app)/(client)/locations/[locationId]/notes';
import Town from '../../app/(gate)/(app)/(client)/locations/[locationId]/town';
import Orders from '../../app/(gate)/(app)/(client)/locations/[locationId]/orders/index';
import OrdersSetup from '../../app/(gate)/(app)/(client)/locations/[locationId]/orders/setup';
import LocationSettings from '../../app/(gate)/(app)/(client)/locations/[locationId]/settings';
import Agent from '../../app/(gate)/(app)/(client)/locations/[locationId]/agent';
import Rules from '../../app/(gate)/(app)/(client)/locations/[locationId]/rules';
import Chat from '../../app/(gate)/(app)/(client)/locations/[locationId]/chat';
import ConsoleLayout from '../../app/(gate)/(app)/(console)/_layout';
import Requests from '../../app/(gate)/(app)/(console)/admin/index';
import Orgs from '../../app/(gate)/(app)/(console)/admin/orgs/index';
import Org from '../../app/(gate)/(app)/(console)/admin/orgs/[orgId]';
import People from '../../app/(gate)/(app)/(console)/admin/people';
import Audit from '../../app/(gate)/(app)/(console)/admin/audit';
import NotFound from '../../app/+not-found';
import { AuthProvider } from '../../src/auth/AuthProvider';
import type { Auth } from '../../src/auth/auth';

// Every route file of the app, keyed as expo-router's test context expects, under a root layout seeded with a
// fake auth object. The real root layout builds its auth from the environment, which tests do not have.

export function seededRoot(auth: Auth): React.ComponentType {
  return function Root(): React.JSX.Element {
    return (
      <AuthProvider auth={auth}>
        <RootStack />
      </AuthProvider>
    );
  };
}

export function appRoutes(root: React.ComponentType, overrides?: Record<string, React.ComponentType>): Record<string, React.ComponentType> {
  return {
    _layout: root,
    '(marketing)/_layout': MarketingLayout,
    '(marketing)/index': MarketingHome,
    '(marketing)/about': About,
    '(marketing)/privacy': Privacy,
    '(marketing)/terms': Terms,
    '(marketing)/security': PublicSecurity,
    '(gate)/_layout': AuthGate,
    '(gate)/sign-in': SignIn,
    '(gate)/totp': Totp,
    '(gate)/auth/magic': Magic,
    '(gate)/(app)/_layout': PortalLayout,
    '(gate)/(app)/(access)/_layout': AccessLayout,
    '(gate)/(app)/(access)/request-access': RequestAccess,
    '(gate)/(app)/(access)/waiting': Waiting,
    '(gate)/(app)/(access)/no-access': NoAccess,
    '(gate)/(app)/(access)/joining': Joining,
    '(gate)/(app)/(account)/_layout': AccountLayout,
    '(gate)/(app)/(account)/settings/security': Security,
    '(gate)/(app)/(client)/_layout': ClientLayout,
    '(gate)/(app)/(client)/dashboard': Dashboard,
    '(gate)/(app)/(client)/team': Team,
    '(gate)/(app)/(client)/settings': Settings,
    '(gate)/(app)/(client)/locations/new': AddLocation,
    '(gate)/(app)/(client)/locations/[locationId]/_layout': LocationLayout,
    '(gate)/(app)/(client)/locations/[locationId]/index': Forecast,
    '(gate)/(app)/(client)/locations/[locationId]/calendar': Calendar,
    '(gate)/(app)/(client)/locations/[locationId]/analytics': Analytics,
    '(gate)/(app)/(client)/locations/[locationId]/sales/index': Sales,
    '(gate)/(app)/(client)/locations/[locationId]/sales/upload': Upload,
    '(gate)/(app)/(client)/locations/[locationId]/data/index': Data,
    '(gate)/(app)/(client)/locations/[locationId]/data/[ref]': DataItem,
    '(gate)/(app)/(client)/locations/[locationId]/notes': Notes,
    '(gate)/(app)/(client)/locations/[locationId]/town': Town,
    '(gate)/(app)/(client)/locations/[locationId]/orders/index': Orders,
    '(gate)/(app)/(client)/locations/[locationId]/orders/setup': OrdersSetup,
    '(gate)/(app)/(client)/locations/[locationId]/settings': LocationSettings,
    '(gate)/(app)/(client)/locations/[locationId]/agent': Agent,
    '(gate)/(app)/(client)/locations/[locationId]/rules': Rules,
    '(gate)/(app)/(client)/locations/[locationId]/chat': Chat,
    '(gate)/(app)/(console)/_layout': ConsoleLayout,
    '(gate)/(app)/(console)/admin/index': Requests,
    '(gate)/(app)/(console)/admin/orgs/index': Orgs,
    '(gate)/(app)/(console)/admin/orgs/[orgId]': Org,
    '(gate)/(app)/(console)/admin/people': People,
    '(gate)/(app)/(console)/admin/audit': Audit,
    '+not-found': NotFound,
    ...overrides,
  };
}
