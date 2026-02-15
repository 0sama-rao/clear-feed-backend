import OpenAI from "openai";

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

export interface GroupBriefingInput {
  groupTitle: string;
  articles: Array<{
    title: string;
    cleanText: string | null;
    content: string;
    url: string;
    publishedAt: Date | null;
    author: string | null;
    entities: Array<{ type: string; name: string }>;
    signals: Array<{ slug: string; name: string }>;
  }>;
}

export interface GroupBriefing {
  title: string;
  synopsis: string;
  executiveSummary: string;
  impactAnalysis: string;
  actionability: string;
  caseType: number; // 1=actively exploited, 2=vulnerable, 3=fixed, 4=not applicable
}

/**
 * Generates a structured intelligence briefing for a group of related articles.
 * Uses a single OpenAI call per group (gpt-4o-mini for speed).
 */
export async function generateGroupBriefing(
  input: GroupBriefingInput
): Promise<GroupBriefing | null> {
  if (!process.env.OPENAI_API_KEY) {
    console.error("[BriefingGenerator] OPENAI_API_KEY is not set, skipping");
    return null;
  }

  try {
    // Build article context — use cleanText if available, fallback to content
    const articleTexts = input.articles.map((a, i) => {
      const text = a.cleanText || a.content;
      const date = a.publishedAt
        ? a.publishedAt.toISOString().split("T")[0]
        : "unknown date";
      const author = a.author ? ` by ${a.author}` : "";
      return `--- Article ${i + 1} ---\nTitle: ${a.title}\nDate: ${date}${author}\nURL: ${a.url}\n\n${text}`;
    });

    // Cap total input to ~20,000 chars — truncate articles proportionally
    let combined = articleTexts.join("\n\n");
    if (combined.length > 20_000) {
      const perArticle = Math.floor(20_000 / input.articles.length);
      combined = articleTexts
        .map((t) => t.slice(0, perArticle))
        .join("\n\n");
    }

    // Collect entity and signal metadata
    const allEntities = new Map<string, Set<string>>();
    const allSignals = new Set<string>();
    for (const a of input.articles) {
      for (const e of a.entities) {
        if (!allEntities.has(e.type)) allEntities.set(e.type, new Set());
        allEntities.get(e.type)!.add(e.name);
      }
      for (const s of a.signals) {
        allSignals.add(s.name);
      }
    }

    const entitySummary = [...allEntities.entries()]
      .map(([type, names]) => `${type}: ${[...names].join(", ")}`)
      .join("\n");
    const signalSummary = [...allSignals].join(", ");

    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: `You are a senior cybersecurity intelligence analyst producing a daily briefing pack for security operations teams.

You are given a group of related articles about the same event or topic. First, classify the story type, then produce the briefing accordingly.

## STORY TYPES

Classify the story as ONE of:
- **VULNERABILITY**: A specific CVE, software bug, or exploit (has affected versions, patches, CVE IDs)
- **INCIDENT**: A breach, attack, or active campaign against specific targets
- **THREAT_INTEL**: Threat actor activity, TTPs, malware analysis, or threat landscape reports
- **RESEARCH**: Academic research, new attack techniques, proof-of-concepts, or industry studies
- **POLICY**: Regulatory changes, compliance updates, government actions, or legal developments

## CASE TYPE CLASSIFICATION

Also classify the urgency as ONE integer (caseType):
- **1** (Actively Exploited): vulnerability/threat known to be exploited in the wild. CISA KEV listed, PoC exploits available, or confirmed active campaigns.
- **2** (Vulnerable, No Known Exploit): vulnerability/exposure exists but no active exploitation confirmed yet. Patch available or pending.
- **3** (Fixed): issue patched/resolved. Post-incident update or patch confirmation.
- **4** (Not Applicable): informational — research, policy, general threat intel with no specific vulnerability lifecycle.

Rules:
- VULNERABILITY → 1, 2, or 3 based on exploitation status
- INCIDENT → 1 if active attack, 3 if post-incident retrospective
- THREAT_INTEL → 1 if active campaign, 4 if general analysis
- RESEARCH → 4 unless active exploitation demonstrated (then 1)
- POLICY → always 4

## SECTIONS

1. TITLE: A clear, concise headline (max 15 words)

2. SYNOPSIS: What happened, who is involved, when. Narrative paragraph (3-5 sentences).

3. EXECUTIVE_SUMMARY: 5-10 bullet points of key facts. Format as markdown bulleted list.

4. IMPACT_ANALYSIS: Adapt based on story type:

   **If VULNERABILITY:**
   - Affected versions (e.g., "Apache 2.4.49 through 2.4.51")
   - Fixed version (e.g., "Upgrade to Apache 2.4.52")
   - CVE IDs and CVSS score if available
   - Who is affected (which products, sectors, organizations)

   **If INCIDENT:**
   - Who was targeted and what was compromised
   - Scale of impact (users affected, data exposed, systems breached)
   - Attack vector and techniques used
   - Industries/sectors at risk

   **If THREAT_INTEL:**
   - Threat actor profile and motivation
   - Tactics, techniques, and procedures (TTPs)
   - Targeted sectors and geographies
   - Known indicators of compromise (IOCs)

   **If RESEARCH:**
   - What the research demonstrates or proves
   - Which systems/technologies are affected
   - Real-world applicability and risk level
   - Current exploitation status (theoretical vs. in-the-wild)

   **If POLICY:**
   - What changed and who enacted it
   - Compliance implications and deadlines
   - Which organizations/sectors are affected

5. ACTIONABILITY: Adapt based on story type:

   **If VULNERABILITY — pick one sub-case:**
   Case 1 (Actively Exploited): Patch to [version] now, disable affected service, block IOCs, review logs, notify SOC
   Case 2 (No Exploit Yet): Schedule patch within SLA, monitor CISA KEV, add detection rule
   Case 3 (Fixed): Validate patch on all nodes, close risk ticket

   **If INCIDENT:**
   - Check if your org uses the affected service/vendor
   - Review your logs for listed IOCs
   - Verify your controls against the described attack vector
   - Brief leadership if in the affected sector

   **If THREAT_INTEL:**
   - Update threat models with the described TTPs
   - Deploy detection rules for listed IOCs
   - Review exposure to targeted technologies
   - Share with SOC for hunting

   **If RESEARCH:**
   - Assess if the described technique applies to your environment
   - No immediate patching action unless actively exploited
   - Monitor for real-world exploitation
   - Mark as reviewed for awareness

   **If POLICY:**
   - Review compliance gap against the new requirement
   - Brief legal/compliance team
   - Set deadline for required changes

State which story type and case applies, then list the specific action items. Use real names, versions, IOCs from the articles.

Base your analysis ONLY on the provided articles. Do not speculate.

Return JSON:
{
  "title": "...",
  "synopsis": "...",
  "executiveSummary": "- bullet 1\\n- bullet 2\\n...",
  "impactAnalysis": "...",
  "actionability": "...",
  "caseType": 4
}`,
        },
        {
          role: "user",
          content: `Group: ${input.groupTitle}

Entities detected:
${entitySummary || "None"}

Signals classified: ${signalSummary || "None"}

${combined}`,
        },
      ],
      max_tokens: 2500,
      temperature: 0.4,
    });

    const content = response.choices[0]?.message?.content?.trim();
    if (!content) {
      console.error(`[BriefingGenerator] Empty response for group "${input.groupTitle}"`);
      return null;
    }

    const parsed = JSON.parse(content) as GroupBriefing;

    // Validate caseType — default to 4 (not applicable) if missing or out of range
    if (!parsed.caseType || parsed.caseType < 1 || parsed.caseType > 4) {
      parsed.caseType = 4;
    }

    if (!parsed.title || !parsed.synopsis) {
      console.error(`[BriefingGenerator] Incomplete response for group "${input.groupTitle}"`);
      return null;
    }

    return parsed;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[BriefingGenerator] Error for group "${input.groupTitle}":`, message);
    return null;
  }
}
