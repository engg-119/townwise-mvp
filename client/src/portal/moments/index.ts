// Statement moments (spec 15.8): the request-received and welcome statements, revealed word by word over the
// portal. MomentProvider is the one player; pages use useMoment().
export { MomentProvider, useMoment, type MomentApi } from './MomentProvider';
export { requestReceivedStatement, welcomeStatement, type Statement, type WelcomeView } from './moments';
export { StatementOverlay, type StatementOverlayProps } from './StatementOverlay';
export { WordReveal } from './WordReveal';
