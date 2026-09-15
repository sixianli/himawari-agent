import symbol from "../../../../assets/brand/himawari/v1/logo-symbol-light.png";

/** The approved RGB image deliberately retains its light background. */
export function HimawariBrand({ wordmark = false }: { readonly wordmark?: boolean }) {
  return (
    <span className="himawari-brand">
      <img alt="" src={symbol} width="24" height="24" />
      {wordmark ? <span>himawari</span> : null}
    </span>
  );
}
