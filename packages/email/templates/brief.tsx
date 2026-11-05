import {
  Body,
  Container,
  Head,
  Hr,
  Html,
  Link,
  Preview,
  render,
  Section,
  Text,
} from "@react-email/components";

// The morning brief (docs/PRODUCT-PLAN.md F4.1): one column, large tap
// targets, so it reads well on a phone. Every line links to its screen.

export interface BriefEmailButton {
  href: string;
  label: string;
}

export interface BriefEmailLine {
  buttons?: BriefEmailButton[];
  href: string;
  text: string;
}

export interface BriefEmailSection {
  lines: BriefEmailLine[];
  summary?: string;
  title: string;
  /** Stop this section (a confirmation page). */
  unsubscribeHref: string;
}

export interface BriefEmailProps {
  readonly heading: string;
  readonly preview: string;
  readonly sections: BriefEmailSection[];
  readonly settingsHref: string;
  readonly stopAllHref: string;
}

const text = {
  color: "#18181b",
  fontSize: "15px",
  lineHeight: "22px",
  margin: "0 0 4px",
};
const muted = { ...text, color: "#71717a", fontSize: "13px" };
const button = {
  display: "inline-block",
  padding: "8px 14px",
  marginRight: "8px",
  marginTop: "6px",
  borderRadius: "6px",
  border: "1px solid #d4d4d8",
  color: "#18181b",
  fontSize: "14px",
  textDecoration: "none",
};

export const BriefEmail = ({
  heading,
  preview,
  sections,
  settingsHref,
  stopAllHref,
}: BriefEmailProps) => (
  <Html>
    <Head />
    <Preview>{preview}</Preview>
    <Body
      style={{
        backgroundColor: "#fafafa",
        fontFamily:
          "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif",
        margin: 0,
        padding: "16px 0",
      }}
    >
      <Container
        style={{
          backgroundColor: "#ffffff",
          borderRadius: "8px",
          maxWidth: "560px",
          padding: "20px 16px",
        }}
      >
        <Text style={{ ...text, fontSize: "20px", fontWeight: 600 }}>
          {heading}
        </Text>
        {sections.map((s) => (
          <Section key={s.title} style={{ marginTop: "20px" }}>
            <Text style={{ ...text, fontSize: "16px", fontWeight: 600 }}>
              {s.title}
            </Text>
            {s.summary && <Text style={muted}>{s.summary}</Text>}
            {s.lines.map((l) => (
              <Section key={l.href + l.text} style={{ marginTop: "10px" }}>
                <Link href={l.href} style={{ ...text, display: "block" }}>
                  {l.text}
                </Link>
                {l.buttons?.map((b) => (
                  <Link href={b.href} key={b.label} style={button}>
                    {b.label}
                  </Link>
                ))}
              </Section>
            ))}
            <Text style={{ ...muted, marginTop: "8px" }}>
              <Link href={s.unsubscribeHref} style={{ color: "#71717a" }}>
                Stop "{s.title}" in my brief
              </Link>
            </Text>
          </Section>
        ))}
        <Hr style={{ margin: "24px 0 12px" }} />
        <Text style={muted}>
          Sent on weekdays at the time you chose.{" "}
          <Link href={settingsHref} style={{ color: "#71717a" }}>
            Change the time or sections
          </Link>{" "}
          ·{" "}
          <Link href={stopAllHref} style={{ color: "#71717a" }}>
            Stop the morning brief
          </Link>
        </Text>
      </Container>
    </Body>
  </Html>
);

BriefEmail.PreviewProps = {
  heading: "Good morning. Here's Tue Nov 10.",
  preview: "2 orders late, 3 quotes waiting",
  settingsHref: "https://app.example.com/settings/notifications",
  stopAllHref: "https://app.example.com/email/unsubscribe",
  sections: [
    {
      title: "Late or at risk",
      summary: "2 orders late, from the plan made Mon Nov 9.",
      unsubscribeHref: "https://app.example.com/email/unsubscribe",
      lines: [
        {
          text: "SO-1001 (Acme): 3 days late, due Tue Nov 10. HAAS-VF2 is fully booked. Best lever: Overtime on HAAS-VF2, or split the lot.",
          href: "https://app.example.com/schedule/bottlenecks",
        },
      ],
    },
    {
      title: "Facts to approve",
      summary: "1 fact waiting.",
      unsubscribeHref: "https://app.example.com/email/unsubscribe",
      lines: [
        {
          text: "F-12: P-1001 op 10 setup time 30 min → 45 min",
          href: "https://app.example.com/knowledge/facts",
          buttons: [
            { label: "Approve", href: "https://app.example.com/email/act" },
            { label: "Reject", href: "https://app.example.com/email/act" },
          ],
        },
      ],
    },
  ],
} satisfies BriefEmailProps;

/** The brief as HTML and plain text (for clients that show text only). */
export const renderBriefEmail = async (props: BriefEmailProps) => {
  const element = <BriefEmail {...props} />;
  const [html, text] = await Promise.all([
    render(element),
    render(element, { plainText: true }),
  ]);
  return { html, text };
};

export default BriefEmail;
