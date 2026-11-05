import { CONTACT_HREF } from '../marketing/links';

// The address portal copy names, from the site's one contact link (marketing/links.ts), which is always exactly
// `mailto:<address>`. Copy that names the mailbox reads it from here, so it follows that constant.

export { CONTACT_HREF };

export const CONTACT_EMAIL = CONTACT_HREF.replace(/^mailto:/, '');
