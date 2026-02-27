/**
 * Static catalog of common cybersecurity-relevant products.
 * Vendor and product names match NVD CPE naming conventions.
 */

export interface CatalogEntry {
  vendor: string;
  product: string;
  category: string;
  displayName: string;
}

export const TECH_CATALOG: CatalogEntry[] = [
  // ── Edge / Perimeter Devices ──
  { vendor: "paloaltonetworks", product: "pan-os", category: "EDGE_DEVICE", displayName: "Palo Alto PAN-OS" },
  { vendor: "fortinet", product: "fortios", category: "EDGE_DEVICE", displayName: "Fortinet FortiOS" },
  { vendor: "fortinet", product: "fortigate", category: "EDGE_DEVICE", displayName: "Fortinet FortiGate" },
  { vendor: "ivanti", product: "connect_secure", category: "EDGE_DEVICE", displayName: "Ivanti Connect Secure" },
  { vendor: "ivanti", product: "policy_secure", category: "EDGE_DEVICE", displayName: "Ivanti Policy Secure" },
  { vendor: "citrix", product: "netscaler_adc", category: "EDGE_DEVICE", displayName: "Citrix NetScaler ADC" },
  { vendor: "citrix", product: "netscaler_gateway", category: "EDGE_DEVICE", displayName: "Citrix NetScaler Gateway" },
  { vendor: "sonicwall", product: "sonicos", category: "EDGE_DEVICE", displayName: "SonicWall SonicOS" },
  { vendor: "f5", product: "big-ip_access_policy_manager", category: "EDGE_DEVICE", displayName: "F5 BIG-IP APM" },
  { vendor: "barracuda", product: "email_security_gateway", category: "EDGE_DEVICE", displayName: "Barracuda ESG" },
  { vendor: "zyxel", product: "zywall", category: "EDGE_DEVICE", displayName: "Zyxel ZyWALL" },

  // ── Network ──
  { vendor: "cisco", product: "ios_xe", category: "NETWORK", displayName: "Cisco IOS XE" },
  { vendor: "cisco", product: "ios", category: "NETWORK", displayName: "Cisco IOS" },
  { vendor: "cisco", product: "adaptive_security_appliance_software", category: "NETWORK", displayName: "Cisco ASA" },
  { vendor: "cisco", product: "firepower_threat_defense", category: "NETWORK", displayName: "Cisco Firepower" },
  { vendor: "juniper", product: "junos", category: "NETWORK", displayName: "Juniper Junos OS" },
  { vendor: "arista", product: "eos", category: "NETWORK", displayName: "Arista EOS" },

  // ── Operating Systems ──
  { vendor: "microsoft", product: "windows_10", category: "OS", displayName: "Microsoft Windows 10" },
  { vendor: "microsoft", product: "windows_11", category: "OS", displayName: "Microsoft Windows 11" },
  { vendor: "microsoft", product: "windows_server_2019", category: "OS", displayName: "Windows Server 2019" },
  { vendor: "microsoft", product: "windows_server_2022", category: "OS", displayName: "Windows Server 2022" },
  { vendor: "linux", product: "linux_kernel", category: "OS", displayName: "Linux Kernel" },
  { vendor: "canonical", product: "ubuntu_linux", category: "OS", displayName: "Ubuntu Linux" },
  { vendor: "redhat", product: "enterprise_linux", category: "OS", displayName: "Red Hat Enterprise Linux" },
  { vendor: "apple", product: "macos", category: "OS", displayName: "Apple macOS" },
  { vendor: "apple", product: "iphone_os", category: "OS", displayName: "Apple iOS" },

  // ── Applications ──
  { vendor: "microsoft", product: "exchange_server", category: "APPLICATION", displayName: "Microsoft Exchange Server" },
  { vendor: "microsoft", product: "outlook", category: "APPLICATION", displayName: "Microsoft Outlook" },
  { vendor: "microsoft", product: "office", category: "APPLICATION", displayName: "Microsoft Office" },
  { vendor: "microsoft", product: "sharepoint_server", category: "APPLICATION", displayName: "Microsoft SharePoint" },
  { vendor: "apache", product: "http_server", category: "APPLICATION", displayName: "Apache HTTP Server" },
  { vendor: "apache", product: "tomcat", category: "APPLICATION", displayName: "Apache Tomcat" },
  { vendor: "apache", product: "log4j", category: "LIBRARY", displayName: "Apache Log4j" },
  { vendor: "nginx", product: "nginx", category: "APPLICATION", displayName: "Nginx" },
  { vendor: "atlassian", product: "confluence_server", category: "APPLICATION", displayName: "Atlassian Confluence" },
  { vendor: "atlassian", product: "jira", category: "APPLICATION", displayName: "Atlassian Jira" },
  { vendor: "gitlab", product: "gitlab", category: "APPLICATION", displayName: "GitLab" },
  { vendor: "jenkins", product: "jenkins", category: "APPLICATION", displayName: "Jenkins" },
  { vendor: "progress", product: "moveit_transfer", category: "APPLICATION", displayName: "MOVEit Transfer" },
  { vendor: "sap", product: "netweaver", category: "APPLICATION", displayName: "SAP NetWeaver" },

  // ── Cloud ──
  { vendor: "vmware", product: "vcenter_server", category: "CLOUD", displayName: "VMware vCenter Server" },
  { vendor: "vmware", product: "esxi", category: "CLOUD", displayName: "VMware ESXi" },
  { vendor: "hashicorp", product: "terraform", category: "CLOUD", displayName: "HashiCorp Terraform" },
  { vendor: "kubernetes", product: "kubernetes", category: "CLOUD", displayName: "Kubernetes" },
  { vendor: "docker", product: "docker", category: "CLOUD", displayName: "Docker" },

  // ── Identity ──
  { vendor: "microsoft", product: "active_directory", category: "IDENTITY", displayName: "Microsoft Active Directory" },
  { vendor: "okta", product: "okta", category: "IDENTITY", displayName: "Okta" },
  { vendor: "cyberark", product: "privileged_access_manager", category: "IDENTITY", displayName: "CyberArk PAM" },

  // ── Database ──
  { vendor: "microsoft", product: "sql_server", category: "DATABASE", displayName: "Microsoft SQL Server" },
  { vendor: "oracle", product: "database_server", category: "DATABASE", displayName: "Oracle Database" },
  { vendor: "postgresql", product: "postgresql", category: "DATABASE", displayName: "PostgreSQL" },
  { vendor: "mysql", product: "mysql", category: "DATABASE", displayName: "MySQL" },
  { vendor: "mongodb", product: "mongodb", category: "DATABASE", displayName: "MongoDB" },

  // ── Libraries / Frameworks ──
  { vendor: "openssl", product: "openssl", category: "LIBRARY", displayName: "OpenSSL" },
  { vendor: "nodejs", product: "node.js", category: "LIBRARY", displayName: "Node.js" },
  { vendor: "python", product: "python", category: "LIBRARY", displayName: "Python" },
  { vendor: "spring", product: "spring_framework", category: "LIBRARY", displayName: "Spring Framework" },
];

/**
 * Search the catalog by query string (matches displayName, vendor, or product).
 */
export function searchCatalog(query: string, category?: string): CatalogEntry[] {
  const q = query.toLowerCase();
  return TECH_CATALOG.filter((entry) => {
    if (category && entry.category !== category) return false;
    return (
      entry.displayName.toLowerCase().includes(q) ||
      entry.vendor.toLowerCase().includes(q) ||
      entry.product.toLowerCase().includes(q)
    );
  });
}

/**
 * Filter catalog by category.
 */
export function getCatalogByCategory(category: string): CatalogEntry[] {
  return TECH_CATALOG.filter((entry) => entry.category === category);
}
