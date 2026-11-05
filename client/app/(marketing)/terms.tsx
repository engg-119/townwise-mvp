import { A, Div, H1, H2, Li, Nav, Ol, P, Section, Span, Ul } from '../../src/marketing/html';
import { CONTACT_EMAIL, CONTACT_HREF } from '../../src/marketing/links';
import { MarketingShell } from '../../src/marketing/MarketingShell';

const Mail = (): React.JSX.Element => <A href={CONTACT_HREF}>{CONTACT_EMAIL}</A>;

const clauses: { title: string; body: React.ReactNode }[] = [
  {
    title: 'Who you are agreeing with',
    body: <P>These terms are between you and <Span className="chip">[OPERATOR LEGAL NAME]</Span> (“Townwise”, “we”). Townwise is a student project built in ENGG 119 at Dartmouth’s Thayer School of Engineering. It is not an official Dartmouth product. Contact: <Mail />.</P>,
  },
  {
    title: 'What Townwise is, today',
    body: <P>Townwise is in early access and under active development. It is meant to forecast demand for restaurants and bars from local information and the restaurant’s own sales history. Features will change, some described on our site are not built yet, and the service may be unavailable at times. We will say on the site which parts are built and which are planned.</P>,
  },
  {
    title: 'Your account',
    body: <P>You sign in with a Google account. Keep that account secure; anyone who can sign in to it can sign in to Townwise as you. Tell us at <Mail /> if you think someone else has used your account. Townwise is for restaurants and bars. To use it, you must be 18 or older and acting for your business, and you must be able to enter a contract on behalf of that business.</P>,
  },
  {
    title: 'Forecasts are estimates',
    body: <P>A forecast is our best estimate, with a range, not a promise. Real demand will sometimes fall outside the range. Decisions about ordering, staffing and spending stay yours. Do not rely on Townwise as your only basis for decisions that could cause serious loss.</P>,
  },
  {
    title: 'Your data',
    body: <P>You keep ownership of the sales data and other information you give us. You give us permission to use it to provide Townwise to you, including calibrating your forecasts. Your sales data is used only to calibrate your own restaurant’s forecasts. It is not shared with or used for other restaurants, and it is not used to train AI models. Our <A href="/privacy">Privacy notice</A> explains what we collect and how we handle it.</P>,
  },
  {
    title: 'Fair use',
    body: (
      <>
        <P>Do not:</P>
        <Ul className="bl">
          <Li>try to get into accounts or data that are not yours</Li>
          <Li>probe, scan or test the service’s security without our written permission (to report a problem you found, see our <A href="/security">Security page</A>)</Li>
          <Li>overload the service or get around its rate limits</Li>
          <Li>copy, resell or rebuild Townwise or its forecasts as a competing product</Li>
          <Li>use Townwise to break the law</Li>
        </Ul>
      </>
    ),
  },
  {
    title: 'Fees',
    body: <P>Early access is <Span className="chip">[FREE / PRICE AND BILLING TERMS]</Span>. If we start charging, we will tell you the price before it applies, and you can stop using Townwise instead.</P>,
  },
  {
    title: 'Ending your use',
    body: <P>You can stop using Townwise at any time. We may suspend or end your access if you break these terms, or end early access for everyone with <Span className="chip">[NOTICE PERIOD]</Span> notice. Whenever you stop, or your access ends, you can ask us to delete your account and its data, and we will delete it within 30 days. The <A href="/privacy">Privacy notice</A> explains how, under “Your choices”.</P>,
  },
  {
    title: 'No warranty',
    body: <P>Townwise is provided as is, without warranties of any kind, to the extent the law allows. <Span className="chip">[LEGAL REVIEW: jurisdiction-specific disclaimer language.]</Span></P>,
  },
  {
    title: 'Limits on liability',
    body: <P>To the extent the law allows, we are not liable for lost profits, lost revenue, spoiled or excess inventory, staffing costs or other indirect losses from using or relying on Townwise. Our total liability is limited to <Span className="chip">[LIABILITY CAP]</Span>. <Span className="chip">[LEGAL REVIEW]</Span></P>,
  },
  {
    title: 'Changes to these terms',
    body: <P>We may update these terms. We will post the new version with a new effective date and, for changes that matter, tell account holders <Span className="chip">[HOW: by email or in the app]</Span> before they take effect. If you keep using Townwise after that, the new terms apply.</P>,
  },
  {
    title: 'Governing law',
    body: <P>These terms are governed by <Span className="chip">[GOVERNING LAW]</Span>. Disputes go to <Span className="chip">[VENUE]</Span>. <Span className="chip">[LEGAL REVIEW]</Span></P>,
  },
  {
    title: 'Contact',
    body: <P><Mail /></P>,
  },
];

const number = (index: number): string => String(index + 1).padStart(2, '0');

export default function Terms(): React.JSX.Element {
  return (
    <MarketingShell title="Townwise Terms">
      <Div className="pg-terms">
        <Section className="ph" aria-labelledby="h-terms">
          <Div className="wrap">
            <P className="eyebrow">Legal</P>
            <Div className="h1w"><H1 id="h-terms" className="h1">Terms of use</H1></Div>
            <P className="eff">Effective November 5, 2026.</P>
          </Div>
        </Section>
        <Div className="wrap g12 doc">
          <Nav className="toc" aria-labelledby="toc-h">
            <H2 id="toc-h" className="eyebrow">On this page</H2>
            <Ol>
              {clauses.map((clause, index) => (
                <Li key={clause.title}><A href={`#s${String(index + 1)}`}><Span className="sn">{number(index)}</Span> {clause.title}</A></Li>
              ))}
            </Ol>
          </Nav>
          <Div className="art">
            {clauses.map((clause, index) => (
              <Section key={clause.title} id={`s${String(index + 1)}`} className="sec" aria-labelledby={`t${String(index + 1)}`} tabIndex={-1}>
                <H2 id={`t${String(index + 1)}`} className="h3"><Span className="sn">{number(index)}</Span> {clause.title}</H2>
                <Div className="prose">{clause.body}</Div>
              </Section>
            ))}
          </Div>
        </Div>
      </Div>
    </MarketingShell>
  );
}
