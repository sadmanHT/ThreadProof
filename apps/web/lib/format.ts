export function titleCase(value: string) {
  return value
    .replace(/_/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

export function formatDate(value: string | null | undefined, options?: Intl.DateTimeFormatOptions) {
  if (!value) return "—";
  return new Intl.DateTimeFormat("en", options ?? { dateStyle: "medium" }).format(new Date(value));
}

export function shortHash(value: string | null | undefined, head = 10, tail = 6) {
  if (!value) return "—";
  if (value.length <= head + tail + 1) return value;
  return `${value.slice(0, head)}…${value.slice(-tail)}`;
}

export function formatQuantity(value: number | null | undefined, unit: string | null | undefined) {
  if (value == null) return "—";
  const quantity = new Intl.NumberFormat("en", { maximumFractionDigits: 3 }).format(value);
  return unit ? `${quantity} ${unit}` : quantity;
}
