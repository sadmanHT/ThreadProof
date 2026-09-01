import Link from "next/link";
import { notFound } from "next/navigation";
import { createPublicClient, http, keccak256, toBytes, type Address, type Hex } from "viem";
import { createClient } from "@/lib/supabase/server";
import { requireConsortiumViewer } from "@/lib/viewer";
import { formatDate, shortHash, titleCase } from "@/lib/format";
import { StatusBadge } from "@/components/status-badge";
import { credentialRegistryLifecycleAbi } from "@/lib/credential-lifecycle-chain";

export const dynamic = "force-dynamic";
type Props = { params: Promise<{ id: string }> };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const HEX_32 = /^0x[0-9a-fA-F]{64}$/;
const CAPACITY_CREDENTIAL_TYPE = keccak256(toBytes("CAPACITY_CREDENTIAL"));

function sameHex(left: string | null | undefined, right: string | null | undefined) {
  return typeof left === "string" && typeof right === "string" && left.toLowerCase() === right.toLowerCase();
}

function credentialTypeHash(value: string): Hex | null {
  if (HEX_32.test(value)) return value as Hex;
  if (value === "CAPACITY_CREDENTIAL") return CAPACITY_CREDENTIAL_TYPE;
  return null;
}

function chainStatus(value: number) {
  return ({ 0: "unknown", 1: "active", 2: "suspended", 3: "revoked" } as Record<number, string>)[value] ?? "unknown";
}

async function readCanonicalCredential(credentialId: string) {
  const rpcUrl = process.env.THREADPROOF_RPC_URL;
  const registryRaw = process.env.THREADPROOF_CREDENTIAL_REGISTRY_ADDRESS?.trim() ?? "";
  const expectedChainId = Number(process.env.THREADPROOF_CHAIN_ID ?? process.env.NEXT_PUBLIC_THREADPROOF_CHAIN_ID ?? "0");
  if (!rpcUrl || !ADDRESS.test(registryRaw) || !HEX_32.test(credentialId) || !Number.isSafeInteger(expectedChainId) || expectedChainId <= 0) {
    return { available: false as const, error: "CredentialRegistry live verification is not configured for this deployment." };
  }

  try {
    const client = createPublicClient({ transport: http(rpcUrl, { timeout: 8_000, retryCount: 1 }) });
    const chainId = await client.getChainId();
    if (chainId !== expectedChainId) {
      return { available: false as const, error: `Connected RPC is serving chain ${chainId}, expected ${expectedChainId}.` };
    }
    const [record, active] = await Promise.all([
      client.readContract({
        address: registryRaw as Address,
        abi: credentialRegistryLifecycleAbi,
        functionName: "getCredential",
        args: [credentialId as Hex],
      }),
      client.readContract({
        address: registryRaw as Address,
        abi: credentialRegistryLifecycleAbi,
        functionName: "isCredentialActive",
        args: [credentialId as Hex],
      }),
    ]);
    return { available: true as const, chainId, registryAddress: registryRaw as Address, record, active, error: null };
  } catch (error) {
    return { available: false as const, error: error instanceof Error ? error.message : "CredentialRegistry verification failed." };
  }
}

export default async function CredentialDetailPage({ params }: Props) {
  await requireConsortiumViewer();
  const { id } = await params;
  if (!UUID.test(id)) notFound();

  const supabase = await createClient();
  const { data: credential } = await supabase.from("credentials").select("*").eq("id", id).maybeSingle();
  if (!credential) notFound();

  const [{ data: subject }, { data: issuer }, { data: openings }, canonical] = await Promise.all([
    supabase.from("organizations").select("id,display_name,legal_name,role,status,chain_organization_id").eq("id", credential.subject_organization_id).maybeSingle(),
    supabase.from("organizations").select("id,display_name,legal_name,role,status,chain_organization_id").eq("id", credential.issuer_organization_id).maybeSingle(),
    supabase.from("private_capacity_openings").select("id,period_id,process_id,chain_state_key,status,circuit_version,last_chain_block,updated_at").eq("capacity_credential_id", credential.id).order("updated_at", { ascending: false }).limit(8),
    readCanonicalCredential(credential.chain_credential_id),
  ]);

  const expired = Date.parse(credential.valid_until) < Date.now();
  const effectiveStatus = credential.status === "active" && expired ? "expired" : credential.status;
  const expectedCredentialType = credentialTypeHash(credential.credential_type);
  const canonicalStatus = canonical.available ? chainStatus(Number(canonical.record.status)) : null;
  const canonicalValidFrom = canonical.available ? new Date(Number(canonical.record.validFrom) * 1000).toISOString() : null;
  const canonicalValidUntil = canonical.available ? new Date(Number(canonical.record.validUntil) * 1000).toISOString() : null;
  const mirrorMatches = canonical.available
    && !!subject
    && !!issuer
    && expectedCredentialType !== null
    && sameHex(canonical.record.credentialId, credential.chain_credential_id)
    && sameHex(canonical.record.subjectOrganizationId, subject.chain_organization_id)
    && sameHex(canonical.record.issuerOrganizationId, issuer.chain_organization_id)
    && sameHex(canonical.record.credentialType, expectedCredentialType)
    && sameHex(canonical.record.digest, credential.digest)
    && sameHex(canonical.record.scopeHash, credential.scope_hash)
    && Math.floor(Date.parse(credential.valid_from) / 1000) === Number(canonical.record.validFrom)
    && Math.floor(Date.parse(credential.valid_until) / 1000) === Number(canonical.record.validUntil)
    && credential.status === canonicalStatus;

  return (
    <div className="workspace-page">
      <div className="breadcrumb-row"><Link href="/app/credentials">Credentials</Link><span>›</span><span>{shortHash(credential.chain_credential_id, 10, 8)}</span></div>
      <header className="proof-detail-hero"><div><span className="kicker">CREDENTIAL EVIDENCE</span><h1>{titleCase(credential.credential_type)}</h1><p>{subject?.display_name ?? "Unknown subject"} · issued by {issuer?.display_name ?? "Unknown issuer"}</p></div><StatusBadge value={canonical.available ? (canonical.active ? "active" : canonicalStatus ?? effectiveStatus) : effectiveStatus} /></header>

      <section className="panel">
        <div className="panel-heading"><div><span className="kicker">CANONICAL REGISTRY CHECK</span><h2>Live CredentialRegistry state</h2></div>{canonical.available ? <span className={`privacy-chip ${mirrorMatches ? "shared" : "consortium"}`}>{mirrorMatches ? "Mirror reconciled" : "Mirror mismatch"}</span> : <span className="privacy-chip consortium">RPC unavailable</span>}</div>
        {canonical.available ? (
          <>
            {!mirrorMatches ? <div className="alert alert-error">The application credential mirror does not exactly match current CredentialRegistry state. Do not use the database row as authorization until the indexer reconciles it.</div> : null}
            <dl className="definition-grid">
              <div><dt>Chain</dt><dd>{canonical.chainId}</dd></div>
              <div><dt>Currently usable</dt><dd><StatusBadge value={canonical.active ? "active" : "inactive"} /></dd></div>
              <div><dt>Canonical lifecycle</dt><dd><StatusBadge value={canonicalStatus ?? "unknown"} /></dd></div>
              <div><dt>Mirror match</dt><dd>{mirrorMatches ? "Exact" : "Mismatch"}</dd></div>
              <div className="wide"><dt>Registry address</dt><dd className="mono hash-full">{canonical.registryAddress}</dd></div>
              <div className="wide"><dt>Canonical subject organization</dt><dd className="mono hash-full">{canonical.record.subjectOrganizationId}</dd></div>
              <div className="wide"><dt>Canonical issuer organization</dt><dd className="mono hash-full">{canonical.record.issuerOrganizationId}</dd></div>
              <div className="wide"><dt>Canonical credential type</dt><dd className="mono hash-full">{canonical.record.credentialType}</dd></div>
              <div className="wide"><dt>Canonical digest</dt><dd className="mono hash-full">{canonical.record.digest}</dd></div>
              <div className="wide"><dt>Canonical scope</dt><dd className="mono hash-full">{canonical.record.scopeHash}</dd></div>
              <div><dt>Canonical valid from</dt><dd>{canonicalValidFrom ? formatDate(canonicalValidFrom, { dateStyle: "medium", timeStyle: "short" }) : "—"}</dd></div>
              <div><dt>Canonical valid until</dt><dd>{canonicalValidUntil ? formatDate(canonicalValidUntil, { dateStyle: "medium", timeStyle: "short" }) : "—"}</dd></div>
            </dl>
          </>
        ) : <div className="alert alert-error">Live canonical credential verification is unavailable. {canonical.error}</div>}
      </section>

      <section className="proof-evidence-grid">
        <article className="panel"><div className="panel-heading"><div><span className="kicker">APPLICATION MIRROR</span><h2>Indexed credential metadata</h2></div></div><dl className="definition-grid"><div className="wide"><dt>Chain credential id</dt><dd className="mono hash-full">{credential.chain_credential_id}</dd></div><div><dt>Subject</dt><dd>{subject?.display_name ?? "Unknown"}</dd></div><div><dt>Subject role</dt><dd>{subject ? titleCase(subject.role) : "—"}</dd></div><div><dt>Issuer</dt><dd>{issuer?.display_name ?? "Unknown"}</dd></div><div><dt>Issuer role</dt><dd>{issuer ? titleCase(issuer.role) : "—"}</dd></div><div className="wide"><dt>Credential digest</dt><dd className="mono hash-full">{credential.digest}</dd></div><div className="wide"><dt>Scope hash</dt><dd className="mono hash-full">{credential.scope_hash}</dd></div><div><dt>Valid from</dt><dd>{formatDate(credential.valid_from, { dateStyle: "medium", timeStyle: "short" })}</dd></div><div><dt>Valid until</dt><dd>{formatDate(credential.valid_until, { dateStyle: "medium", timeStyle: "short" })}</dd></div><div className="wide"><dt>Issuance transaction</dt><dd>{credential.chain_tx_hash ? <Link className="mono hash-full" href={`/app/chain/transactions/${credential.chain_tx_hash}`}>{credential.chain_tx_hash}</Link> : "Not indexed"}</dd></div></dl></article>

        <article className="panel trust-panel"><span className="kicker">WHAT THIS PROVES</span><h2>Digital authority, not physical truth.</h2><p>ThreadProof can establish who issued this credential, its committed scope, its validity window and whether its on-chain authorization remains usable. It does not prove that the underlying physical inspection or assessment was factually correct.</p><div className="privacy-access-list"><span className="privacy-chip shared">Digest verifiable</span><span className="privacy-chip consortium">Lifecycle attributable</span><span className="privacy-chip private">Encrypted body concealed</span></div></article>
      </section>

      <section className="proof-evidence-grid">
        <article className="panel"><div className="panel-heading"><div><span className="kicker">PARTIES</span><h2>Consortium attribution</h2></div></div><dl className="definition-grid"><div><dt>Subject legal name</dt><dd>{subject?.legal_name ?? "Not visible"}</dd></div><div><dt>Subject status</dt><dd>{subject ? <StatusBadge value={subject.status} /> : "—"}</dd></div><div className="wide"><dt>Subject chain organization</dt><dd className="mono hash-full">{subject?.chain_organization_id ?? "Not visible"}</dd></div><div><dt>Issuer legal name</dt><dd>{issuer?.legal_name ?? "Not visible"}</dd></div><div><dt>Issuer status</dt><dd>{issuer ? <StatusBadge value={issuer.status} /> : "—"}</dd></div><div className="wide"><dt>Issuer chain organization</dt><dd className="mono hash-full">{issuer?.chain_organization_id ?? "Not visible"}</dd></div></dl></article>

        <article className="panel"><div className="panel-heading"><div><span className="kicker">CAPACITY LINKAGE</span><h2>Visible capacity states</h2></div><span className="panel-count">{openings?.length ?? 0}</span></div>{(openings ?? []).length ? <div className="record-list">{(openings ?? []).map((opening) => <div className="record-row" key={opening.id}><div><strong>{opening.period_id} · {titleCase(opening.process_id)}</strong><span>circuit v{opening.circuit_version} · block {opening.last_chain_block ?? "not indexed"} · {formatDate(opening.updated_at)}</span></div><StatusBadge value={opening.status} /></div>)}</div> : <div className="empty-state"><strong>No capacity opening is visible to this session</strong><span>That can mean this credential is not a capacity credential, or the current viewer is not authorized to read the factory-confidential opening table.</span></div>}</article>
      </section>

      <p className="footnote">CredentialRegistry is the authorization source. The credential row and visible capacity openings are application read models; a mismatch or unavailable canonical check must fail closed for critical authorization decisions.</p>
    </div>
  );
}
