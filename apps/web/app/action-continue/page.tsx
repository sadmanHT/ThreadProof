import { ActionContinuationClient } from "@/components/action-continuation-client";
import { safeLocalPath } from "@/lib/safe-local-path";

export const dynamic = "force-dynamic";

type PageProps = {
  searchParams: Promise<{ next?: string | string[] }>;
};

export default async function ActionContinuePage({ searchParams }: PageProps) {
  const params = await searchParams;
  const rawTarget = Array.isArray(params.next) ? params.next[0] : params.next;
  const target = safeLocalPath(rawTarget);

  return <ActionContinuationClient target={target} />;
}
