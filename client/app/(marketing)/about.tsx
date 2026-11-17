import { A, Div, H1, H2, Li, Ol, P, Section, Span, Strong, Table, Tbody, Td, Th, Thead, Tr, Ul } from '../../src/marketing/html';
import { CONTACT_EMAIL, CONTACT_HREF, EARLY_ACCESS_HREF } from '../../src/marketing/links';
import { MarketingShell } from '../../src/marketing/MarketingShell';

function Part(props: { id: string; title: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <Section className="sec" aria-labelledby={props.id}>
      <Div className="wrap g12">
        <H2 id={props.id} className="h2s c-l">{props.title}</H2>
        {props.children}
      </Div>
    </Section>
  );
}

export default function About(): React.JSX.Element {
  return (
    <MarketingShell title="Townwise About">
      <Div className="pg-about">
        <Section className="ab-hero" aria-labelledby="h-about">
          <Div className="wrap g12">
            <P className="eyebrow c-l">About</P>
            <Div className="c-r">
              <H1 id="h-about" className="h1">We think a small town deserves its own forecast.</H1>
            </Div>
            <Div className="c-r prose">
              <P>Townwise started with a simple observation. Restaurant demand in a town like Hanover, NH moves with things a regional forecast does not track: the college’s academic calendar, sporting events, campus life, tourism and the way the population swells and shrinks with the seasons. A forecast built from regional patterns averages those swings away, and the owner is left to guess.</P>
              <P className="lede">So we are building a forecast that starts from the town.</P>
            </Div>
          </Div>
        </Section>

        <Part id="h-build" title="What we’re building">
          <Ol className="build c-r">
            <Li><P><Strong>A research agent</Strong> that will find every event and driver of demand in a town, with the date and the public source behind each one.</P></Li>
            <Li><P><Strong>Uploading your sales history</Strong> from your point-of-sale system, to calibrate your forecasts.</P></Li>
            <Li><P><Strong>A model calibrated to your business:</Strong> the town model, tuned with your own history to forecast your daily guests and sales, each day with a range and a reason.</P></Li>
            <Li><P><Strong>A tuning agent you talk to:</Strong> tell it what it can’t see, and it will retrain your model and explain its forecasts.</P></Li>
            <Li><P><Strong>An app</Strong> that will put it in front of the people who place the orders.</P></Li>
            <Li className="nx"><P><Strong>Next:</Strong> reorder suggestions, starting with bar inventory.</P></Li>
          </Ol>
        </Part>

        <Part id="h-where" title="Where we are">
          <Div className="c-r">
            <Div className="stages">
              <Table>
                <Thead><Tr><Th scope="col">Stage</Th><Th scope="col">What it covers</Th><Th scope="col">Status</Th></Tr></Thead>
                <Tbody>
                  <Tr>
                    <Th scope="row">1. Locality research and data</Th>
                    <Td data-l="What it covers">The town research agent, public datasets, the app’s foundation</Td>
                    <Td data-l="Status"><Div className="st-c"><Span className="tag tag-prog">In progress</Span><P>Sign-in and the server are built. Hanover’s public calendar is compiled, every date with a source. The research agent itself is not built yet.</P></Div></Td>
                  </Tr>
                  {/* [CONFIRM: wording, awaiting the owner] Forecasts publish by default and refit weekly (autonomous-forecasts, D42). */}
                  <Tr>
                    <Th scope="row">2. Forecasting agent</Th>
                    <Td data-l="What it covers">Automatic feature building, model selection and training, against traditional baselines</Td>
                    <Td data-l="Status"><Div className="st-c"><Span className="tag tag-prog">In progress</Span><P>Candidate models run in our research notebooks and are tested with a rolling backtest. In the app, Townwise’s trained demand model and a simpler baseline are both tested on each restaurant’s own past weeks, and its forecast switches between them only when the other does clearly better. The forecasting agent itself is not built yet.</P></Div></Td>
                  </Tr>
                  {/* [CONFIRM: wording, awaiting the owner] Forecasts publish by default and refit weekly (autonomous-forecasts, D42). */}
                  <Tr>
                    <Th scope="row">3. Calibration and forecasts</Th>
                    <Td data-l="What it covers">Calibrating with point-of-sale history; forecasts with ranges and reasons; testing how much history is needed</Td>
                    <Td data-l="Status"><Div className="st-c"><Span className="tag tag-prog">In progress</Span><P>Restaurants with early access can upload their sales history and add notes about unusual days in the app. Once a location’s history spans 230 days, Townwise refits its daily guest forecast every week and publishes it, with a range and reasons, when it passes our accuracy checks. We are still testing how much history it takes to make a difference.</P></Div></Td>
                  </Tr>
                  <Tr>
                    <Th scope="row">4. Evaluation</Th>
                    <Td data-l="What it covers">A real-world case study, refinements, a final report on results and limits</Td>
                    <Td data-l="Status"><Div className="st-c"><Span className="tag tag-plan">Planned</Span></Div></Td>
                  </Tr>
                </Tbody>
              </Table>
            </Div>
            <P className="frozen">Forecasts we report as results are frozen before their outcomes are known, so any accuracy we publish on live forecasts comes from forecasts frozen in advance. Tests on past data will be labeled as backtests.</P>
          </Div>
        </Part>

        <Part id="h-questions" title="The questions we’re answering">
          <Ul className="qs c-r">
            <Li>Can an agent that researches a town on its own build a forecast that beats a general one, especially where sales history is thin?</Li>
            <Li>How much of a restaurant’s own history does it take to tune a town model to that restaurant?</Li>
            <Li>How well can we forecast from public information alone?</Li>
          </Ul>
        </Part>

        <Part id="h-who" title="Who we are">
          <Div className="c-r prose">
            <P>We are a team of four students in ENGG 119, AI in the Real World, at Dartmouth’s Thayer School of Engineering in Hanover, NH. Townwise is our course project. It is not an official Dartmouth product.</P>
          </Div>
        </Part>

        <Part id="h-talk" title="Talk to us">
          <Div className="c-r talk">
            <P className="big">If you run a restaurant or bar in a town with its own calendar, we’d like to hear from you.</P>
            <Div className="talk-act">
              <A className="btn" href={EARLY_ACCESS_HREF}>Request early access</A>
              <A className="tl" href={CONTACT_HREF}>Or write to {CONTACT_EMAIL}</A>
            </Div>
          </Div>
        </Part>
      </Div>
    </MarketingShell>
  );
}
