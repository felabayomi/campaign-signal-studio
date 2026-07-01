import { useEffect, useMemo, useState } from "react";
import type { FormEvent, ReactElement } from "react";
import { Link, Navigate, Route, Routes, useNavigate, useSearchParams } from "react-router-dom";

type User = {
  id: number;
  name?: string;
  email: string;
  organizationId: number;
  orgName: string;
  role: TeamRole;
};

type TeamRole = "owner" | "admin" | "manager" | "contributor" | "viewer";

type CampaignProfile = {
  raceName: string;
  officeType: string;
  location: string;
  electionDate: string;
  incumbent: string;
  budgetBand: string;
  objective: string;
  audience: string;
  contextNotes: string;
};

type SignalReport = {
  id: number;
  organizationId: number;
  campaignId: number;
  createdBy?: number;
  userId: number;
  createdAt: string;
  title: string;
  confidence: "High" | "Medium" | "Low";

  raceSnapshot: string;
  opponentWatch: string;
  messageMemo: string;

  contentIdeas: string[];
  videoAngles: string[];
  quoteGraphics: string[];
  fundraisingCaptions: string[];
  rapidResponsePlan: string[];

  intelligenceSources?: {
    userProvidedContext: boolean;
    electionPredictorUsed: boolean;
    matchedRaces: string[];
    categoriesUsed: string[];
    lastCheckedAt: string;
  } | null;
  complianceNote: string;

  // Backward-compatible legacy fields.
  summary?: string;
  keySignals?: string[];
  actions?: string[];
  legacyIntelligenceSources?: {
    usedElectionPredictor: boolean;
    matchingRaceName: string | null;
    raceContext: string | null;
    contextCategories: string[];
    sourceLines: string[];
    lastChecked: string | null;
    lastCheckedLabel: string | null;
    confidenceLevel: "High" | "Medium" | "Low";
  } | null;
};

type CampaignRecord = CampaignProfile & {
  id: number;
  organizationId: number;
  userId: number;
  createdAt: string;
  updatedAt: string;
};

type OrganizationSummary = {
  id: number;
  name: string;
  organizationType?: string;
  capabilities?: {
    basicTemplates: boolean;
    advancedTemplates: boolean;
    deepIntelligence: boolean;
    pdfExport: boolean;
    contentCalendar: boolean;
    prioritySupport: boolean;
    fullTeamAdmin: boolean;
    fullBillingAdmin: boolean;
  };
  supportAccessEnabled: boolean;
  workspaceModel?: string;
  billingPlan?: string;
  billingStatus?: string;
  trialStatus?: string;
  trialStartedAt?: string | null;
  trialEndsAt?: string | null;
  accessState?: string;
  hasPremiumAccess?: boolean;
  isSubscribed?: boolean;
  isTrialActive?: boolean;
  trialDaysRemaining?: number;
  reportLimitWindow?: "total" | "monthly";
  reportLimit?: number;
  userLimit?: number;
  workspaceLimit?: number;
  usage?: {
    reportsUsed: number;
    reportsLimit: number;
    reportsWindow: "total" | "monthly";
    campaignsUsed: number;
    campaignLimit: number;
    usersUsed: number;
    userLimit: number;
  };
  createdAt: string;
};

type OrganizationStats = {
  campaignCount: number;
  reportCount: number;
  userCount: number;
};

type TeamMember = {
  id: number;
  organizationId: number;
  userId: number;
  email: string;
  role: TeamRole;
  status: string;
  createdAt: string;
};

type TeamInvite = {
  id: number;
  organizationId: number;
  email: string;
  role: TeamRole;
  token: string;
  status: "pending" | "accepted" | "expired" | "revoked";
  optionalMessage?: string | null;
  invitedBy: number;
  expiresAt: string;
  acceptedAt?: string | null;
  createdAt: string;
  acceptLink: string;
};

type TeamActivity = {
  id: number;
  organizationId: number;
  actorUserId: number;
  actorEmail: string | null;
  action: string;
  targetUserId?: number | null;
  targetEmail?: string | null;
  details?: Record<string, unknown> | null;
  createdAt: string;
};

const roles: TeamRole[] = ["owner", "admin", "manager", "contributor", "viewer"];

const roleHelpText: Record<TeamRole, string> = {
  owner: "Owner: Full workspace and billing control.",
  admin: "Admin: Manages team, campaigns, reports, and support access.",
  manager: "Manager: Runs campaign profiles and report workflows.",
  contributor: "Contributor: Creates and views reports.",
  viewer: "Viewer: Read-only access.",
};

const roleClientPermissions: Record<TeamRole, string[]> = {
  owner: [
    "billing.manage",
    "team.manage",
    "campaign.manage",
    "campaign.view",
    "reports.generate",
    "reports.view",
    "reports.delete",
    "support.enable",
    "usage.view",
  ],
  admin: [
    "team.manage",
    "campaign.manage",
    "campaign.view",
    "reports.generate",
    "reports.view",
    "reports.delete",
    "support.enable",
    "usage.view",
  ],
  manager: [
    "campaign.manage",
    "campaign.view",
    "reports.generate",
    "reports.view",
    "usage.view",
  ],
  contributor: ["reports.generate", "reports.view", "campaign.view"],
  viewer: ["reports.view", "campaign.view"],
};

const emptyProfile: CampaignProfile = {
  raceName: "",
  officeType: "Senate",
  location: "",
  electionDate: "",
  incumbent: "",
  budgetBand: "$100k-$500k",
  objective: "Win primary",
  audience: "Base + persuadables",
  contextNotes: "",
};

function useLocalState<T>(key: string, fallback: T): [T, (value: T) => void] {
  const initial = (() => {
    const stored = localStorage.getItem(key);
    if (!stored) return fallback;
    try {
      return JSON.parse(stored) as T;
    } catch {
      return fallback;
    }
  })();

  const [state, setState] = useState<T>(initial);

  const persist = (value: T) => {
    setState(value);
    localStorage.setItem(key, JSON.stringify(value));
  };

  return [state, persist];
}

async function apiRequest<T>(
  path: string,
  options: RequestInit = {},
  user?: User | null,
): Promise<T> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };

  if (options.headers) {
    Object.assign(headers, options.headers as Record<string, string>);
  }

  if (user) {
    headers["x-user-id"] = String(user.id);
    headers["x-org-id"] = String(user.organizationId);
  }

  const response = await fetch(path, {
    ...options,
    headers,
  });

  const payload = await response.json();
  if (!response.ok) {
    if (payload?.error === "UPGRADE_REQUIRED" && payload?.message) {
      throw new Error(payload.message);
    }
    throw new Error(payload.message || payload.error || "Request failed");
  }

  return payload as T;
}

function TopNav({ user, onLogout }: { user: User | null; onLogout: () => void }) {
  return (
    <header className="top-nav">
      <div className="container nav-inner">
        <Link to="/" className="brand">Campaign Signal Studio</Link>
        <nav>
          <Link to="/">Product</Link>
          <Link to="/pricing">Pricing</Link>
          <Link to="/support">Support</Link>
          {user ? <Link to="/workspace">Workspace</Link> : <Link to="/login">Login</Link>}
          {!user && <Link to="/signup" className="btn-primary nav-cta">Start Free Trial</Link>}
          {user && <Link to="/organization">Organization</Link>}
          {user && <button onClick={onLogout} className="ghost">Logout</button>}
        </nav>
      </div>
    </header>
  );
}

function LandingPage() {
  return (
    <main className="container page">
      <section className="hero">
        <article>
          <span className="badge">Campaign Intelligence Platform</span>
          <h1>Self-Serve Campaign Intelligence for Political Teams</h1>
          <p>
            Campaign Signal Studio helps campaigns, PACs, consultants, and advocacy groups turn speeches,
            debates, press releases, news, and opponent activity into message memos, content ideas, video angles,
            and rapid-response plans.
          </p>
          <div className="row">
            <Link to="/signup" className="btn-primary">Start Free Trial</Link>
            <Link to="/workspace" className="btn-secondary">Build Sample Report</Link>
          </div>
          <p className="trust-line">Private workspaces. Team roles. Saved reports. Built for campaign speed.</p>
        </article>

        <article className="card report-preview">
          <h3>Campaign Signal Report</h3>
          <div className="preview-section">
            <h4>Race Snapshot</h4>
            <p>Housing affordability is emerging as the clearest contrast issue this week.</p>
          </div>
          <div className="preview-section">
            <h4>Opponent Watch</h4>
            <p>Monitor responses around tax increases and development approvals.</p>
          </div>
          <div className="preview-section">
            <h4>Message Opportunities</h4>
            <p>Position the candidate around practical affordability, local control, and family stability.</p>
          </div>
          <div className="preview-section">
            <h4>Content Ideas</h4>
            <ol>
              <li>30-second town hall clip</li>
              <li>Quote graphic on housing pressure</li>
              <li>Contrast post on affordability plan</li>
            </ol>
          </div>
        </article>
      </section>

      <section className="card muted">
        <h2>Campaign teams lose time turning moments into usable content.</h2>
        <div className="grid two compact-grid">
          <article className="card">
            <p>Speeches stay buried in long videos.</p>
          </article>
          <article className="card">
            <p>Opponent attacks move faster than response drafts.</p>
          </article>
          <article className="card">
            <p>Staff waste time starting every memo from scratch.</p>
          </article>
          <article className="card">
            <p>Consultants need repeatable workflows across races.</p>
          </article>
        </div>
      </section>

      <section className="card">
        <h2>From raw campaign context to ready-to-use direction.</h2>
        <ol>
          <li>Add campaign context: Enter race, candidate, opponent, issue, and audience.</li>
          <li>Paste the moment: Drop in a speech, debate answer, news item, press release, or opponent attack.</li>
          <li>Generate the signal: Get a memo, content angles, video ideas, quote graphics, and response plan.</li>
          <li>Save and share: Keep reports inside your private organization workspace.</li>
        </ol>
      </section>

      <section className="card">
        <h2>Built for campaign teams, not generic content creation.</h2>
        <div className="grid three compact-grid">
          <article className="card"><p>Private organization workspaces</p></article>
          <article className="card"><p>Team roles and permissions</p></article>
          <article className="card"><p>Campaign Signal Reports</p></article>
          <article className="card"><p>Saved report history</p></article>
          <article className="card"><p>Organization Console</p></article>
          <article className="card"><p>Intelligence Sources block</p></article>
          <article className="card"><p>Support access toggle</p></article>
          <article className="card"><p>ElectionPredictor background intelligence, optional</p></article>
        </div>
      </section>

      <section className="card">
        <h2>Start with the plan that fits your team.</h2>
        <section className="grid three">
          <article className="card">
            <h3>Starter</h3>
            <p>$99/mo</p>
          </article>
          <article className="card featured">
            <h3>Professional</h3>
            <p>$299/mo</p>
          </article>
          <article className="card">
            <h3>Consultant</h3>
            <p>$799/mo</p>
          </article>
        </section>
      </section>

      <section className="card muted">
        <h2>Your team stays in control.</h2>
        <p>
          Campaign Signal Studio provides content planning and message-assist tools. Campaign teams are responsible for reviewing, approving, publishing, and complying with applicable election laws, platform rules, and disclaimer requirements.
        </p>
        <p className="muted-text">
          Campaign Signal Studio is a subscription software platform for campaign teams, PACs,
          consultants, and advocacy groups.
        </p>
      </section>

      <section className="card final-cta">
        <h2>Build your first Campaign Signal Report.</h2>
        <div className="row">
          <Link to="/signup" className="btn-primary">Start Free Trial</Link>
          <Link to="/workspace" className="btn-secondary">Build Sample Report</Link>
        </div>
      </section>
    </main>
  );
}

function AuthPage({ onAuth, mode }: { onAuth: (u: User) => void; mode: "login" | "signup" }) {
  const nav = useNavigate();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [orgName, setOrgName] = useState("");
  const [organizationType, setOrganizationType] = useState("Campaign");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const orgTypeOptions = ["Campaign", "PAC", "Consultant", "Advocacy Group", "Other"];

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setPending(true);

    try {
      const endpoint = mode === "signup" ? "/api/auth/signup" : "/api/auth/login";
      const data = await apiRequest<{ user: User }>(endpoint, {
        method: "POST",
        body: JSON.stringify({
          name: name.trim(),
          email: email.trim(),
          orgName: orgName.trim(),
          organizationType,
          password: password.trim(),
        }),
      });

      onAuth(data.user);
      nav("/workspace");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Authentication failed");
    } finally {
      setPending(false);
    }
  };

  return (
    <main className="container page narrow">
      <section className="card">
        <h1>{mode === "signup" ? "Create trial account" : "Login"}</h1>
        <p className="muted-text">Start your workspace trial and unlock team reporting workflows.</p>
        <form onSubmit={submit} className="stack">
          {mode === "signup" && (
            <label>
              Name
              <input value={name} onChange={(e) => setName(e.target.value)} required />
            </label>
          )}
          <label>
            Email
            <input value={email} onChange={(e) => setEmail(e.target.value)} type="email" required />
          </label>
          <label>
            Organization
            <input value={orgName} onChange={(e) => setOrgName(e.target.value)} placeholder="Signal for Senate 2028" required />
          </label>
          {mode === "signup" && (
            <label>
              Organization type
              <select value={organizationType} onChange={(e) => setOrganizationType(e.target.value)} required>
                {orgTypeOptions.map((opt) => (
                  <option key={opt} value={opt}>{opt}</option>
                ))}
              </select>
            </label>
          )}
          <label>
            Password
            <input value={password} onChange={(e) => setPassword(e.target.value)} type="password" required />
          </label>
          {error && <p className="error-banner">{error}</p>}
          <button type="submit" className="cta" disabled={pending}>
            {pending ? "Submitting..." : mode === "signup" ? "Create Workspace" : "Enter Workspace"}
          </button>
        </form>
      </section>
    </main>
  );
}

function AcceptInvitePage({ onAuth }: { onAuth: (u: User) => void }) {
  const [searchParams] = useSearchParams();
  const nav = useNavigate();
  const token = searchParams.get("token") || "";
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const acceptInvite = async (e: FormEvent) => {
    e.preventDefault();
    if (!token) {
      setError("Missing invite token.");
      return;
    }

    setPending(true);
    setError(null);

    try {
      const data = await apiRequest<{ user: User }>(`/api/team/invites/${token}/accept`, {
        method: "POST",
        body: JSON.stringify({
          email: email.trim(),
          password: password.trim(),
        }),
      });
      onAuth(data.user);
      nav("/workspace");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to accept invite");
    } finally {
      setPending(false);
    }
  };

  return (
    <main className="container page narrow">
      <section className="card">
        <h1>Accept Team Invite</h1>
        <p className="muted-text">Create your login to join the organization workspace.</p>
        <form className="stack" onSubmit={acceptInvite}>
          <label>
            Email
            <input value={email} onChange={(e) => setEmail(e.target.value)} type="email" required />
          </label>
          <label>
            Password
            <input value={password} onChange={(e) => setPassword(e.target.value)} type="password" required />
          </label>
          {error && <p className="error-banner">{error}</p>}
          <button className="cta" type="submit" disabled={pending}>{pending ? "Joining..." : "Accept Invite"}</button>
        </form>
      </section>
    </main>
  );
}

function Workspace({
  user,
}: {
  user: User;
}) {
  const planBenefits: Record<string, { title: string; subtitle: string; items: string[] }> = {
    starter: {
      title: "Starter - $99/month",
      subtitle: "For small campaigns.",
      items: [
        "1 organization",
        "1 campaign",
        "5 users",
        "25 signal reports/month",
        "Saved reports",
        "Copy/download reports",
        "Basic templates",
        "Email support",
      ],
    },
    professional: {
      title: "Professional - $299/month",
      subtitle: "Best default plan.",
      items: [
        "1 organization",
        "Unlimited campaigns",
        "25 users",
        "150 signal reports/month",
        "Saved reports",
        "Organization Console",
        "Team roles",
        "Support access toggle",
        "Advanced templates",
        "Priority email support",
      ],
    },
    consultant: {
      title: "Consultant - $799/month",
      subtitle: "For consultants or firms.",
      items: [
        "5 client workspaces",
        "50 users",
        "500 signal reports/month",
        "Client folders",
        "Reusable templates",
        "Usage dashboard",
        "Training session included",
        "Priority support",
      ],
    },
  };
  const basicTemplates = [
    {
      id: "rapid-response",
      label: "Basic: Rapid Response",
      objective: "Rapid response",
      audience: "Undecideds + base",
      context: "Opponent attack response template:\n1) Core rebuttal\n2) Local proof points\n3) 24-hour content sequence\n4) Volunteer talking points",
    },
    {
      id: "issue-contrast",
      label: "Basic: Issue Contrast",
      objective: "Issue contrast",
      audience: "Persuadable voters",
      context: "Issue contrast template:\n- Our position\n- Opponent position\n- Practical voter impact\n- 3 short-form message angles",
    },
    {
      id: "fundraising-push",
      label: "Basic: Fundraising Push",
      objective: "Increase small-dollar conversion",
      audience: "Supporters + likely donors",
      context: "Fundraising template:\n- Urgency hook\n- Proof of momentum\n- Donation CTA variants\n- Follow-up email cadence",
    },
  ] as const;
  const advancedTemplates = [
    {
      id: "war-room-sequence",
      label: "Advanced: War Room Sequence",
      objective: "Multi-channel response orchestration",
      audience: "Coalition segments",
      context: "Advanced template placeholder for paid plans.",
    },
    {
      id: "district-segmentation",
      label: "Advanced: District Segmentation",
      objective: "Segmented persuasion rollout",
      audience: "District clusters",
      context: "Advanced template placeholder for paid plans.",
    },
  ] as const;
  const [profile, setProfile] = useState<CampaignProfile>(emptyProfile);
  const [campaignId, setCampaignId] = useState<number | null>(null);
  const [reports, setReports] = useState<SignalReport[]>([]);
  const [templateId, setTemplateId] = useState<string>(basicTemplates[0].id);
  const [contextInput, setContextInput] = useState("");
  const [loading, setLoading] = useState(true);
  const [savingCampaign, setSavingCampaign] = useState(false);
  const [generatingReport, setGeneratingReport] = useState(false);
  const [organizationSummary, setOrganizationSummary] = useState<OrganizationSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [dismissSoftPrompt, setDismissSoftPrompt] = useState(false);
  const [showUpgradeModal, setShowUpgradeModal] = useState(false);
  const latestReport = useMemo(() => reports[0] ?? null, [reports]);
  const permissions = useMemo(() => new Set(roleClientPermissions[user.role || "owner"] || []), [user.role]);
  const canManageCampaign = permissions.has("campaign.manage");
  const canGenerateReports = permissions.has("reports.generate");
  const canDeleteReports = permissions.has("reports.delete");
  const hasPremiumAccess = organizationSummary?.hasPremiumAccess ?? true;
  const isTrialActive = organizationSummary?.isTrialActive ?? false;
  const isSubscribed = organizationSummary?.isSubscribed ?? false;
  const canUseAdvancedTemplates = organizationSummary?.capabilities?.advancedTemplates ?? isSubscribed;
  const canUseAdvancedExport = organizationSummary?.capabilities?.pdfExport ?? isSubscribed;
  const reportsUsed = organizationSummary?.usage?.reportsUsed ?? reports.length;
  const reportLimit = organizationSummary?.usage?.reportsLimit ?? organizationSummary?.reportLimit ?? 0;
  const reportWindow = organizationSummary?.usage?.reportsWindow ?? organizationSummary?.reportLimitWindow ?? "monthly";
  const campaignsUsed = organizationSummary?.usage?.campaignsUsed ?? 0;
  const campaignLimit = organizationSummary?.usage?.campaignLimit ?? organizationSummary?.workspaceLimit ?? 0;
  const usersUsed = organizationSummary?.usage?.usersUsed ?? 0;
  const userLimit = organizationSummary?.usage?.userLimit ?? organizationSummary?.userLimit ?? 0;
  const usagePercent = reportLimit > 0 ? Math.min(100, Math.round((reportsUsed / reportLimit) * 100)) : 0;
  const reportLimitReached = reportLimit > 0 && reportsUsed >= reportLimit;
  const campaignLimitReached = campaignLimit > 0 && campaignsUsed >= campaignLimit;
  const userLimitReached = userLimit > 0 && usersUsed >= userLimit;
  const anyLimitReached = reportLimitReached || campaignLimitReached || userLimitReached;
  const activePlanKey = String(organizationSummary?.billingPlan || "").toLowerCase();
  const activePlanBenefits = planBenefits[activePlanKey];
  const showSoftUpgradePrompt = isTrialActive && reportsUsed === 1 && !dismissSoftPrompt;
  const showStrongUpgradePrompt = isTrialActive && reportsUsed === 3;
  const showHardUpgradePrompt = isTrialActive && reportsUsed >= 5;
  const trialExpired = !isTrialActive && !isSubscribed;
  const showUpgradeLink = (error && /(trial limit reached|upgrade|active subscription|trial has expired|expired|paid plans|professional|consultant)/i.test(error)) || false;

  useEffect(() => {
    if (reportsUsed !== 1 && dismissSoftPrompt) {
      setDismissSoftPrompt(false);
    }
  }, [reportsUsed, dismissSoftPrompt]);

  useEffect(() => {
    if (showStrongUpgradePrompt) {
      setShowUpgradeModal(true);
    }
  }, [showStrongUpgradePrompt, showHardUpgradePrompt]);

  const selectedBasicTemplate = basicTemplates.find((t) => t.id === templateId) || basicTemplates[0];

  const applyTemplate = () => {
    setProfile((prev) => ({
      ...prev,
      objective: selectedBasicTemplate.objective,
      audience: selectedBasicTemplate.audience,
    }));
    setContextInput(selectedBasicTemplate.context);
    setStatus(`${selectedBasicTemplate.label} applied.`);
    setError(null);
  };

  const buildReportText = (report: SignalReport) => {
    const lines = [
      report.title,
      "",
      `Confidence: ${report.confidence}`,
      "",
      "Race Snapshot:",
      report.raceSnapshot,
      "",
      "Opponent Watch:",
      report.opponentWatch,
      "",
      "Message Memo:",
      report.messageMemo,
      "",
      "Content Ideas:",
      ...report.contentIdeas.map((s) => `- ${s}`),
      "",
      "Video Angles:",
      ...report.videoAngles.map((s) => `- ${s}`),
      "",
      "Quote Graphics:",
      ...report.quoteGraphics.map((s) => `- ${s}`),
      "",
      "Fundraising Captions:",
      ...report.fundraisingCaptions.map((s) => `- ${s}`),
      "",
      "Rapid-Response Plan:",
      ...report.rapidResponsePlan.map((a) => `- ${a}`),
      "",
      "Compliance Note:",
      report.complianceNote,
    ];
    return lines.join("\n");
  };

  const copyLatestReportText = async () => {
    if (!latestReport) return;
    try {
      await navigator.clipboard.writeText(buildReportText(latestReport));
      setStatus("Report text copied to clipboard.");
    } catch {
      setError("Failed to copy report text.");
    }
  };

  const downloadLatestReportText = () => {
    if (!latestReport) return;
    const blob = new Blob([buildReportText(latestReport)], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `signal-report-${latestReport.id}.txt`;
    link.click();
    URL.revokeObjectURL(url);
    setStatus("Report text download started.");
  };

  const exportLatestReportPdf = () => {
    if (!latestReport) return;

    if (isTrialActive || !canUseAdvancedExport) {
      setError("Export PDF/brand-ready reports is available on paid plans. Upgrade to unlock this export.");
      setStatus(null);
      setShowUpgradeModal(true);
      return;
    }

    setError(null);
    setStatus("Advanced PDF/brand-ready export placeholder started.");
  };

  const refreshOrganizationSummary = async () => {
    try {
      const data = await apiRequest<{ organization: OrganizationSummary }>("/api/organization", {}, user);
      setOrganizationSummary(data.organization);
    } catch {
      // Ignore refresh failures; existing UI state remains.
    }
  };

  useEffect(() => {
    let active = true;

    const loadWorkspace = async () => {
      setLoading(true);
      setError(null);

      try {
        const [campaignData, reportData, organizationData] = await Promise.all([
          apiRequest<{ campaigns: CampaignRecord[] }>("/api/campaigns", {}, user),
          apiRequest<{ reports: SignalReport[] }>("/api/reports", {}, user),
          apiRequest<{ organization: OrganizationSummary }>("/api/organization", {}, user),
        ]);

        if (!active) return;

        if (campaignData.campaigns.length > 0) {
          const latestCampaign = campaignData.campaigns[0];
          setCampaignId(latestCampaign.id);
          setProfile({
            raceName: latestCampaign.raceName,
            officeType: latestCampaign.officeType || "Senate",
            location: latestCampaign.location,
            electionDate: latestCampaign.electionDate,
            incumbent: latestCampaign.incumbent,
            budgetBand: latestCampaign.budgetBand || "$100k-$500k",
            objective: latestCampaign.objective || "Win primary",
            audience: latestCampaign.audience || "Base + persuadables",
            contextNotes: latestCampaign.contextNotes,
          });
          setContextInput(latestCampaign.contextNotes || "");
        }

        setReports(reportData.reports);
        setOrganizationSummary(organizationData.organization);
      } catch (err) {
        if (!active) return;
        setError(err instanceof Error ? err.message : "Failed to load workspace");
      } finally {
        if (active) {
          setLoading(false);
        }
      }
    };

    void loadWorkspace();
    return () => {
      active = false;
    };
  }, [user]);

  const updateProfile = <K extends keyof CampaignProfile>(field: K, value: CampaignProfile[K]) => {
    setProfile({ ...profile, [field]: value });
  };

  const startNewCampaignDraft = () => {
    if (!canManageCampaign) {
      setError("Your role is read-only for campaign editing.");
      return;
    }

    setCampaignId(null);
    setProfile(emptyProfile);
    setContextInput("");
    setStatus("New campaign draft started. Save to create another campaign workspace.");
    setError(null);
  };

  const saveCampaign = async (): Promise<number> => {
    if (!canManageCampaign) {
      setError("Your role is read-only for campaign editing.");
      throw new Error("Permission denied");
    }

    setSavingCampaign(true);
    setError(null);
    setStatus(null);

    try {
      const data = await apiRequest<{ campaign: CampaignRecord }>(
        "/api/campaigns",
        {
          method: "POST",
          body: JSON.stringify({
            id: campaignId,
            ...profile,
            contextNotes: contextInput || profile.contextNotes,
          }),
        },
        user,
      );

      setCampaignId(data.campaign.id);
      setStatus("Campaign profile saved.");
      await refreshOrganizationSummary();
      return data.campaign.id;
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to save campaign profile";
      setError(message);
      throw err;
    } finally {
      setSavingCampaign(false);
    }
  };

  const generate = async () => {
    if (!canGenerateReports) {
      setError("Your role cannot generate reports.");
      return;
    }

    if (showHardUpgradePrompt) {
      setError("Trial report limit reached. Upgrade to continue generating campaign signal reports.");
      setStatus(null);
      setShowUpgradeModal(true);
      return;
    }

    setGeneratingReport(true);
    setError(null);
    setStatus(null);

    try {
      const targetCampaignId = await saveCampaign();
      const data = await apiRequest<{ report: SignalReport }>(
        "/api/reports/generate",
        {
          method: "POST",
          body: JSON.stringify({
            campaignId: targetCampaignId,
            contextNotes: contextInput,
          }),
        },
        user,
      );

      setReports([data.report, ...reports]);
      setStatus("Signal Report generated and saved.");
      await refreshOrganizationSummary();
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to generate Signal Report";
      if (/(trial limit reached|upgrade|active subscription|trial has expired|expired|paid plans|professional|consultant)/i.test(message)) {
        setShowUpgradeModal(true);
      }
    } finally {
      setGeneratingReport(false);
    }
  };

  const deleteCampaign = async () => {
    if (!campaignId) return;
    setError(null);
    setStatus(null);
    try {
      await apiRequest<{ ok: boolean }>(`/api/campaigns/${campaignId}`, { method: "DELETE" }, user);
      setCampaignId(null);
      setProfile(emptyProfile);
      setContextInput("");
      setReports([]);
      setStatus("Campaign and associated reports deleted.");
      await refreshOrganizationSummary();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete campaign");
    }
  };

  const deleteReport = async (reportId: number) => {
    setError(null);
    setStatus(null);
    try {
      await apiRequest<{ ok: boolean }>(`/api/reports/${reportId}`, { method: "DELETE" }, user);
      setReports((prev) => prev.filter((r) => r.id !== reportId));
      setStatus("Report deleted.");
      await refreshOrganizationSummary();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete report");
    }
  };

  if (loading) {
    return (
      <main className="container page">
        <section className="card">
          <h1>{user.orgName} Workspace</h1>
          <p className="muted-text">Loading workspace...</p>
        </section>
      </main>
    );
  }

  if (trialExpired) {
    return (
      <main className="container page">
        <section className="card">
          <h1>Your trial has ended</h1>
          <p>Choose a plan to continue using Campaign Signal Studio with your saved campaign profile and reports.</p>
          <div className="row" style={{ marginTop: "0.6rem" }}>
            <Link to="/pricing?plan=professional" className="cta">Upgrade Workspace</Link>
            <Link to="/pricing" className="ghost">View Pricing</Link>
          </div>
        </section>
      </main>
    );
  }

  return (
    <main className="container page">
      <section className="card">
        <h1>{user.orgName} Workspace</h1>
        {isTrialActive && (
          <div style={{ marginBottom: "0.75rem" }}>
            <p><strong>Trial Workspace</strong></p>
            <p>{reportLimit || 5} reports included</p>
            <p>{organizationSummary?.trialDaysRemaining || 0} days remaining</p>
            <p>Welcome to your Campaign Signal Studio trial.</p>
            <p>Build one campaign profile, generate up to 5 signal reports, and see how your team can turn campaign moments into message direction.</p>
            {anyLimitReached && (
              <p style={{ marginTop: "0.4rem" }}>
                <span style={{ display: "inline-block", background: "#b42318", color: "#fff", borderRadius: "999px", padding: "0.1rem 0.55rem", fontSize: "0.75rem", fontWeight: 700 }}>
                  Limit reached
                </span>
              </p>
            )}
            <Link to="/pricing" className="cta">Upgrade to Full Account</Link>
            <div style={{ marginTop: "0.75rem" }}>
              <p><strong>Progress checklist</strong></p>
              <ul className="muted-text" style={{ marginTop: "0.35rem" }}>
                <li>✓ Create campaign profile</li>
                <li>✓ Generate first signal report</li>
                <li>✓ Save or copy report</li>
                <li>✓ Invite teammate</li>
                <li>✓ Upgrade workspace</li>
              </ul>
            </div>
            <div style={{ marginTop: "0.75rem" }}>
              <p><strong>What They Can Do In Trial</strong></p>
              <ul className="muted-text" style={{ marginTop: "0.35rem" }}>
                <li>Create 1 organization workspace</li>
                <li>Create 1 campaign profile</li>
                <li>Invite 1 extra teammate</li>
                <li>Generate 5 campaign signal reports</li>
                <li>Save reports</li>
                <li>Copy reports</li>
                <li>Download text reports</li>
                <li>Use basic templates</li>
                <li>View Intelligence Sources block</li>
                <li>Access onboarding checklist</li>
              </ul>
            </div>
            <div style={{ marginTop: "0.75rem" }}>
              <p><strong>What They Cannot Do In Trial</strong></p>
              <ul className="muted-text" style={{ marginTop: "0.35rem" }}>
                <li>Create multiple campaigns</li>
                <li>Invite full team</li>
                <li>Use consultant/client workspaces</li>
                <li>Generate unlimited reports</li>
                <li>Export PDF/brand-ready reports</li>
                <li>Use advanced templates</li>
                <li>Use ElectionPredictor deep intelligence</li>
                <li>Use content calendar</li>
                <li>Use priority support</li>
                <li>Use billing/team admin features fully</li>
              </ul>
              <p className="muted-text" style={{ marginTop: "0.35rem" }}>Keep the trial useful, but clearly limited.</p>
            </div>
          </div>
        )}
        <p><strong>Role:</strong> {user.role}</p>
        {organizationSummary?.isSubscribed && <p><strong>Access:</strong> Active Subscription</p>}
        {organizationSummary?.isSubscribed && <p className="status-banner">Your workspace is now active.</p>}
        {!organizationSummary?.isSubscribed && !organizationSummary?.isTrialActive && <p><strong>Access:</strong> Inactive (subscription required for premium features)</p>}
        {isTrialActive && (
          <p className="status-banner">
            Trial banner: {organizationSummary?.trialDaysRemaining || 0} days left | {reportsUsed}/{reportLimit} Signal Reports used ({reportWindow})
          </p>
        )}
        {isTrialActive && reportLimit > 0 && (
          <div style={{ marginTop: "0.35rem" }}>
            <p className="muted-text" style={{ marginBottom: "0.2rem" }}>Reports used: {reportsUsed} / {reportLimit}</p>
            <p className="muted-text" style={{ marginBottom: "0.35rem" }}>Trial ends: {organizationSummary?.trialEndsAt ? new Date(organizationSummary.trialEndsAt).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" }) : "N/A"}</p>
            <div style={{ width: "100%", height: "10px", borderRadius: "999px", background: "#e5eaf2", overflow: "hidden" }}>
              <div style={{ width: `${usagePercent}%`, height: "100%", background: usagePercent >= 80 ? "#b42318" : "#172554" }} />
            </div>
          </div>
        )}
        {showSoftUpgradePrompt && (
          <div className="card muted" style={{ marginTop: "0.6rem" }}>
            <p>Your first Campaign Signal Report is ready. Upgrade to save more reports, invite your team, and unlock full workspace features.</p>
            <div className="row" style={{ marginTop: "0.5rem" }}>
              <button type="button" className="ghost" onClick={() => setDismissSoftPrompt(true)}>Continue Trial</button>
              <Link to="/pricing" className="cta">View Plans</Link>
            </div>
          </div>
        )}
        {showStrongUpgradePrompt && (
          <p className="error-banner">You have used 3 of your 5 trial reports. <Link to="/pricing">Upgrade now</Link> to unlock more reports, team roles, and campaign workspaces.</p>
        )}
        {showHardUpgradePrompt && (
          <div className="error-banner" style={{ marginTop: "0.6rem" }}>
            <p>Trial report limit reached. Upgrade to continue generating campaign signal reports.</p>
            <div className="row" style={{ marginTop: "0.5rem" }}>
              <Link to="/pricing?plan=professional" className="cta">Upgrade to Professional</Link>
              <Link to="/pricing" className="ghost">View All Plans</Link>
            </div>
          </div>
        )}
        {!hasPremiumAccess && <p className="error-banner">Signal Report generation is locked until trial or subscription is active.</p>}
        <p className="muted-text">Configure campaign profile, generate Signal Report, and review saved outputs from your organization database.</p>
        <p className="muted-text">Campaign Signal Studio provides content planning and message-assist tools. Campaign teams are responsible for reviewing, approving, publishing, and complying with applicable election laws, platform rules, and disclaimer requirements.</p>
        {!canManageCampaign && <p className="muted-text">Campaign editing disabled for your role.</p>}
        {!canGenerateReports && <p className="muted-text">Report generation disabled for your role.</p>}
        {!canDeleteReports && <p className="muted-text">Report deletion disabled for your role.</p>}
        {organizationSummary?.isSubscribed && activePlanBenefits && (
          <div className="card muted" style={{ marginTop: "0.6rem" }}>
            <p><strong>{activePlanBenefits.title}</strong></p>
            <p>{activePlanBenefits.subtitle}</p>
            <ul className="muted-text">
              {activePlanBenefits.items.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          </div>
        )}
        {status && <p className="status-banner">{status}</p>}
        {error && <p className="error-banner">{error}</p>}
        {showUpgradeLink && <p className="muted-text">Upgrade prompt: <Link to="/pricing">View plans and upgrade</Link>.</p>}
      </section>

      {showUpgradeModal && isTrialActive && (
        <div className="modal-backdrop" role="presentation">
          <section className="card upgrade-modal" role="dialog" aria-modal="true" aria-labelledby="upgrade-modal-title">
            <h2 id="upgrade-modal-title">Unlock your full campaign workspace</h2>
            <p>Upgrade to keep generating reports, invite your team, create more campaigns, and manage your organization workspace.</p>
            <div className="row" style={{ marginTop: "0.5rem" }}>
              <Link to="/pricing?plan=professional" className="cta">Upgrade to Professional</Link>
              <Link to="/pricing" className="ghost">Compare Plans</Link>
              <button type="button" className="ghost" onClick={() => setShowUpgradeModal(false)}>Continue Trial</button>
            </div>
          </section>
        </div>
      )}

      <section className="grid two">
        <article className="card">
          <h2>Campaign profile form</h2>
          <div className="stack">
            <label>Race name<input value={profile.raceName} onChange={(e) => updateProfile("raceName", e.target.value)} /></label>
            <label>Office type<select value={profile.officeType} onChange={(e) => updateProfile("officeType", e.target.value)}><option>Senate</option><option>House</option><option>Governor</option><option>Mayor</option><option>Presidential</option></select></label>
            <label>Location<input value={profile.location} onChange={(e) => updateProfile("location", e.target.value)} /></label>
            <label>Election date<input type="date" value={profile.electionDate} onChange={(e) => updateProfile("electionDate", e.target.value)} /></label>
            <label>Incumbent / open seat<input value={profile.incumbent} onChange={(e) => updateProfile("incumbent", e.target.value)} /></label>
            <label>Budget band<select value={profile.budgetBand} onChange={(e) => updateProfile("budgetBand", e.target.value)}><option>$25k-$100k</option><option>$100k-$500k</option><option>$500k-$2M</option><option>$2M+</option></select></label>
            <label>Primary objective<input value={profile.objective} onChange={(e) => updateProfile("objective", e.target.value)} /></label>
            <label>Audience focus<input value={profile.audience} onChange={(e) => updateProfile("audience", e.target.value)} /></label>
            <label>
              Basic template
              <select value={templateId} onChange={(e) => setTemplateId(e.target.value)}>
                {basicTemplates.map((tpl) => (
                  <option key={tpl.id} value={tpl.id}>{tpl.label}</option>
                ))}
              </select>
            </label>
            <button className="ghost" type="button" onClick={applyTemplate} disabled={!canManageCampaign}>
              Apply Template
            </button>
            {!canUseAdvancedTemplates && <p className="muted-text">{advancedTemplates.length} advanced templates unlock on paid plans.</p>}
            <button className="cta" type="button" onClick={() => void saveCampaign()} disabled={savingCampaign || !canManageCampaign}>
              {savingCampaign ? "Saving..." : "Save Campaign Profile"}
            </button>
            <button className="ghost" type="button" onClick={() => void startNewCampaignDraft()} disabled={!canManageCampaign}>
              New Campaign
            </button>
            {campaignId && (
              <button className="ghost" type="button" onClick={() => void deleteCampaign()} disabled={!canManageCampaign}>
                Delete Campaign
              </button>
            )}
          </div>
        </article>

        <article className="card">
          <h2>Signal Report Generator</h2>
          <label>Race context notes<textarea value={contextInput} onChange={(e) => setContextInput(e.target.value)} rows={8} placeholder="Polling shift, fundraising notes, local issue pulse, opposition activity..." /></label>
          <button className="cta" onClick={() => void generate()} disabled={generatingReport || !canGenerateReports || !hasPremiumAccess}>
            {generatingReport ? "Generating..." : "Generate Signal Report"}
          </button>

          {latestReport && (
            <div className="report">
              <h3>{latestReport.title}</h3>
              <p><strong>Confidence:</strong> {latestReport.confidence}</p>

              <h4>Race Snapshot</h4>
              <p>{latestReport.raceSnapshot}</p>

              <h4>Opponent Watch</h4>
              <p>{latestReport.opponentWatch}</p>

              <h4>Message Memo</h4>
              <p>{latestReport.messageMemo}</p>

              <h4>Content Ideas</h4>
              <ul>{latestReport.contentIdeas.map((s, i) => <li key={i}>{s}</li>)}</ul>

              <h4>Video Angles</h4>
              <ul>{latestReport.videoAngles.map((s, i) => <li key={i}>{s}</li>)}</ul>

              <h4>Quote Graphics</h4>
              <ul>{latestReport.quoteGraphics.map((s, i) => <li key={i}>{s}</li>)}</ul>

              <h4>Fundraising Captions</h4>
              <ul>{latestReport.fundraisingCaptions.map((s, i) => <li key={i}>{s}</li>)}</ul>

              <h4>Rapid-Response Plan</h4>
              <ul>{latestReport.rapidResponsePlan.map((a, i) => <li key={i}>{a}</li>)}</ul>

              <p><strong>Compliance note:</strong> {latestReport.complianceNote}</p>

              <div className="row" style={{ marginTop: "0.5rem" }}>
                <button type="button" className="ghost" onClick={() => void copyLatestReportText()}>
                  Copy Report Text
                </button>
                <button type="button" className="ghost" onClick={() => void downloadLatestReportText()}>
                  Download Report Text
                </button>
                <button type="button" className="ghost" onClick={() => void exportLatestReportPdf()}>
                  Export PDF / Brand-Ready
                </button>
              </div>
              {canDeleteReports && (
                <button type="button" className="ghost" onClick={() => void deleteReport(latestReport.id)}>
                  Delete This Report
                </button>
              )}

              <div className="intel-sources">
                <h4>Intelligence Sources</h4>
                {latestReport.intelligenceSources?.electionPredictorUsed ? (
                  <>
                    <p><strong>User provided context:</strong> {latestReport.intelligenceSources.userProvidedContext ? "Yes" : "No"}</p>
                    {latestReport.intelligenceSources.matchedRaces?.length > 0 && (
                      <p><strong>Matched races:</strong> {latestReport.intelligenceSources.matchedRaces.join(", ")}</p>
                    )}
                    {latestReport.intelligenceSources.categoriesUsed?.length > 0 && (
                      <p><strong>Categories used:</strong> {latestReport.intelligenceSources.categoriesUsed.join(", ")}</p>
                    )}
                    <p><strong>Last checked:</strong> {latestReport.intelligenceSources.lastCheckedAt ? new Date(latestReport.intelligenceSources.lastCheckedAt).toLocaleString() : "Unavailable"}</p>
                  </>
                ) : (
                  <>
                    <p>This report was generated from your campaign profile and submitted context only.</p>
                    <p className="muted-text">No external race intelligence was used.</p>
                  </>
                )}
              </div>
            </div>
          )}
        </article>
      </section>

      <section className="card">
        <h2>Saved reports</h2>
        {reports.length === 0 ? <p className="muted-text">No reports yet. Generate your first Signal Report.</p> : (
          <ul className="report-list">
            {reports.map((r) => (
              <li key={r.id}>
                <div>
                  <strong>{r.title}</strong>
                  <span>{new Date(r.createdAt).toLocaleString()}</span>
                </div>
                <div style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
                  <span className={`pill ${r.confidence.toLowerCase()}`}>{r.confidence}</span>
                  {canDeleteReports && (
                    <button type="button" className="ghost" onClick={() => void deleteReport(r.id)}>
                      Delete
                    </button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}

function OrganizationConsole({ user }: { user: User }) {
  const [organization, setOrganization] = useState<OrganizationSummary | null>(null);
  const [stats, setStats] = useState<OrganizationStats | null>(null);
  const [currentRole, setCurrentRole] = useState<TeamRole>(user.role || "owner");
  const [members, setMembers] = useState<TeamMember[]>([]);
  const [invites, setInvites] = useState<TeamInvite[]>([]);
  const [activities, setActivities] = useState<TeamActivity[]>([]);
  const [loading, setLoading] = useState(true);
  const [updating, setUpdating] = useState(false);
  const [sendingInvite, setSendingInvite] = useState(false);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<TeamRole>("contributor");
  const [inviteMessage, setInviteMessage] = useState("");
  const [inviteLink, setInviteLink] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const showUpgradeLink = (error && /(trial limit reached|upgrade|active subscription|trial has expired|expired|paid plans|professional|consultant)/i.test(error)) || false;

  const canManageTeam = currentRole === "owner" || currentRole === "admin";

  const activityLabel = (a: TeamActivity): string => {
    const actor = a.actorEmail || "system";
    const target = a.targetEmail || "team member";
    const labels: Record<string, string> = {
      "report.generated": `${actor} generated a Signal Report`,
      "team.invite.created": `${actor} sent an invite to ${target}`,
      "team.invite.resent": `${actor} resent an invite`,
      "team.invite.revoked": `${actor} revoked an invite`,
      "team.invite.accepted": `${target} accepted an invite`,
      "team.member.role_changed": `${actor} changed role for ${target}`,
      "team.member.removed": `${actor} removed ${target}`,
      "report.deleted": `${actor} deleted a report`,
      "campaign.deleted": `${actor} deleted a campaign`,
    };
    return labels[a.action] || `${actor} performed ${a.action}`;
  };

  const loadTeam = async () => {
    try {
      const teamData = await apiRequest<{ members: TeamMember[]; invites: TeamInvite[]; activities: TeamActivity[] }>(
        "/api/team",
        {
          method: "GET",
          headers: {
            origin: window.location.origin,
          },
        },
        user,
      );
      setMembers(teamData.members);
      setInvites(teamData.invites);
      setActivities(teamData.activities || []);
    } catch {
      // Some roles may not have team view access.
    }
  };

  useEffect(() => {
    let active = true;

    const load = async () => {
      setLoading(true);
      setError(null);
      try {
        const data = await apiRequest<{ organization: OrganizationSummary; stats: OrganizationStats; currentUserRole: TeamRole }>(
          "/api/organization",
          {},
          user,
        );
        if (!active) return;
        setOrganization(data.organization);
        setStats(data.stats);
        setCurrentRole(data.currentUserRole || user.role);
        await loadTeam();
      } catch (err) {
        if (!active) return;
        setError(err instanceof Error ? err.message : "Failed to load organization console");
      } finally {
        if (active) {
          setLoading(false);
        }
      }
    };

    void load();
    return () => {
      active = false;
    };
  }, [user]);

  const toggleSupportAccess = async () => {
    if (!organization) return;
    setUpdating(true);
    setError(null);
    setStatus(null);

    try {
      const data = await apiRequest<{ organization: OrganizationSummary }>(
        "/api/organization/support-access",
        {
          method: "PATCH",
          body: JSON.stringify({ enabled: !organization.supportAccessEnabled }),
        },
        user,
      );
      setOrganization(data.organization);
      setStatus("Support access updated.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update support access");
    } finally {
      setUpdating(false);
    }
  };

  const sendInvite = async (e: FormEvent) => {
    e.preventDefault();
    setSendingInvite(true);
    setError(null);
    setStatus(null);
    setInviteLink(null);

    try {
      const data = await apiRequest<{ invite: TeamInvite; inviteLink: string }>(
        "/api/team/invites",
        {
          method: "POST",
          body: JSON.stringify({
            email: inviteEmail.trim(),
            role: inviteRole,
            message: inviteMessage.trim(),
            appOrigin: window.location.origin,
          }),
        },
        user,
      );

      setInviteEmail("");
      setInviteMessage("");
      setInviteLink(data.inviteLink);
      setStatus("Invite sent. Share the acceptance link below.");
      await loadTeam();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to send invite");
    } finally {
      setSendingInvite(false);
    }
  };

  const changeRole = async (memberId: number, role: TeamRole) => {
    setError(null);
    setStatus(null);
    try {
      await apiRequest<{ member: TeamMember }>(
        `/api/team/members/${memberId}/role`,
        {
          method: "PATCH",
          body: JSON.stringify({ role }),
        },
        user,
      );
      setStatus("Team role updated.");
      await loadTeam();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update role");
    }
  };

  const removeMember = async (memberId: number) => {
    setError(null);
    setStatus(null);
    try {
      await apiRequest<{ ok: boolean }>(`/api/team/members/${memberId}`, { method: "DELETE" }, user);
      setStatus("Member removed.");
      await loadTeam();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to remove member");
    }
  };

  const resendInvite = async (inviteId: number) => {
    setError(null);
    setStatus(null);
    try {
      const data = await apiRequest<{ inviteLink: string }>(
        `/api/team/invites/${inviteId}/resend`,
        { method: "POST", headers: { origin: window.location.origin } },
        user,
      );
      setInviteLink(data.inviteLink);
      setStatus("Invite resent.");
      await loadTeam();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to resend invite");
    }
  };

  const revokeInvite = async (inviteId: number) => {
    setError(null);
    setStatus(null);
    try {
      await apiRequest<{ ok: boolean }>(`/api/team/invites/${inviteId}/revoke`, { method: "POST" }, user);
      setStatus("Invite revoked.");
      await loadTeam();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to revoke invite");
    }
  };

  return (
    <main className="container page">
      <section className="card">
        <h1>Organization Console</h1>
        <p className="muted-text">Manage organization settings, team invites, and role access controls.</p>
      </section>

      {loading && (
        <section className="card">
          <p className="muted-text">Loading organization data...</p>
        </section>
      )}

      {status && <p className="status-banner">{status}</p>}
      {error && <p className="error-banner">{error}</p>}
      {showUpgradeLink && <p className="muted-text">Upgrade prompt: <Link to="/pricing">View plans and upgrade</Link>.</p>}

      {organization && stats && (
        <>
          <section className="grid two">
            <article className="card">
              <h2>{organization.name}</h2>
              <p><strong>Organization ID:</strong> {organization.id}</p>
              <p><strong>Organization type:</strong> {organization.organizationType || "Other"}</p>
              <p><strong>Your role:</strong> {currentRole}</p>
              <p><strong>Created:</strong> {new Date(organization.createdAt).toLocaleString()}</p>
              <p><strong>Support access:</strong> {organization.supportAccessEnabled ? "Enabled" : "Disabled"}</p>
              {(currentRole === "owner" || currentRole === "admin") && (
                <button className="cta" type="button" onClick={() => void toggleSupportAccess()} disabled={updating}>
                  {updating ? "Updating..." : organization.supportAccessEnabled ? "Disable Support Access" : "Enable Support Access"}
                </button>
              )}
            </article>

            <article className="card">
              <h2>Organization Stats</h2>
              <p><strong>Access state:</strong> {organization.isSubscribed ? "Active Subscription" : organization.isTrialActive ? "Trial" : "Inactive"}</p>
              {organization.isTrialActive && <p><strong>Trial days remaining:</strong> {organization.trialDaysRemaining || 0}</p>}
              {organization.isTrialActive && organization.usage && (
                <p><strong>Trial usage:</strong> {organization.usage.reportsUsed}/{organization.usage.reportsLimit} reports, {organization.usage.campaignsUsed}/{organization.usage.campaignLimit} campaigns, {organization.usage.usersUsed}/{organization.usage.userLimit} users</p>
              )}
              <p><strong>Users:</strong> {stats.userCount}</p>
              <p><strong>Campaigns:</strong> {stats.campaignCount}</p>
              <p><strong>Signal Reports:</strong> {stats.reportCount}</p>
              <p><strong>Billing status:</strong> {organization.billingStatus || "inactive"}</p>
              <p><strong>Plan:</strong> {organization.billingPlan || "none"}</p>
              <p><strong>Limits:</strong> {organization.reportLimit || 0} reports/{organization.reportLimitWindow === "total" ? "trial" : "month"}, {organization.userLimit || 0} users, {organization.workspaceLimit || 0} campaign workspaces</p>
              <p className="muted-text">All values are scoped to your organization_id.</p>
              {organization.isTrialActive && organization.usage && organization.usage.reportsUsed >= 3 && organization.usage.reportsUsed < 5 && (
                <p className="error-banner">Trial upgrade prompt: you are close to the 5-report cap. <Link to="/pricing">Upgrade now</Link>.</p>
              )}
              {organization.isTrialActive && organization.usage && organization.usage.reportsUsed >= 5 && (
                <p className="error-banner">Trial report cap reached. <Link to="/pricing">Upgrade to continue generating reports.</Link></p>
              )}
            </article>
          </section>

          <section className="card" style={{ marginTop: "1rem" }}>
            <h2>Team & Roles</h2>
            <p className="muted-text">Invite your campaign team and control what each person can access.</p>
            {!organization.hasPremiumAccess && <p className="error-banner">Team features are locked until trial or subscription is active.</p>}
            {!organization.hasPremiumAccess && <p className="muted-text">Trial expired prompt: <Link to="/pricing">Upgrade to restore team workflows</Link>.</p>}

            {canManageTeam && organization.hasPremiumAccess && (
              <form className="stack" onSubmit={sendInvite}>
                <h3>Invite Team Member</h3>
                <label>
                  Email
                  <input value={inviteEmail} onChange={(e) => setInviteEmail(e.target.value)} type="email" required />
                </label>
                <label>
                  Role
                  <select value={inviteRole} onChange={(e) => setInviteRole(e.target.value as TeamRole)}>
                    {roles.map((r) => (
                      <option key={r} value={r}>{r}</option>
                    ))}
                  </select>
                </label>
                <p className="muted-text">{roleHelpText[inviteRole]}</p>
                <label>
                  Optional message
                  <textarea value={inviteMessage} onChange={(e) => setInviteMessage(e.target.value)} rows={3} placeholder="Welcome to our workspace." />
                </label>
                <button className="cta" type="submit" disabled={sendingInvite}>{sendingInvite ? "Sending..." : "Send Invite"}</button>
              </form>
            )}

            {inviteLink && (
              <div className="card muted" style={{ marginTop: "1rem" }}>
                <p><strong>Invite link:</strong></p>
                <p style={{ wordBreak: "break-all" }}>{inviteLink}</p>
              </div>
            )}

            <h3 style={{ marginTop: "1rem" }}>Active Members</h3>
            {members.length === 0 ? <p className="muted-text">No team members found.</p> : (
              <ul className="report-list">
                {members.map((m) => (
                  <li key={m.id}>
                    <div>
                      <strong>{m.email}</strong>
                      <span>{m.role}</span>
                    </div>
                    {canManageTeam ? (
                      <div style={{ display: "flex", gap: "0.5rem" }}>
                        <select value={m.role} onChange={(e) => void changeRole(m.id, e.target.value as TeamRole)}>
                          {roles.map((r) => (
                            <option key={r} value={r}>{r}</option>
                          ))}
                        </select>
                        <button type="button" className="ghost" onClick={() => void removeMember(m.id)}>Remove</button>
                      </div>
                    ) : <span className={`pill ${m.role}`}>{m.role}</span>}
                  </li>
                ))}
              </ul>
            )}

            <h3 style={{ marginTop: "1rem" }}>Pending Invites</h3>
            {invites.length === 0 ? <p className="muted-text">No invites yet.</p> : (
              <ul className="report-list">
                {invites.map((i) => (
                  <li key={i.id}>
                    <div>
                      <strong>{i.email}</strong>
                      <span>{i.status} · {i.role}</span>
                    </div>
                    {canManageTeam && i.status !== "accepted" ? (
                      <div style={{ display: "flex", gap: "0.5rem" }}>
                        <button type="button" className="ghost" onClick={() => void resendInvite(i.id)}>Resend</button>
                        <button type="button" className="ghost" onClick={() => void revokeInvite(i.id)}>Revoke</button>
                      </div>
                    ) : <span>{new Date(i.createdAt).toLocaleDateString()}</span>}
                  </li>
                ))}
              </ul>
            )}

            <h3 style={{ marginTop: "1rem" }}>Team Activity</h3>
            {activities.length === 0 ? <p className="muted-text">No recent activity yet.</p> : (
              <ul className="report-list">
                {activities.map((a) => (
                  <li key={a.id}>
                    <div>
                      <strong>{activityLabel(a)}</strong>
                      <span>{new Date(a.createdAt).toLocaleString()}</span>
                    </div>
                    <span className="muted-text">{a.action}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      )}
    </main>
  );
}

function PricingPage() {
  const [searchParams] = useSearchParams();
  const [user] = useLocalState<User | null>("css-demo-user", null);
  const [organization, setOrganization] = useState<OrganizationSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pendingPlan, setPendingPlan] = useState<string | null>(null);

  const checkoutStatus = searchParams.get("checkout");

  useEffect(() => {
    let active = true;

    const loadOrganization = async () => {
      if (!user) {
        setOrganization(null);
        return;
      }

      try {
        const data = await apiRequest<{ organization: OrganizationSummary }>("/api/organization", {}, user);
        if (!active) return;
        setOrganization(data.organization);
      } catch {
        if (!active) return;
        setOrganization(null);
      }
    };

    void loadOrganization();
    return () => {
      active = false;
    };
  }, [user]);

  const startCheckout = async (plan: "starter" | "professional" | "consultant" | "onboarding_training") => {
    if (!user) {
      setError("Login first to start a Stripe checkout session.");
      return;
    }

    setError(null);
    setPendingPlan(plan);

    try {
      const data = await apiRequest<{ url?: string; id: string }>(
        "/api/billing/checkout-session",
        {
          method: "POST",
          body: JSON.stringify({
            plan,
            appOrigin: window.location.origin,
          }),
        },
        user,
      );

      if (!data.url) {
        throw new Error("Stripe did not return a checkout URL.");
      }

      window.location.href = data.url;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to start Stripe checkout");
    } finally {
      setPendingPlan(null);
    }
  };

  return (
    <main className="container page">
      <h1>Choose the workspace that fits your team</h1>
      <p className="muted-text">Start with a trial workspace. Upgrade when your campaign is ready to collaborate, save more reports, and use the full platform.</p>
      {organization?.isTrialActive && <p className="status-banner">Current access: Trial ({organization.trialDaysRemaining || 0} days left).</p>}
      {organization?.isSubscribed && <p className="status-banner">Current access: Active Subscription ({organization.billingPlan || "plan"}).</p>}
      {organization && !organization.isTrialActive && !organization.isSubscribed && <p className="error-banner">Current access: Inactive. Start checkout to reactivate premium features.</p>}
      {checkoutStatus === "success" && <p className="status-banner">Stripe checkout completed. Your subscription is now processing.</p>}
      {checkoutStatus === "cancelled" && <p className="error-banner">Checkout was cancelled. You can retry any plan below.</p>}
      {error && <p className="error-banner">{error}</p>}
      <section className="grid three">
        <article className="card">
          <h3>Starter</h3>
          <p>$99/mo</p>
          <p>For small local campaigns testing the platform.</p>
          <ul>
            <li>1 organization workspace</li>
            <li>1 campaign</li>
            <li>5 users</li>
            <li>25 Signal Reports/month</li>
            <li>Saved reports, basic templates, email support</li>
          </ul>
          <button className="cta" type="button" onClick={() => void startCheckout("starter")} disabled={pendingPlan !== null}>
            {pendingPlan === "starter" ? "Redirecting..." : "Start Starter"}
          </button>
        </article>
        <article className="card featured">
          <h3>Professional</h3>
          <p>$299/mo</p>
          <p><strong>Best for active campaigns</strong></p>
          <p>For active campaigns that need weekly message and content intelligence.</p>
          <ul>
            <li>1 organization workspace</li>
            <li>Unlimited campaigns</li>
            <li>25 users</li>
            <li>150 Signal Reports/month</li>
            <li>Organization Console, support toggle, priority email support</li>
          </ul>
          <button className="cta" type="button" onClick={() => void startCheckout("professional")} disabled={pendingPlan !== null}>
            {pendingPlan === "professional" ? "Redirecting..." : "Upgrade to Professional"}
          </button>
        </article>
        <article className="card">
          <h3>Consultant</h3>
          <p>$799/mo</p>
          <p>For consultants managing multiple races or clients.</p>
          <ul>
            <li>5 client workspaces</li>
            <li>50 users</li>
            <li>500 Signal Reports/month</li>
            <li>Reusable templates, client folders, usage dashboard</li>
            <li>Onboarding session included</li>
          </ul>
          <button className="cta" type="button" onClick={() => void startCheckout("consultant")} disabled={pendingPlan !== null}>
            {pendingPlan === "consultant" ? "Redirecting..." : "Start Consultant"}
          </button>
        </article>
      </section>

      <section className="card" style={{ marginTop: "1rem" }}>
        <h2>Onboarding & Training Add-On</h2>
        <p><strong>$750 one-time</strong></p>
        <ul>
          <li>Workspace setup walkthrough</li>
          <li>Campaign profile setup</li>
          <li>Team/admin training</li>
          <li>First Signal Report walkthrough</li>
          <li>60-minute live onboarding session</li>
        </ul>
        <button className="cta" type="button" onClick={() => void startCheckout("onboarding_training")} disabled={pendingPlan !== null}>
          {pendingPlan === "onboarding_training" ? "Redirecting..." : "Start Checkout"}
        </button>
      </section>

      <section className="card" style={{ marginTop: "1rem" }}>
        <h2>Enterprise</h2>
        <p className="muted-text">Custom pricing for PACs, statewide campaigns, advocacy orgs, and larger firms.</p>
        <p><strong>Contact Sales:</strong> sales@campaignsignalstudio.demo</p>
      </section>
    </main>
  );
}

function SupportPage() {
  return (
    <main className="container page">
      <h1>Support & Onboarding</h1>
      <section className="grid two">
        <article className="card">
          <h3>Onboarding checklist</h3>
          <ol>
            <li>Create account and workspace</li>
            <li>Complete campaign profile</li>
            <li>Generate first Signal Report</li>
            <li>Review saved reports with your team</li>
          </ol>
        </article>
        <article className="card">
          <h3>Help channels</h3>
          <p>Email: support@campaignsignal.us</p>
          <p>Office hours: Tue/Thu, 1-3pm ET</p>
          <p>Status: All systems operational</p>
        </article>
      </section>
    </main>
  );
}

function Protected({ user, children }: { user: User | null; children: ReactElement }) {
  if (!user) return <Navigate to="/login" replace />;
  return children;
}

function SiteFooter() {
  return (
    <footer className="site-footer">
      <div className="container site-footer-inner">
        <div className="site-footer-copy">
          <p className="site-footer-title">Campaign Toolkit</p>
          <p className="muted-text">
            Explore the campaign toolkit: Civicos Pro for candidate support and ElectionPredictor for race insight.
          </p>
        </div>
        <div className="site-footer-links" aria-label="Campaign toolkit links">
          <a href="https://civicos.pro">Civicos Pro</a>
          <a href="https://electionpredictor.net/">ElectionPredictor</a>
          <span className="current-site-label">Campaign Signal Studio</span>
        </div>
      </div>
    </footer>
  );
}

function App() {
  const [user, setUser] = useLocalState<User | null>("css-demo-user", null);

  useEffect(() => {
    if (user && !user.role) {
      setUser({ ...user, role: "owner" });
      return;
    }

    if (!user) {
      localStorage.removeItem("css-demo-user");
      return;
    }
    localStorage.setItem("css-demo-user", JSON.stringify(user));
  }, [user]);

  const logout = () => {
    setUser(null);
  };

  return (
    <>
      <TopNav user={user} onLogout={logout} />
      <Routes>
        <Route path="/" element={<LandingPage />} />
        <Route path="/signup" element={<AuthPage mode="signup" onAuth={setUser} />} />
        <Route path="/login" element={<AuthPage mode="login" onAuth={setUser} />} />
        <Route path="/accept-invite" element={<AcceptInvitePage onAuth={setUser} />} />
        <Route path="/pricing" element={<PricingPage />} />
        <Route path="/support" element={<SupportPage />} />
        <Route
          path="/organization"
          element={
            <Protected user={user}>
              <OrganizationConsole user={user!} />
            </Protected>
          }
        />
        <Route
          path="/workspace"
          element={
            <Protected user={user}>
              <Workspace user={user!} />
            </Protected>
          }
        />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
      <SiteFooter />
    </>
  );
}

export default App;
