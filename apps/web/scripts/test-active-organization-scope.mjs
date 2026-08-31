import { readFile } from "node:fs/promises";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

const [
  dashboard,
  orders,
  orderDetail,
  newOrder,
  capacity,
  capacityDetail,
  proofs,
  proofDetail,
  actions,
  contextRoute,
] = await Promise.all([
  read("app/app/page.tsx"),
  read("app/app/orders/page.tsx"),
  read("app/app/orders/[id]/page.tsx"),
  read("app/app/orders/new/page.tsx"),
  read("app/app/capacity/page.tsx"),
  read("app/app/capacity/[id]/page.tsx"),
  read("app/app/proofs/page.tsx"),
  read("app/app/proofs/[id]/page.tsx"),
  read("app/app/actions.ts"),
  read("app/app/context/route.ts"),
]);

function requireFragments(name, source, fragments) {
  for (const fragment of fragments) {
    if (!source.includes(fragment)) throw new Error(`${name} is missing active-organization invariant: ${fragment}`);
  }
}

requireFragments("Dashboard", dashboard, [
  "viewer.activeMembership",
  'eq("buyer_organization_id", activeOrganizationId)',
  'eq("factory_organization_id", activeOrganizationId)',
  'eq("auditor_organization_id", activeOrganizationId)',
  "Operational cards and mutations are scoped to this selected membership",
]);

requireFragments("Orders list", orders, [
  "viewer.activeMembership",
  'ordersBase.eq("buyer_organization_id", activeOrganizationId)',
  'ordersBase.eq("factory_organization_id", activeOrganizationId)',
  "active.organization.role === \"buyer\" && hasOperationalRole(active)",
]);

requireFragments("Order detail", orderDetail, [
  "buyerContext",
  "factoryContext",
  "if (!buyerContext && !factoryContext) notFound()",
  "buyerContext ? authorizationBase",
]);

requireFragments("Order creation", newOrder, [
  "viewer.activeMembership",
  "active.organization.role !== \"buyer\"",
  "buyers={[{ id: active.organization_id",
]);

requireFragments("Capacity list", capacity, [
  'openingsBase.eq("factory_organization_id", activeOrganizationId)',
  'certificationBase.eq("auditor_organization_id", activeOrganizationId)',
  "auditorMemberships = active",
]);

requireFragments("Capacity detail", capacityDetail, [
  "active.organization.role !== \"factory\"",
  'eq("factory_organization_id", active.organization_id)',
]);

requireFragments("Proof list", proofs, [
  'jobsBase.eq("factory_organization_id", activeOrganizationId)',
  'jobsBase.in("order_version_id"',
  'openingsBase.eq("factory_organization_id", activeOrganizationId)',
  "active.organization.role === \"factory\" && hasOperationalRole(active)",
]);

requireFragments("Proof detail", proofDetail, [
  "factoryContext",
  "buyerContext",
  "if (!factoryContext && !buyerContext) notFound()",
  "const { data: opening } = factoryContext",
  "Factory-confidential in buyer context",
]);

requireFragments("Server actions", actions, [
  "parsed.data.buyerOrganizationId !== active.organization_id",
  "order.buyer_organization_id !== active.organization_id",
  "opening.factory_organization_id !== active.organization_id",
  "order.factory_organization_id !== active.organization_id",
  "parsed.data.organizationId !== active.organization_id",
]);

requireFragments("Context route", contextRoute, [
  "viewer.memberships.find",
  "item.active && item.organization_id === organizationId",
  "httpOnly: true",
  'sameSite: "lax"',
]);

console.log("Active organization operational-scope regression guard passed.");
