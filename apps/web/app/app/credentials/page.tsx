import Link from "next/link";
import type { Address, Hex } from "viem";
import { createClient } from "@/lib/supabase/server";
import { hasOperationalRole, requireConsortiumViewer } from "@/lib/viewer";
import { formatDate, shortHash, titleCase } from "@/lib/format";
import { StatusBadge } from "@/components/status-badge";
import { CredentialLifecycleConsole } from "@/components/credential-lifecycle-console";
import type { CredentialLifecycleItem } from "@/lib/credential-lifecycle-chain";

export const dynamic = "force-dynamic";

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const HEX_32 = /^0x[0-9a-fA-F]{64}$/;
const LIFECYCLE_ROLES = new Set(["auditor", "independent", "regulator"]);

export default async function CredentialsPage() {
  const viewer = await requireConsortiumViewer();
  const supabase = await createClient();
  const [{ data: credentials }, { data: organizations }] = await Promise.all([
    supabase.from("credentials").select("id,chain_credential_id,subject_organization_id,issuer_organization_id,credential_type,digest,scope_hash,status,valid_from,valid_until,chain_tx_hash,created_at").order("created_at", { ascending: false }),
    supabase.from("organizations").select("id,display_name,role,status"),
  ]);
  const orgMap = new Map((organizations ?? []).map((org) => [org.id, org]));
  const credentialRegistryRaw = process.env.THREADPROOF_CREDENTIAL_REGISTRY_ADDRESS?.trim() ?? "";
  const chainIdRaw = process.env.NEXT_PUBLIC_THREADPROOF_CHAIN_ID ?? process.env.THREADPROOF_CHAIN_ID ?? "";
  const chainId = Number(chainIdRaw);
  const registryConfigured = ADDRESS.test(credentialRegistryRaw) && Number.isSafeInteger(chainId) && chainId > 0;
  const canManageLifecycle = viewer.memberships.some((membership) =>
    membership.active &&
    membership.organization.status === "active" &&
    LIFECYCLE_ROLES.has(membership.organization.role) &&
    hasOperationalRole(membership),
  );
  const now = Date.now();
  const lifecycleItems: CredentialLifecycleItem[] = (credentials ?? [])
    .filter((credential) => HEX_32.test(credential.chain_credential_id))
    .map((credential) => ({
      credentialId: credential.chain_credential_id as Hex,
      label: titleCase(credential.credential_type),
      subjectName: orgMap.get(credential.subject_organization_id)?.display_name ?? "Unknown subject",
      issuerName: orgMap.get(credential.issuer_organization_id)?.display_name ?? "Unknown issuer",
      status: credential.status === "active" && Date.parse(credential.valid_until) < now ? "expired" : credential.status,
    }));

  return (
    <div className="workspace-page">
      <header className="page-header"><div><span className="kicker">VERIFIABLE CREDENTIALS</span><h1>Credential registry</h1><p>Consortium-visible metadata mirrors credential lifecycle. Issuance, suspension and revocation authority comes from CredentialRegistry, never from the database.</p></div></header>

      {registryConfigured && canManageLifecycle ? (
        <CredentialLifecycleConsole
          credentialRegistryAddress={credentialRegistryRaw as Address}
          chainId={chainId}
          credentials={lifecycleItems}
        />
      ) : registryConfigured ? (
        <section className="panel"><div className="empty-state"><strong>Read-only credential session</strong><span>Lifecycle controls are shown to operational auditor, independent-auditor and regulator memberships. The contract still makes the final authority decision from the connected wallet.</span></div></section>
      ) : (
        <section className="panel"><div className="alert alert-error">CredentialRegistry is not configured for this web deployment. Credential lifecycle writes fail closed until the registry address and ThreadProof chain id are configured.</div></section>
      )}

      <section className="privacy-banner"><span className="privacy-icon">✓</span><div><strong>Revocation is terminal.</strong><p>Suspended credentials may be restored only through the privileged on-chain status path. Once revoked, neither an issuer nor a suspender can reactivate the credential.</p></div></section>

      <section className="panel table-panel">{(credentials ?? []).length ? <div className="data-table credential-table"><div className="table-row table-head"><span>Credential</span><span>Subject</span><span>Issuer</span><span>Status</span><span>Validity</span></div>{(credentials ?? []).map((credential) => {
        const effectiveStatus = credential.status === "active" && Date.parse(credential.valid_until) < now ? "expired" : credential.status;
        return <Link className="table-row table-row-link" href={`/app/credentials/${credential.id}`} key={credential.id}><span><strong>{titleCase(credential.credential_type)}</strong><small className="mono">{shortHash(credential.chain_credential_id)}</small></span><span>{orgMap.get(credential.subject_organization_id)?.display_name ?? "Unknown"}</span><span>{orgMap.get(credential.issuer_organization_id)?.display_name ?? "Unknown"}</span><span><StatusBadge value={effectiveStatus} /></span><span><strong>{formatDate(credential.valid_until)}</strong><small>from {formatDate(credential.valid_from)}</small></span></Link>;
      })}</div> : <div className="empty-state large"><strong>No credentials indexed yet</strong><span>Credential records appear here only after authorized issuers anchor them to CredentialRegistry and the indexer observes the event.</span></div>}</section>
      <p className="footnote">Open a credential to inspect its digest, scope, parties, validity, issuance transaction and any capacity state visible to your current RLS session. ThreadProof proves digital authorization, not the truth of the original physical-world assessment.</p>
    </div>
  );
}
