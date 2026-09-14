import { useEffect, useState } from "react";
import { ActionButton, Banner, StatusRegion } from "./components/index.js";
import type { GatewayClient, HealthDependenciesSnapshot } from "./gateway-client.js";
import { useControlCenterIntl } from "./i18n/runtime.js";

/** Display the installed health endpoint without inventing v2 operation checkpoints. */
export function HealthControlCenter({
  client,
  onUnauthorized,
}: {
  readonly client: GatewayClient;
  readonly onUnauthorized: () => void;
}) {
  const { message } = useControlCenterIntl();
  const [revision, setRevision] = useState(0);
  const [snapshot, setSnapshot] = useState<HealthDependenciesSnapshot>();
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    void revision;
    let active = true;
    setLoading(true);
    setError(null);
    void client
      .healthDependencies()
      .then((value) => {
        if (active) setSnapshot(value);
      })
      .catch((caught: unknown) => {
        if (!active) return;
        setSnapshot(undefined);
        if (caught && typeof caught === "object" && "status" in caught && caught.status === 401)
          onUnauthorized();
        else setError(caught instanceof Error ? caught.message : "CONTROL_CENTER_REQUEST_REJECTED");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [client, onUnauthorized, revision]);
  return (
    <>
      <ActionButton
        disabled={loading}
        onClick={() => setRevision((current) => current + 1)}
        variant="secondary"
      >
        {message("common.refresh")}
      </ActionButton>
      {loading ? <StatusRegion>{message("state.loading")}</StatusRegion> : null}
      {error ? (
        <Banner title={message("error.currentUnavailable")} tone="danger">
          <code>{error}</code>
        </Banner>
      ) : null}
      {snapshot ? (
        <>
          <dl className="health-grid">
            <div>
              <dt>{message("health.service")}</dt>
              <dd>{message(snapshot.live ? "health.live" : "health.unavailable")}</dd>
            </div>
            <div>
              <dt>{message("health.admission")}</dt>
              <dd>{message(snapshot.ready ? "health.ready" : "health.notReady")}</dd>
            </div>
            <div>
              <dt>{message("health.state")}</dt>
              <dd>{snapshot.status}</dd>
            </div>
          </dl>
          <dl className="health-grid">
            {snapshot.dependencies.map((dependency) => (
              <div key={dependency.name}>
                <dt>{dependency.name}</dt>
                <dd>
                  {dependency.status}
                  {dependency.reasonCode ? ` · ${dependency.reasonCode}` : ""}
                </dd>
              </div>
            ))}
          </dl>
        </>
      ) : null}
    </>
  );
}
