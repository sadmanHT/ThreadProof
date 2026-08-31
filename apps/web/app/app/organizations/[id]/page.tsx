import Link from "next/link";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { requireConsortiumViewer } from "@/lib/viewer";
import { formatDate, shortHash, titleCase } from "@/lib/format";
import { StatusBadge } from "@/components/status-badge";

export const dynamic = "force-dynamic";
type Props = { params: Promise<{ id: string }> };

function initials(value: string) {
  return value.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]?.toUpperCase()).join("") || "TP";
}

export default async function OrganizationDetailPage({ params }: Props) {
  await requireConsortiumViewer();
  const { id } = await params;
  const supabase = await createClient();
  const [{ data: organization }, { data: credentials }, { data: issuedCredentials }, { data: visibleOrders }] = await Promise.all([
    supabase.from("organizations").select("id,display_name,legal_name,role,status,country_code,chain_organization_id,metadata,created_at,updated_at").eq("id", id).maybeSingle(),
    supabase.from("credentials").select("id,chain_credential_id,credential_type,status,issuer_organization_id,scope_hash,valid_from,valid_until,created_at").eq("subject_organization_id", id).order("valid_until"),
    supabase.from("credentials").select("id,status").eq("issuer_organization_id", id),
    supabase.from("purchase_orders").select("id,external_reference,title,status,buyer_organization_id,factory_organization_id,updated_at").order("updated_at", { ascending: false }).limit(100),
  ]);
  if (!organization) notFound();
  const issuerIds = [...new Set((credentials ?? []).map((credential) => credential.issuer_organization_id))];
  const { data: issuers } = issuerIds.length ? await supabase.from("organizations").select("id,display_name").in("id", issuerIds) : { data: [] };
  const issuerMap = new Map((issuers ?? []).map((issuer) => [issuer.id, issuer.display_name]));
  const relatedOrders = (visibleOrders ?? []).filter((order) => order.buyer_organization_id === id || order.factory_organization_id === id).slice(0, 6);
  const activeCredentials = (credentials ?? []).filter((credential) => credential.status === "active").length;

  return <div className="workspace-page">
    <div className="breadcrumb-row"><Link href="/app/organizations">Organizations</Link><span>›</span><span>{organization.display_name}</span></div>
    <header className="organization-hero"><div className="organization-hero-identity"><span className="organization-monogram large">{initials(organization.display_name)}</span><div><span className="kicker">{titleCase(organization.role)}</span><h1>{organization.display_name}</h1><p>{organization.legal_name}</p></div></div><StatusBadge value={organization.status} /></header>

    <section className="organization-summary-grid"><article><span>Country</span><strong>{organization.country_code ?? "Not specified"}</strong></article><article><span>Active credentials</span><strong>{activeCredentials}</strong></article><article><span>Credentials issued</span><strong>{issuedCredentials?.length ?? 0}</strong></article><article><span>Consortium since</span><strong>{formatDate(organization.created_at)}</strong></article></section>

    <section className="detail-grid organization-detail-grid"><article className="panel"><div className="panel-heading"><div><span className="kicker">PROTOCOL IDENTITY</span><h2>Consortium registration</h2></div></div><dl className="definition-grid"><div><dt>Organization role</dt><dd>{titleCase(organization.role)}</dd></div><div><dt>Status</dt><dd><StatusBadge value={organization.status} /></dd></div><div className="wide"><dt>Chain organization ID</dt><dd className="mono hash-full" title={organization.chain_organization_id}>{organization.chain_organization_id}</dd></div><div><dt>Last application update</dt><dd>{formatDate(organization.updated_at)}</dd></div></dl></article><article className="panel trust-panel"><span className="kicker">VISIBILITY BOUNDARY</span><h2>Identity is visible. Commercial state is not automatically shared.</h2><p>Consortium membership allows this organization profile and credential metadata to be inspected. Orders appear below only when your own RLS-scoped relationship permits them; private capacity remains factory-confidential.</p><div className="privacy-access-list"><span className="privacy-chip consortium">Consortium-visible identity</span><span className="privacy-chip shared">Relationship-scoped orders</span><span className="privacy-chip private">Private capacity protected</span></div></article></section>

    <section className="panel"><div className="panel-heading"><div><span className="kicker">VERIFIABLE CREDENTIALS</span><h2>Credentials for this organization</h2></div><span className="panel-count">{credentials?.length ?? 0}</span></div>{(credentials ?? []).length ? <div className="credential-record-grid">{(credentials ?? []).map((credential) => <article className="credential-record" key={credential.id}><div><span className="credential-type">{titleCase(credential.credential_type)}</span><StatusBadge value={credential.status} /></div><h3>{issuerMap.get(credential.issuer_organization_id) ?? "Consortium issuer"}</h3><dl><div><dt>Valid until</dt><dd>{formatDate(credential.valid_until)}</dd></div><div><dt>Credential</dt><dd className="mono">{shortHash(credential.chain_credential_id)}</dd></div><div><dt>Scope</dt><dd className="mono">{shortHash(credential.scope_hash)}</dd></div></dl></article>)}</div> : <div className="empty-state"><strong>No credential metadata is visible</strong><span>Credential issuance and status will appear here when indexed and permitted by consortium policy.</span></div>}</section>

    <section className="panel"><div className="panel-heading"><div><span className="kicker">YOUR VISIBLE RELATIONSHIPS</span><h2>Related orders</h2></div></div>{relatedOrders.length ? <div className="record-list">{relatedOrders.map((order) => <Link className="record-row" href={`/app/orders/${order.id}`} key={order.id}><div><strong>{order.title || order.external_reference}</strong><span>{order.external_reference} · updated {formatDate(order.updated_at)}</span></div><StatusBadge value={order.status} /></Link>)}</div> : <div className="empty-state"><strong>No related orders are visible to your account</strong><span>This does not mean the organization has no commercial relationships. It means none are available through your current RLS-scoped memberships.</span></div>}</section>
  </div>;
}
