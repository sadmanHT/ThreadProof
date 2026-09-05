"use client";

import clsx from "clsx";
import { useEffect, useState, type ButtonHTMLAttributes, type ReactNode } from "react";
import { useFormStatus } from "react-dom";

type PendingSubmitButtonProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children"> & {
  children: ReactNode;
  pendingLabel?: ReactNode;
};

export function PendingSubmitButton({
  children,
  pendingLabel = "Working…",
  className,
  disabled,
  type = "submit",
  ...props
}: PendingSubmitButtonProps) {
  const { pending } = useFormStatus();
  const busy = pending || Boolean(disabled);

  return (
    <button
      {...props}
      className={clsx(className, pending && "is-pending")}
      type={type}
      disabled={busy}
      aria-busy={pending || undefined}
    >
      {pending ? pendingLabel : children}
      {pending ? <span className="button-spinner" aria-hidden="true" /> : null}
    </button>
  );
}

type ConfirmSubmitButtonProps = PendingSubmitButtonProps & {
  confirmLabel?: ReactNode;
  confirmWindowMs?: number;
};

export function ConfirmSubmitButton({
  children,
  pendingLabel = "Deleting…",
  confirmLabel = "Confirm delete",
  confirmWindowMs = 5000,
  className,
  disabled,
  type = "submit",
  onClick,
  ...props
}: ConfirmSubmitButtonProps) {
  const { pending } = useFormStatus();
  const [confirming, setConfirming] = useState(false);

  useEffect(() => {
    if (!confirming) return;
    const timer = window.setTimeout(() => setConfirming(false), confirmWindowMs);
    return () => window.clearTimeout(timer);
  }, [confirmWindowMs, confirming]);

  return (
    <button
      {...props}
      className={clsx(className, pending && "is-pending", confirming && "is-confirming")}
      type={type}
      disabled={pending || Boolean(disabled)}
      aria-busy={pending || undefined}
      data-confirming={confirming ? "true" : undefined}
      onBlur={() => {
        if (!pending) setConfirming(false);
      }}
      onClick={(event) => {
        if (!confirming) {
          event.preventDefault();
          setConfirming(true);
          return;
        }
        onClick?.(event);
      }}
    >
      {pending ? pendingLabel : confirming ? confirmLabel : children}
      {pending ? <span className="button-spinner" aria-hidden="true" /> : null}
    </button>
  );
}
