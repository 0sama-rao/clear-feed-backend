import { PrismaClient } from "@prisma/client";
import { hashSync } from "bcryptjs";

const prisma = new PrismaClient();

async function main() {
  // ── Admin user ──
  const admin = await prisma.user.upsert({
    where: { email: "admin@clearfeed.com" },
    update: {},
    create: {
      email: "admin@clearfeed.com",
      password: hashSync("admin123", 10),
      name: "Admin",
      role: "ADMIN",
    },
  });
  console.log("Seeded admin user:", admin.email);

  // ── Cybersecurity Industry ──
  const cybersecurity = await prisma.industry.upsert({
    where: { slug: "cybersecurity" },
    update: {},
    create: {
      name: "Cybersecurity",
      slug: "cybersecurity",
      description:
        "Cybersecurity threat intelligence, vulnerabilities, data breaches, and industry developments",
    },
  });
  console.log("Seeded industry:", cybersecurity.name);

  // ── Industry Signals (Taxonomy) ──
  const signals = [
    { name: "Malware", slug: "malware", description: "Malware campaigns, ransomware, trojans, worms" },
    { name: "Data Breach", slug: "data-breach", description: "Data breaches, data leaks, unauthorized access to data" },
    { name: "Hacking", slug: "hacking", description: "Hacking campaigns, APT activity, intrusions" },
    { name: "Data Loss", slug: "data-loss", description: "Data loss incidents, accidental exposure" },
    { name: "Vulnerability", slug: "vulnerability", description: "CVEs, zero-days, software vulnerabilities" },
    { name: "Phishing", slug: "phishing", description: "Phishing campaigns, social engineering" },
    { name: "Ransomware", slug: "ransomware", description: "Ransomware attacks, extortion" },
    { name: "DDoS", slug: "ddos", description: "Distributed denial of service attacks" },
    { name: "Insider Threat", slug: "insider-threat", description: "Insider threat incidents" },
    { name: "Supply Chain", slug: "supply-chain", description: "Supply chain compromises, dependency attacks" },
    { name: "Nation State", slug: "nation-state", description: "Nation-state sponsored cyber operations" },
    { name: "Regulatory", slug: "regulatory", description: "Cybersecurity regulations, compliance, policy" },
    { name: "Patch / Update", slug: "patch-update", description: "Security patches, software updates" },
    { name: "Threat Intelligence", slug: "threat-intelligence", description: "Threat reports, IOCs, TTPs" },
    { name: "Cloud Security", slug: "cloud-security", description: "Cloud-specific security issues" },
    { name: "AI Security", slug: "ai-security", description: "AI/ML security threats, adversarial AI" },
  ];

  for (const signal of signals) {
    await prisma.industrySignal.upsert({
      where: {
        industryId_slug: {
          industryId: cybersecurity.id,
          slug: signal.slug,
        },
      },
      update: {},
      create: {
        industryId: cybersecurity.id,
        name: signal.name,
        slug: signal.slug,
        description: signal.description,
      },
    });
  }
  console.log(`Seeded ${signals.length} industry signals`);

  // ── Default Sources ──
  const defaultSources = [
    { name: "Krebs on Security", url: "https://krebsonsecurity.com/feed/", type: "RSS" as const },
    { name: "The Hacker News", url: "https://feeds.feedburner.com/TheHackersNews", type: "RSS" as const },
    { name: "BleepingComputer", url: "https://www.bleepingcomputer.com/feed/", type: "RSS" as const },
    { name: "Dark Reading", url: "https://www.darkreading.com/rss.xml", type: "RSS" as const },
    { name: "Threatpost", url: "https://threatpost.com/feed/", type: "RSS" as const },
    { name: "SecurityWeek", url: "https://www.securityweek.com/feed/", type: "RSS" as const },
    { name: "CISA Alerts", url: "https://www.cisa.gov/cybersecurity-advisories/all.xml", type: "RSS" as const },
    { name: "Schneier on Security", url: "https://www.schneier.com/feed/atom/", type: "RSS" as const },
    { name: "The Record by Recorded Future", url: "https://therecord.media/feed", type: "RSS" as const },
    { name: "Graham Cluley", url: "https://grahamcluley.com/feed/", type: "RSS" as const },
  ];

  for (const source of defaultSources) {
    await prisma.industryDefaultSource.upsert({
      where: {
        industryId_url: {
          industryId: cybersecurity.id,
          url: source.url,
        },
      },
      update: {},
      create: {
        industryId: cybersecurity.id,
        url: source.url,
        name: source.name,
        type: source.type,
      },
    });
  }
  console.log(`Seeded ${defaultSources.length} default sources`);

  // ── Default Keywords ──
  const defaultKeywords = [
    "ransomware", "malware", "zero-day", "CVE", "data breach",
    "phishing", "APT", "vulnerability", "exploit", "cyberattack",
    "threat actor", "DDoS", "supply chain attack", "credential",
    "backdoor", "encryption", "firewall", "endpoint",
  ];

  for (const word of defaultKeywords) {
    await prisma.industryDefaultKeyword.upsert({
      where: {
        industryId_word: {
          industryId: cybersecurity.id,
          word,
        },
      },
      update: {},
      create: {
        industryId: cybersecurity.id,
        word,
      },
    });
  }
  console.log(`Seeded ${defaultKeywords.length} default keywords`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
