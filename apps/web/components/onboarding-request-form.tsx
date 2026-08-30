"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { createWalletClient, custom, type Address } from "viem";
import { submitOnboardingRequest } from "@/app/onboarding/actions";
import { buildFactoryOnboardingCommitments } from "@/lib/onboarding-chain";

type InjectedProvider = Parameters<typeof custom>[0];
type Stage = "idle" | "wallet" | "signing" | "submitting" | "submitted";

export function OnboardingRequestForm() {
  const router = useRouter();
  const [stage, setStage] = useState<Stage>("idle");
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setMessage(null);

    try {
      const provider = (window as Window & { ethereum?: InjectedProvider }).ethereum;
      if (!provider) throw new Error("No injected EVM wallet was found. Connect the wallet that will represent this factory on ThreadProof.");

      setStage("wallet");
      const wallet = createWalletClient({ transport: custom(provider) });
      const [selectedAccount] = await wallet.requestAddresses();
      if (!selectedAccount) throw new Error("No wallet account was selected.");
      const primaryAccount = selectedAccount as Address;

      const form = new FormData(event.currentTarget);
      const requestId = crypto.randomUUID();
      const details = {
        requestId,
        legalName: String(form.get("legalName") ?? "").trim(),
        displayName: String(form.get("displayName") ?? "").trim(),
        countryCode: String(form.get("countryCode") ?? "").trim().toUpperCase(),
        notes: String(form.get("notes") ?? "").trim(),
        primaryAccount,
      };
      const commitments = buildFactoryOnboardingCommitments(details);

      setStage("signing");
      const walletSignature = await wallet.signMessage({
        account: primaryAccount,
        message: commitments.signingMessage,
      });

      setStage("submitting");
      const result = await submitOnboardingRequest({
        requestId,
        legalName: details.legalName,
        displayName: details.displayName,
        countryCode: details.countryCode,
        notes: details.notes,
        primaryAccount,
        walletSignature,
      });
      if (!result.ok) throw new Error(result.error);

      setStage("submitted");
      setMessage("Wallet ownership verified. The request is now waiting for an auditor + industry Charter proposal and on-chain registration.");
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Unable to submit the factory onboarding request.");
      setStage("idle");
    }
  }

  const busy = stage !== "idle" && stage !== "submitted";
  const buttonLabel = stage === "wallet"
    ? "Connecting factory wallet…"
    : stage === "signing"
      ? "Sign onboarding intent…"
      : stage === "submitting"
        ? "Verifying and submitting…"
        : stage === "submitted"
          ? "Request submitted"
          : "Verify wallet and request onboarding";

  return (
    <form className="stack-form" onSubmit={submit}>
      {error ? <div className="alert alert-error">{error}</div> : null}
      {message ? <div className="alert alert-success">{message}</div> : null}
      <div className="field-grid two">
        <label>Legal name<input name="legalName" required minLength={2} maxLength={180} disabled={busy} /></label>
        <label>Display name<input name="displayName" required minLength={2} maxLength={100} disabled={busy} /></label>
      </div>
      <div className="field-grid two">
        <label>Organization role<input value="Factory" readOnly disabled /></label>
        <label>Country code<input name="countryCode" maxLength={2} placeholder="BD" disabled={busy} /></label>
      </div>
      <label>Context for reviewers<textarea name="notes" rows={4} maxLength={1000} placeholder="Describe the factory, operating scope, and evidence reviewers should consider." disabled={busy} /></label>
      <div className="callout"><strong>The connected wallet becomes the proposed on-chain primary account.</strong><span>ThreadProof asks it to sign a deterministic onboarding intent. The server recovers that signature before staging the request; the Charter still needs both auditor and industry approval before Registry registration can occur.</span></div>
      <button className="button primary" type="submit" disabled={busy || stage === "submitted"}>{buttonLabel}</button>
    </form>
  );
}
