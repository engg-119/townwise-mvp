// The browser's prefers-reduced-motion, kept current as it changes. Known at once on web, so never
// null (the contract in ./motion.ts allows it); without matchMedia there is no stated preference.
// Reads the setting, stores nothing.
export { useReducedMotion } from './marketing/useReducedMotion.web';
